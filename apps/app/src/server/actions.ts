// Walkthrough decisions, per-finding Q&A, posting, status/approve, re-review and stats.
// Everything that writes to GitHub is only reachable from an explicit user click.
import type { PrStatus, ReviewEvent, Severity, Stats } from "../shared/types";
import { parseDiff, validateAnchor } from "./anchors";
import { runAgent } from "./agents";
import { getSettings } from "./settings";
import { db } from "./db/db";
import { releaseWorktree } from "./cleanup";
import { ensureWorktree, readOnlyTools, startDeepReview } from "./deep";
import { approvePr, postReview, prDiff, prStatus, prView, viewer, type ReviewPayload } from "./gh";
import { emit } from "./live";
import { PR_QA_SCHEMA, prQaPrompt, QA_SCHEMA, qaPrompt, type PrQaOutput, type QaOutput } from "./prompts/qa";
import { getReview, getRow, insertReview, refOf, saveStack, setPhase, trackedRun } from "./reviews";

interface FindingRow {
  id: number;
  review_id: number;
  severity: Severity;
  title: string;
  path: string | null;
  line: number | null;
  start_line: number | null;
  side: "RIGHT" | "LEFT" | null;
  comment: string;
  anchorable: number;
  decision: string | null;
  qa_session_id: string | null;
  posted: number;
  soft: number;
}

function findingRow(id: number): FindingRow {
  const f = db.query("SELECT * FROM findings WHERE id = ?").get(id) as FindingRow | null;
  if (!f) throw new Error("Finding not found");
  return f;
}

function assertEditable(reviewId: number) {
  const row = getRow(reviewId);
  if (!row) throw new Error("Review not found");
  if (row.phase === "submitted") throw new Error("This review has already been posted.");
  return row;
}

// ---------- walkthrough ----------

export function decide(findingId: number, decision: "accepted" | "dismissed" | null, reason?: string | null) {
  const f = findingRow(findingId);
  assertEditable(f.review_id);
  db.run("UPDATE findings SET decision = ?, dismiss_reason = ?, decided_at = datetime('now') WHERE id = ?", [
    decision,
    decision === "dismissed" ? (reason?.trim() || null) : null,
    findingId,
  ]);
  emit({ type: "finding", reviewId: f.review_id, findingId });
}

export function editComment(findingId: number, comment: string) {
  const f = findingRow(findingId);
  assertEditable(f.review_id);
  if (!comment.trim()) throw new Error("Comment can't be empty");
  db.run("UPDATE findings SET comment = ? WHERE id = ?", [comment, findingId]);
  emit({ type: "finding", reviewId: f.review_id, findingId });
}

const asking = new Set<number>();

/**
 * Asks Claude about one finding. The first question forks the deep-review session (so Claude has
 * the full review context); follow-ups continue that fork. Findings don't see each other's Q&A.
 */
