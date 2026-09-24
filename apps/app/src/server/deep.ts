// The in-depth review: check out the PR, run Claude (Opus) read-only inside it with the repo's
// review criteria + stack context, then store validated findings for the walkthrough.
import type { PriorStatus } from "../shared/types";
import { parseDiff, snippetFromDiff, snippetFromFile, validateAnchor } from "./anchors";
import { agentName, runAgent } from "./agents";
import { getSettings } from "./settings";
import { db } from "./db/db";
import { existsSync } from "node:fs";
import { clonePath, commitLog, diffBetween, diffWithStats, prepareSelfWorktree, prepareWorktree, readLines, worktreeAt } from "./git";
import { readReviewSkill } from "./skills";
import { prDiff, prView } from "./gh";
import { emit } from "./live";
import {
  GENERIC_LENSES,
  REVIEW_SCHEMA,
  reviewPrompt,
  reviewSystem,
  SELF_REVIEW_SCHEMA,
  selfReviewPrompt,
  selfReviewSystem,
  stackContext,
  type ReviewOutput,
  type SelfReviewOutput,
} from "./prompts/review";
import type { ClaudeResult } from "./claude";
import { CONTINUE_PROMPT, getRow, isLocalSelf, refOf, saveStack, setPhase, trackedRun, turnLimitMessage, type ReviewRow } from "./reviews";

const REVIEW_DIFF_CHAR_LIMIT = 150_000;
const DELTA_CHAR_LIMIT = 80_000;
const running = new Map<number, AbortController>();

/** Read-only toolset scoped to one checkout. `dontAsk` denies anything not listed here. */
export function readOnlyTools(worktree: string) {
  return {
    tools: ["Read", "Grep", "Glob", "Bash"],
    permissionMode: "dontAsk" as const,
    allowedTools: [
      `Read(/${worktree}/**)`, // leading "//" = absolute path in permission rules
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "Bash(git blame:*)",
      "Bash(git status:*)",
      "Bash(git ls-files:*)",
      "Bash(gh pr view:*)",
      "Bash(gh pr diff:*)",
    ],
  };
}

/**
 * Returns a checkout for the review, recreating it if cleanup removed it. It's rebuilt at the same
 * path, which matters: Claude sessions are keyed by working directory, so `--resume` still works.
 */
export async function ensureWorktree(row: ReviewRow): Promise<string> {
  if (row.worktree_path && existsSync(row.worktree_path)) return row.worktree_path;
  if (isLocalSelf(row)) {
    // The snapshot commit lives in our clone, so the checkout can be rebuilt without the user's repo.
    const path = await worktreeAt({ reviewId: row.id, owner: row.owner, repo: row.repo, sha: row.head_sha });
    db.run("UPDATE reviews SET worktree_path = ? WHERE id = ?", [path, row.id]);
    return path;
  }
  const wt = await prepareWorktree(
    { reviewId: row.id, owner: row.owner, repo: row.repo, prNumber: row.pr_number, headSha: row.head_sha, baseRef: row.base_ref },
    () => {},
  );
  db.run("UPDATE reviews SET worktree_path = ?, merge_base = ? WHERE id = ?", [wt.path, wt.mergeBase, row.id]);
  return wt.path;
}

export function isReviewRunning(id: number) {
  return running.has(id);
}

export function cancelDeepReview(id: number) {
  running.get(id)?.abort();
}

/** Starts the deep review in the background. No-op if one is already running for this review. */
export function startDeepReview(id: number) {
  inBackground(id, (row, signal) => runDeepReview(row, signal));
}

/** Resumes a deep review that ran out of turns, in the same Claude session, with `turns` more. */
export function continueDeepReview(id: number, sessionId: string, turns: number) {
  inBackground(id, async (row, signal) => {
    const wt = await ensureWorktree(row);
    const settings = getSettings();
    const diffText = row.diff_text ?? (await prDiff(refOf(row)));
    emit({ type: "progress", reviewId: id, runKind: "review", text: `Continuing the review with ${turns} more turns`, at: Date.now() });
    const res = await trackedRun<ReviewOutput>(
      id,
      "review",
      settings.models.review,
      (logName, onProgress) =>
        runAgent({
          prompt: CONTINUE_PROMPT,
          resume: sessionId,
          cwd: wt,
          model: settings.models.review,
          effort: settings.effort.review,
          ...readOnlyTools(wt),
          jsonSchema: REVIEW_SCHEMA,
          appendSystemPrompt: reviewSystem(wt),
          maxTurns: turns,
          logName,
          onProgress,
          signal,
        }),
      { stripPrefix: wt, maxTurns: turns },
    );
    const parent = row.parent_review_id ? getRow(row.parent_review_id) : null;
    await finishReview(id, res, turns, signal, diffText, parent, wt);
  });
}