export async function ask(findingId: number, question: string) {
  if (!question.trim()) throw new Error("Ask a question first");
  if (asking.has(findingId)) throw new Error("Already answering a question about this finding");
  const f = findingRow(findingId);
  const row = assertEditable(f.review_id);
  if (!row.review_session_id) throw new Error("No review session to ask about");
  const worktree = await ensureWorktree(row);

  const review = await getReview(row.id);
  const finding = review!.findings.find((x) => x.id === findingId)!;
  const first = !f.qa_session_id;
  db.run("INSERT INTO finding_messages (finding_id, role, content) VALUES (?, 'user', ?)", [findingId, question.trim()]);
  emit({ type: "finding", reviewId: row.id, findingId });

  asking.add(findingId);
  const { models, effort } = getSettings();
  try {
    const res = await trackedRun<QaOutput>(
      row.id,
      "qa",
      models.qa,
      (logName, onProgress) =>
        runAgent({
          prompt: qaPrompt(finding, question.trim(), first),
          cwd: worktree,
          model: models.qa,
          effort: effort.qa,
          ...readOnlyTools(worktree),
          resume: f.qa_session_id ?? row.review_session_id!,
          forkSession: first,
          jsonSchema: QA_SCHEMA,
          maxTurns: 60,
          logName,
          onProgress,
        }),
      { stripPrefix: worktree },
    );
    if (res.isError || !res.structured) throw new Error(res.error ?? "No answer");
    const out = res.structured;

    const rec = { accept: "✓ Recommend posting it.", dismiss: "✗ Recommend dismissing it.", unsure: "? Your call." }[out.recommendation];
    const revisedNote = out.revised ? "\n\n_I've updated the finding to match._" : "";
    db.transaction(() => {
      db.run("INSERT INTO finding_messages (finding_id, role, content) VALUES (?, 'assistant', ?)", [findingId, `${out.answer}\n\n**${rec}**${revisedNote}`]);
      if (res.sessionId) db.run("UPDATE findings SET qa_session_id = ? WHERE id = ?", [res.sessionId, findingId]);
      if (out.revised) {
        const r = out.revised;
        const a = validateAnchor(parseDiff(row.diff_text ?? ""), { path: f.path, line: r.line ?? f.line, startLine: r.startLine, side: f.side });
        // Line may have moved: drop the captured snippet so it's re-read from the checkout.
        db.run(
          `UPDATE findings SET severity = ?, title = ?, why = ?, fix = ?, comment = ?, line = ?, start_line = ?, side = ?, anchorable = ?, file_snippet_json = NULL WHERE id = ?`,
          [r.severity, r.title, r.why, r.fix, r.comment, a.line, a.startLine, a.side, a.anchorable ? 1 : 0, findingId],
        );
      }
    })();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.run("INSERT INTO finding_messages (finding_id, role, content) VALUES (?, 'assistant', ?)", [findingId, `_Couldn't answer: ${msg}_`]);
    throw e;
  } finally {
    asking.delete(findingId);
    emit({ type: "finding", reviewId: row.id, findingId });
  }
}

const askingPr = new Set<number>();

/**
 * "Ask Claude about this PR" from the overview. Runs read-only in the PR checkout (created if
 * needed, without starting the deep review) in a session of its own; follow-ups continue it.
 */
export async function askPr(reviewId: number, question: string) {
  const q = question.trim();
  if (!q) throw new Error("Ask a question first");
  if (askingPr.has(reviewId)) throw new Error("Already answering a question about this PR");
  const row = getRow(reviewId);
  if (!row) throw new Error("Review not found");
  askingPr.add(reviewId);
  db.run("INSERT INTO review_messages (review_id, role, content) VALUES (?, 'user', ?)", [reviewId, q]);
  emit({ type: "chat", reviewId });

  const { models, effort } = getSettings();
  try {
    const worktree = await ensureWorktree(row);
    const fresh = getRow(reviewId)!;
    const recon = fresh.recon_json ? JSON.parse(fresh.recon_json) : null;
    const first = !fresh.pr_qa_session_id;
    const res = await trackedRun<PrQaOutput>(
      reviewId,
      "qa",
      models.qa,
      (logName, onProgress) =>
        runAgent({
          prompt: prQaPrompt(
            {
              repo: `${row.owner}/${row.repo}`, number: row.pr_number, title: row.title, author: row.author, headRef: row.head_ref,
              baseRef: row.base_ref, mergeBase: fresh.merge_base, headline: recon?.headline ?? null, summary: recon?.summary ?? null,
            },
            q,
            first,
          ),
          cwd: worktree,
          model: models.qa,
          effort: effort.qa,
          ...readOnlyTools(worktree),
          resume: fresh.pr_qa_session_id ?? undefined,
          jsonSchema: PR_QA_SCHEMA,
          maxTurns: 60,
          logName,
          onProgress,
        }),
      { stripPrefix: worktree, maxTurns: 60 },
    );
    if (res.isError || !res.structured) throw new Error(res.error ?? "No answer");
    db.transaction(() => {
      db.run("INSERT INTO review_messages (review_id, role, content) VALUES (?, 'assistant', ?)", [reviewId, res.structured!.answer]);
      if (res.sessionId) db.run("UPDATE reviews SET pr_qa_session_id = ? WHERE id = ?", [res.sessionId, reviewId]);
    })();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.run("INSERT INTO review_messages (review_id, role, content) VALUES (?, 'assistant', ?)", [reviewId, `_Couldn't answer: ${msg}_`]);
    throw e;
  } finally {
    askingPr.delete(reviewId);
    emit({ type: "chat", reviewId });
  }
}

// ---------- submit ----------

const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export interface Submission {
  comments: Array<{ findingId: number; path: string; line: number; startLine: number | null; side: "RIGHT" | "LEFT"; body: string }>;
  body: string;
  undecided: number;
  suggestedEvent: ReviewEvent;
}

/** What would be posted: accepted findings inline where possible, the rest folded into the body. */
export function buildSubmission(reviewId: number): Submission {
  const row = getRow(reviewId);
  if (!row) throw new Error("Review not found");
  const findings = db
    .query("SELECT * FROM findings WHERE review_id = ? AND superseded_by IS NULL ORDER BY position")
    .all(reviewId) as FindingRow[];
  const accepted = findings.filter((f) => f.decision === "accepted");
  const inline = accepted.filter((f) => f.anchorable && f.path && f.line && f.side);
  const general = accepted.filter((f) => !inline.includes(f));

  const comments = inline.map((f) => ({
    findingId: f.id,
    path: f.path!,
    line: f.line!,
    startLine: f.start_line,
    side: f.side!,
    body: `**[${f.soft ? "Heads-up" : SEVERITY_LABEL[f.severity]}]** ${f.comment}`,
  }));

  let body = row.review_summary?.trim() ?? "";
  if (general.length) {
    const items = general.map((f) => {
      const where = f.path ? ` (\`${f.path}${f.line ? `:${f.line}` : ""}\`)` : "";
      return `- **[${SEVERITY_LABEL[f.severity]}] ${f.title}**${where}\n  ${f.comment.replace(/\n/g, "\n  ")}`;
    });
    body += `${body ? "\n\n" : ""}### Other notes\n${items.join("\n")}`;
  }

  // A heads-up (soft) comment is posted but never asks for changes on its own.
  const worst = accepted.filter((f) => !f.soft).map((f) => f.severity);
  const suggestedEvent: ReviewEvent = worst.some((s) => s === "critical" || s === "high")
    ? "REQUEST_CHANGES"
    : accepted.length === 0 && row.phase !== "submitted"
      ? "APPROVE"
      : "COMMENT";

  return { comments, body, undecided: findings.filter((f) => !f.decision).length, suggestedEvent };
}

export async function submit(reviewId: number, input: { event: ReviewEvent; body: string }) {
  const row = assertEditable(reviewId);
  const sub = buildSubmission(reviewId);
  const body = input.body.trim();
  if (!["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(input.event)) throw new Error("Invalid review type");
  if (input.event !== "APPROVE" && !body && sub.comments.length === 0) throw new Error("Nothing to post: add a summary or accept at least one finding.");
  if (input.event === "REQUEST_CHANGES" && !body) throw new Error("Requesting changes needs a summary.");

  const payload: ReviewPayload = {
    commit_id: row.head_sha,
    body,
    event: input.event,
    comments: sub.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      ...(c.startLine != null ? { start_line: c.startLine, start_side: c.side } : {}),
      body: c.body,
    })),
  };
  const posted = await postReview(refOf(row), payload);

  db.transaction(() => {
    db.run(
      `UPDATE reviews SET gh_review_id = ?, posted_event = ?, posted_body = ?, submitted_at = datetime('now') WHERE id = ?`,
      [posted.id, input.event, body, reviewId],
    );
    for (const c of sub.comments) db.run("UPDATE findings SET posted = 1 WHERE id = ?", [c.findingId]);
  })();
  setPhase(reviewId, "submitted");
  releaseWorktree(row).catch(() => {});
  return { url: posted.html_url };
}