function inBackground(id: number, work: (row: ReviewRow, signal: AbortSignal) => Promise<void>) {
  if (running.has(id)) return;
  const row = getRow(id);
  if (!row) throw new Error("Not found");
  const ctrl = new AbortController();
  running.set(id, ctrl);
  setPhase(id, "reviewing");
  work(row, ctrl.signal)
    .catch((e) => setPhase(id, "failed", ctrl.signal.aborted ? "Deep review cancelled." : e instanceof Error ? e.message : String(e)))
    .finally(() => running.delete(id));
}

async function finishReview(
  id: number,
  res: ClaudeResult<ReviewOutput>,
  maxTurns: number,
  signal: AbortSignal,
  diffText: string,
  parent: ReviewRow | null,
  worktree: string,
) {
  if (signal.aborted) throw new Error("Cancelled");
  if (res.denials.length) emit({ type: "progress", reviewId: id, runKind: "review", text: `${res.denials.length} tool call(s) were blocked by the read-only sandbox`, at: Date.now() });
  if (res.hitTurnLimit) throw new Error(turnLimitMessage("review", maxTurns));
  if (res.isError || !res.structured) throw new Error(res.error ?? "The review returned nothing");
  await saveFindings(id, diffText, res.structured, res.sessionId, parent, worktree);
  setPhase(id, "walkthrough");
}

async function runDeepReview(row: ReviewRow, signal: AbortSignal) {
  const id = row.id;
  const ref = refOf(row);
  const self = row.mode === "self";
  const local = isLocalSelf(row);
  const progress = (text: string) => emit({ type: "progress", reviewId: id, runKind: "review", text, at: Date.now() });

  // Reuse a checkout made for "Ask Claude about this PR" (or a self-review's snapshot), so a
  // question in flight keeps its files.
  const wt =
    row.worktree_path && row.merge_base && existsSync(row.worktree_path)
      ? { path: row.worktree_path, mergeBase: row.merge_base }
      : local
        ? { path: await ensureWorktree(row), mergeBase: row.merge_base! }
        : await prepareWorktree(
            { reviewId: id, owner: row.owner, repo: row.repo, prNumber: row.pr_number, headSha: row.head_sha, baseRef: row.base_ref },
            progress,
          );
  db.run("UPDATE reviews SET worktree_path = ?, merge_base = ? WHERE id = ?", [wt.path, wt.mergeBase, id]);
  if (signal.aborted) throw new Error("Cancelled");

  const res = await reviewRun(row, wt, signal, progress);
  const parent = row.parent_review_id ? getRow(row.parent_review_id) : null;
  await finishReview(id, res.res, res.maxTurns, signal, res.diffText, parent, wt.path);
}

/** Builds the prompt for a peer or self review and runs Claude. Shared by first runs and self re-runs. */
async function reviewRun(
  row: ReviewRow,
  wt: { path: string; mergeBase: string },
  signal: AbortSignal,
  progress: (text: string) => void,
  rerun?: Parameters<typeof selfReviewPrompt>[0]["rerun"],
): Promise<{ res: ClaudeResult<ReviewOutput | SelfReviewOutput>; maxTurns: number; diffText: string }> {
  const id = row.id;
  const ref = refOf(row);
  const self = row.mode === "self";
  const local = isLocalSelf(row);

  // Criteria: the repo's own review skill (from the default branch), else a generic set.
  const found = await readReviewSkill(clonePath(row.owner, row.repo), row.owner, row.repo);
  const skill = found && "text" in found ? found : null;
  progress(
    skill
      ? `Using ${skill.path} as review criteria`
      : found
        ? `Review skill ${found.path} isn't on the default branch any more; using generic criteria`
        : "No review skill for this repo; using generic criteria",
  );

  // Stack neighbours: descriptions + file lists for nearby PRs (Claude can gh-diff any of them).
  const pr = local ? null : await prView(ref);
  const stack = local
    ? []
    : (db.query("SELECT COUNT(*) AS n FROM stack_links WHERE review_id = ?").get(id) as { n: number }).n
      ? (db
          .query("SELECT pr_number AS number, title, head_ref AS headRef, base_ref AS baseRef, relation, depth FROM stack_links WHERE review_id = ?")
          .all(id) as any[])
      : await saveStack(id, ref, pr!);
  const settings = getSettings();
  const near = stack.filter((s) => s.depth <= settings.stackContextDepth).slice(0, settings.stackContextDepth * 3);
  const details = new Map(
    (await Promise.all(near.map((s) => prView({ ...ref, number: s.number }).catch(() => null))))
      .filter((p): p is NonNullable<typeof p> => p != null)
      .map((p) => [p.number, { body: p.body, files: p.files }]),
  );
  if (stack.length) progress(`Loaded context for ${details.size} neighbouring PRs in the stack`);

  const diffText = row.diff_text ?? (await prDiff(ref));
  if (!row.diff_text) db.run("UPDATE reviews SET diff_text = ? WHERE id = ?", [diffText, id]);

  // What this reviewer has rejected before in this repo.
  const dismissals = settings.dismissalMemory
    ? (db
        .query(
          `SELECT f.title, f.lens, f.dismiss_reason AS reason FROM findings f JOIN reviews v ON v.id = f.review_id
           WHERE v.repo_id = ? AND f.decision = 'dismissed' AND v.id != ? AND v.mode = ? ORDER BY f.decided_at DESC, f.id DESC LIMIT ?`,
        )
        .all(row.repo_id, id, row.mode, settings.dismissalMemoryLimit) as Array<{ title: string; lens: string | null; reason: string | null }>)
    : [];

  // Re-review: diff since the previous review + its findings.
  let rereview: Parameters<typeof reviewPrompt>[0]["rereview"];
  const parent = row.parent_review_id ? getRow(row.parent_review_id) : null;
  if (parent) {
    const delta = await diffBetween(wt.path, parent.head_sha, row.head_sha).catch(() => "(couldn't compute — the old commit may have been force-pushed away; review the full diff)");
    const prior = db
      .query("SELECT id, severity, title, path, line, decision, comment FROM findings WHERE review_id = ? ORDER BY position")
      .all(parent.id) as any[];
    rereview = { fromSha: parent.head_sha, delta: delta.length > DELTA_CHAR_LIMIT ? delta.slice(0, DELTA_CHAR_LIMIT) + "\n… (truncated)" : delta, prior };
    progress(`Re-review: ${prior.length} prior findings to re-check`);
  }

  const commits = self ? await commitLog(wt.path, wt.mergeBase).catch(() => []) : [];
  const diffTruncated = diffText.length > REVIEW_DIFF_CHAR_LIMIT;
  const base = {
    repo: `${row.owner}/${row.repo}`,
    pr: {
      number: row.pr_number,
      title: row.title,
      body: pr?.body ?? commits.map((c) => `- ${c}`).join("\n"),
      author: row.author,
      headRef: row.head_ref,
      baseRef: row.base_ref,
      headSha: row.head_sha,
    },
    mergeBase: wt.mergeBase,
    recon: row.recon_json ? JSON.parse(row.recon_json) : null,
    files: row.files_json ? JSON.parse(row.files_json) : [],
    stack,
    stackContext: stackContext(stack, details),
    lenses: skill?.text ?? GENERIC_LENSES,
    lensesSource: skill
      ? `# Review criteria — from ${row.owner}/${row.repo}'s ${skill.path} (default branch). Use for WHAT to look for; ignore its output/posting instructions.`
      : "",
    dismissals,
    diff: diffTruncated ? diffText.slice(0, REVIEW_DIFF_CHAR_LIMIT) : diffText,
    diffTruncated,
    rereview,
  };
  const prompt = self ? selfReviewPrompt({ ...base, commits, dirtyFiles: row.dirty_files, rerun }) : reviewPrompt(base);

  progress(rerun ? `Re-running the review against your working tree (run ${rerun.run})` : `${agentName()} is reviewing (this can take several minutes)`);
  const res = await trackedRun<ReviewOutput | SelfReviewOutput>(
    id,
    "review",
    settings.models.review,
    (logName, onProgress) =>
      runAgent({
        prompt,
        cwd: wt.path,
        model: settings.models.review,
        effort: settings.effort.review,
        ...readOnlyTools(wt.path),
        jsonSchema: self ? SELF_REVIEW_SCHEMA : REVIEW_SCHEMA,
        appendSystemPrompt: self ? selfReviewSystem(wt.path) : reviewSystem(wt.path),
        maxTurns: settings.reviewMaxTurns,
        logName,
        onProgress,
        signal,
      }),
    { stripPrefix: wt.path, maxTurns: settings.reviewMaxTurns },
  );
  return { res, maxTurns: settings.reviewMaxTurns, diffText };
}