// ---------- status / approve ----------

export async function status(reviewId: number): Promise<PrStatus> {
  const row = getRow(reviewId);
  if (!row) throw new Error("Review not found");
  const [s, me] = await Promise.all([prStatus(refOf(row)), viewer().catch(() => "")]);
  return {
    state: s.state,
    isDraft: s.isDraft,
    headSha: s.headRefOid,
    reviewDecision: s.reviewDecision,
    mergeable: s.mergeable,
    mergeStateStatus: s.mergeStateStatus,
    checks: s.checks,
    reviews: s.reviews,
    viewer: me,
    newCommitsSinceReview: s.headRefOid !== row.head_sha,
  };
}

export async function approve(reviewId: number, body?: string) {
  const row = getRow(reviewId);
  if (!row) throw new Error("Review not found");
  await approvePr(refOf(row), body);
}

// ---------- re-review ----------

/** New review of the PR's latest commit that knows about this one's findings. */
export async function startRereview(reviewId: number): Promise<number> {
  const prev = getRow(reviewId);
  if (!prev) throw new Error("Review not found");
  const ref = refOf(prev);
  const pr = await prView(ref);
  if (pr.headRefOid === prev.head_sha) throw new Error("No new commits since this review.");

  const id = insertReview(ref, pr, "read", prev.id);
  const diff = await prDiff(ref);
  db.run("UPDATE reviews SET recon_json = ?, diff_text = ?, read_at = datetime('now') WHERE id = ?", [prev.recon_json, diff, id]);
  await saveStack(id, ref, pr);
  startDeepReview(id);
  return id;
}

// ---------- history ----------

export function stats(): Stats {
  const one = <T>(sql: string) => db.query(sql).get() as T;
  const counts = one<{ reviews: number; submitted: number }>(
    "SELECT COUNT(*) AS reviews, COALESCE(SUM(phase = 'submitted'), 0) AS submitted FROM reviews",
  );
  const f = one<{ findings: number; accepted: number; dismissed: number }>(
    `SELECT COUNT(*) AS findings, COALESCE(SUM(decision = 'accepted'), 0) AS accepted, COALESCE(SUM(decision = 'dismissed'), 0) AS dismissed FROM findings`,
  );
  const bucket = (col: string) =>
    db
      .query(
        `SELECT COALESCE(${col}, 'other') AS key, COUNT(*) AS total, COALESCE(SUM(decision = 'accepted'), 0) AS accepted,
                COALESCE(SUM(decision = 'dismissed'), 0) AS dismissed
         FROM findings GROUP BY 1 ORDER BY total DESC LIMIT 12`,
      )
      .all() as Stats["bySeverity"];
  const runs = one<{ cost: number; ms: number }>("SELECT COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(duration_ms), 0) AS ms FROM claude_runs");
  const recentDismissals = db
    .query(
      `SELECT f.title, f.lens, f.dismiss_reason AS reason, r.owner || '/' || r.name AS repo, v.pr_number AS prNumber
       FROM findings f JOIN reviews v ON v.id = f.review_id JOIN repos r ON r.id = v.repo_id
       WHERE f.decision = 'dismissed' ORDER BY f.decided_at DESC, f.id DESC LIMIT 12`,
    )
    .all() as Stats["recentDismissals"];
  const sevOrder = ["critical", "high", "medium", "low"];
  return {
    ...counts,
    ...f,
    bySeverity: bucket("severity").sort((a, b) => sevOrder.indexOf(a.key) - sevOrder.indexOf(b.key)),
    byLens: bucket("lens"),
    recentDismissals,
    estCostUsd: runs.cost,
    claudeMinutes: Math.round(runs.ms / 60000),
  };
}