/**
 * Self-review re-run, in place: snapshots the branch (and working tree) again, asks Claude
 * whether each open finding is fixed, and adds any new ones. Won't-fix decisions carry over.
 */
export function rerunSelfReview(id: number) {
  const row = getRow(id);
  if (!row) throw new Error("Not found");
  if (row.mode !== "self") throw new Error("Only self-reviews can be re-run in place. Use Re-review for a PR.");
  if (row.phase !== "walkthrough" && row.phase !== "failed") throw new Error("Wait for the current run to finish first.");
  inBackground(id, async (r, signal) => {
    const progress = (text: string) => emit({ type: "progress", reviewId: id, runKind: "review", text, at: Date.now() });
    const run = r.run_number + 1;
    let wt: { path: string; mergeBase: string };
    if (isLocalSelf(r)) {
      if (!r.local_path || !existsSync(r.local_path)) throw new Error(`Your checkout at ${r.local_path} isn't there any more.`);
      const snap = await prepareSelfWorktree(
        { reviewId: id, owner: r.owner, repo: r.repo, localPath: r.local_path, branch: r.head_ref, base: r.base_ref, includeDirty: Boolean(r.include_dirty) },
        progress,
      );
      const { diff, files } = await diffWithStats(snap.path, snap.mergeBase);
      db.run(
        `UPDATE reviews SET head_sha = ?, merge_base = ?, worktree_path = ?, diff_text = ?, files_json = ?, dirty_files = ?,
                additions = ?, deletions = ?, changed_files = ? WHERE id = ?`,
        [snap.headSha, snap.mergeBase, snap.path, diff, JSON.stringify(files), snap.dirtyFiles,
         files.reduce((n, f) => n + f.additions, 0), files.reduce((n, f) => n + f.deletions, 0), files.length, id],
      );
      wt = { path: snap.path, mergeBase: snap.mergeBase };
    } else {
      const pr = await prView(refOf(r));
      const w = await prepareWorktree({ reviewId: id, owner: r.owner, repo: r.repo, prNumber: r.pr_number, headSha: pr.headRefOid, baseRef: r.base_ref }, progress);
      const diff = await prDiff(refOf(r));
      db.run("UPDATE reviews SET head_sha = ?, merge_base = ?, worktree_path = ?, diff_text = ?, files_json = ?, additions = ?, deletions = ?, changed_files = ? WHERE id = ?", [
        pr.headRefOid, w.mergeBase, w.path, diff, JSON.stringify(pr.files), pr.additions, pr.deletions, pr.changedFiles, id,
      ]);
      wt = { path: w.path, mergeBase: w.mergeBase };
    }
    // Everything not already resolved or set aside gets re-checked.
    const prior = db
      .query(
        `SELECT id, severity, title, path, line, decision, agent_prompt AS prompt FROM findings
         WHERE review_id = ? AND resolved_run IS NULL AND COALESCE(decision, '') != 'dismissed' ORDER BY position`,
      )
      .all(id) as Array<{ id: number; severity: string; title: string; path: string | null; line: number | null; decision: string | null; prompt: string | null }>;
    const settled = (
      db
        .query(
          `SELECT title, decision, dismiss_reason AS reason, resolved_run AS resolvedRun FROM findings
           WHERE review_id = ? AND (resolved_run IS NOT NULL OR decision = 'dismissed') ORDER BY position`,
        )
        .all(id) as Array<{ title: string; decision: string | null; reason: string | null; resolvedRun: number | null }>
    ).map((f) => ({
      title: f.title,
      note: f.resolvedRun != null ? `fixed in run ${f.resolvedRun}` : `author won't fix${f.reason ? ` (${f.reason})` : ""}`,
    }));
    const res = await reviewRun(getRow(id)!, wt, signal, progress, { run, prior, settled });
    if (signal.aborted) throw new Error("Cancelled");
    if (res.res.hitTurnLimit) throw new Error(turnLimitMessage("review", res.maxTurns));
    if (res.res.isError || !res.res.structured) throw new Error(res.res.error ?? "The re-run returned nothing");
    const out = res.res.structured;
    const ids = new Set(prior.map((p) => p.id));
    db.transaction(() => {
      for (const p of out.priorStatus ?? []) {
        if (!ids.has(p.findingId)) continue;
        if (p.status === "addressed") db.run("UPDATE findings SET resolved_run = ?, still_open_run = NULL, still_note = NULL WHERE id = ?", [run, p.findingId]);
        else db.run("UPDATE findings SET still_open_run = ?, still_note = ? WHERE id = ?", [run, p.note, p.findingId]);
      }
      db.run("UPDATE reviews SET run_number = ?, verdict = ?, review_summary = ?, coverage = ? WHERE id = ?", [run, out.verdict, out.summary, out.coverage, id]);
    })();
    await insertFindings(id, res.diffText, out.findings, wt.path, { append: true });
    setPhase(id, "walkthrough");
  });
}

async function saveFindings(id: number, diffText: string, out: ReviewOutput, sessionId: string | null, parent: ReviewRow | null, worktree: string) {
  let priorStatus: PriorStatus[] = [];
  if (parent && out.priorStatus?.length) {
    const titles = new Map(
      (db.query("SELECT id, title FROM findings WHERE review_id = ?").all(parent.id) as Array<{ id: number; title: string }>).map((f) => [f.id, f.title]),
    );
    priorStatus = out.priorStatus.filter((p) => titles.has(p.findingId)).map((p) => ({ ...p, title: titles.get(p.findingId)! }));
  }
  await insertFindings(id, diffText, out.findings, worktree, { append: false });
  db.run("UPDATE reviews SET verdict = ?, review_summary = ?, coverage = ?, review_session_id = ?, prior_status_json = ? WHERE id = ?", [
    out.verdict,
    out.summary,
    out.coverage,
    sessionId,
    JSON.stringify(priorStatus),
    id,
  ]);
}

/**
 * Stores findings with validated anchors. Code outside the diff is captured now so it survives
 * cleanup. `append` keeps existing findings (self-review re-runs add to the list).
 */
async function insertFindings(
  id: number,
  diffText: string,
  findings: Array<ReviewOutput["findings"][number] & { prompt?: string }>,
  worktree: string,
  opts: { append: boolean },
) {
  const files = parseDiff(diffText);
  const insert = db.prepare(
    `INSERT INTO findings (review_id, position, severity, lens, title, path, line, start_line, side, why, fix, comment, confidence, anchorable, file_snippet_json, agent_prompt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const prepared = await Promise.all(
    findings.map(async (f) => {
      const a = validateAnchor(files, { path: f.path, line: f.line, startLine: f.startLine, side: f.side });
      let fileSnippet: string | null = null;
      if (!snippetFromDiff(files, a) && a.path && a.line) {
        const from = Math.max(1, (a.startLine ?? a.line) - 4);
        const lines = await readLines(worktree, a.path, from, a.line + 4);
        if (lines) fileSnippet = JSON.stringify(snippetFromFile(lines, from, { from: a.startLine ?? a.line, to: a.line }));
      }
      return { f, a, fileSnippet };
    }),
  );
  const start = opts.append
    ? ((db.query("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM findings WHERE review_id = ?").get(id) as { n: number }).n)
    : 0;
  db.transaction(() => {
    if (!opts.append) db.run("DELETE FROM findings WHERE review_id = ?", [id]);
    prepared.forEach(({ f, a, fileSnippet }, i) => {
      insert.run(id, start + i, f.severity, f.lens, f.title, a.path, a.line, a.startLine, a.side, f.why, f.fix, f.comment, f.confidence, a.anchorable ? 1 : 0, fileSnippet, f.prompt ?? null);
    });
  })();
}
