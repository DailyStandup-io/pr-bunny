import type {
  ActiveRun,
  ClaudeRun,
  Finding,
  FindingMessage,
  Phase,
  PriorStatus,
  PrFile,
  Recon,
  ReviewDetail,
  ReviewerQuestion,
  ReviewMode,
  ReviewSummary,
  StackPr,
  TurnLimitStop,
} from "../shared/types";
import { parseDiff, snippetFromDiff, snippetFromFile } from "./anchors";
import { groupAreas, heuristicMinutes } from "./areas";
import { runAgent } from "./agents";
import type { ClaudeResult } from "./claude";
import { DATA_DIR, RECON_DIFF_CHAR_LIMIT } from "./config";
import { getSettings } from "./settings";
import { db } from "./db/db";
import { readLines } from "./git";
import { listOpenPrs, parsePrRef, prDiff, prView, viewer, type PrRef } from "./gh";
import { emit, recentProgress } from "./live";
import { RECON_SCHEMA, RECON_SELF_SCHEMA, RECON_SELF_SYSTEM, RECON_SYSTEM, reconPrompt } from "./prompts/recon";
import { findStack } from "./stack";

// ---------- persistence ----------

/**
 * Runs live in this process, so anything still "running" at startup was cut off by a restart
 * (launchd restarts on crash and at login). Mark it failed so the UI doesn't spin forever.
 */
export function recoverInterrupted() {
  const msg = "Interrupted: the server restarted while this was running.";
  db.run("UPDATE claude_runs SET status = 'error', error = ? WHERE status = 'running'", [msg]);
  db.run("UPDATE reviews SET phase = 'failed', error = ? WHERE phase IN ('recon_running', 'reviewing')", [`${msg} Retry to run it again.`]);
  // "read" is only ever momentary (the deep review starts right away), so one found at startup never ran.
  db.run("UPDATE reviews SET phase = 'failed', error = ? WHERE phase = 'read'", ["The deep review hasn't run yet. Retry to start it."]);
}

function upsertRepo(owner: string, name: string): number {
  db.run("INSERT INTO repos (owner, name) VALUES (?, ?) ON CONFLICT (owner, name) DO NOTHING", [owner, name]);
  return (db.query("SELECT id FROM repos WHERE owner = ? AND name = ?").get(owner, name) as { id: number }).id;
}

export function lastRepo(): string | undefined {
  const row = db
    .query("SELECT r.owner || '/' || r.name AS repo FROM reviews v JOIN repos r ON r.id = v.repo_id ORDER BY v.id DESC LIMIT 1")
    .get() as { repo: string } | null;
  return row?.repo;
}

export function setPhase(id: number, phase: Phase, error: string | null = null) {
  db.run("UPDATE reviews SET phase = ?, error = ? WHERE id = ?", [phase, error, id]);
  emit({ type: "phase", reviewId: id, phase, error });
}

/** Raw row for server-side work (not sent to the client as-is). */
export interface ReviewRow {
  id: number;
  repo_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  title: string;
  author: string;
  url: string;
  head_sha: string;
  head_ref: string;
  base_ref: string;
  phase: Phase;
  recon_json: string | null;
  files_json: string | null;
  diff_text: string | null;
  worktree_path: string | null;
  merge_base: string | null;
  review_session_id: string | null;
  review_summary: string | null;
  read_at: string | null;
  parent_review_id: number | null;
  pr_qa_session_id: string | null;
  mode: ReviewMode;
  local_path: string | null;
  include_dirty: number;
  dirty_files: number;
  run_number: number;
  opened_pr_number: number | null;
}

export function getRow(id: number): ReviewRow | null {
  return db
    .query("SELECT v.*, r.owner, r.name AS repo FROM reviews v JOIN repos r ON r.id = v.repo_id WHERE v.id = ?")
    .get(id) as ReviewRow | null;
}

export const refOf = (r: ReviewRow): PrRef => ({ owner: r.owner, repo: r.repo, number: r.pr_number });

const SUMMARY_SQL = `
  SELECT v.id, r.owner || '/' || r.name AS repo, v.pr_number AS prNumber, v.title, v.author, v.url, v.phase,
         v.additions, v.deletions, v.changed_files AS changedFiles, v.started_at AS startedAt, v.submitted_at AS submittedAt,
         v.mode, v.head_ref AS headRef, v.read_at AS readAt, v.error, v.posted_event AS postedEvent, v.run_number AS runNumber,
         v.opened_pr_number AS openedPrNumber,
         (SELECT COUNT(*) FROM findings f WHERE f.review_id = v.id) AS findingsTotal,
         (SELECT COUNT(*) FROM findings f WHERE f.review_id = v.id AND f.decision IS NOT NULL) AS findingsDecided,
         (SELECT COUNT(*) FROM findings f WHERE f.review_id = v.id AND f.decision = 'accepted') AS findingsAccepted,
         (SELECT COUNT(*) FROM findings f WHERE f.review_id = v.id AND f.resolved_run IS NULL AND COALESCE(f.decision, '') != 'dismissed') AS findingsOpen,
         (SELECT COUNT(*) FROM findings f WHERE f.review_id = v.id AND f.posted = 1) AS postedComments,
         MAX(v.started_at, COALESCE(v.submitted_at, ''), COALESCE(v.read_at, ''),
             COALESCE((SELECT MAX(decided_at) FROM findings f WHERE f.review_id = v.id), '')) AS updatedAt
  FROM reviews v JOIN repos r ON r.id = v.repo_id`;

export function listReviews(limit = 200): ReviewSummary[] {
  return db.query(`${SUMMARY_SQL} ORDER BY v.id DESC LIMIT ?`).all(limit) as ReviewSummary[];
}

/** Scans and deep reviews running now. The run's start time comes from its claude_runs row. */
export function activeRuns(): ActiveRun[] {
  const rows = db
    .query(
      `SELECT v.id, r.owner || '/' || r.name AS repo, v.pr_number AS prNumber, v.title, v.author, v.mode, v.head_ref AS headRef, v.phase,
              COALESCE((SELECT MAX(c.started_at) FROM claude_runs c WHERE c.review_id = v.id AND c.status = 'running'), v.started_at) AS startedAt
       FROM reviews v JOIN repos r ON r.id = v.repo_id
       WHERE v.phase IN ('recon_running', 'reviewing', 'read') ORDER BY v.id DESC`,
    )
    .all() as Array<Omit<ActiveRun, "stage" | "lines" | "reviewId"> & { id: number; phase: Phase }>;
  return rows.map(({ id, phase, startedAt, ...r }) => {
    const stage = phase === "recon_running" ? "recon" : "review";
    return { ...r, reviewId: id, stage, startedAt: startedAt.includes("T") ? startedAt : `${startedAt.replace(" ", "T")}Z`, lines: recentProgress(id, stage) };
  });
}

/** Latest review per PR, for badging inbox entries and de-duplicating scans. */
export function latestReviewFor(repo: string, number: number): { id: number; phase: Phase; headSha: string } | null {
  const [owner, name] = repo.split("/");
  return db
    .query(
      `SELECT v.id, v.phase, v.head_sha AS headSha FROM reviews v JOIN repos r ON r.id = v.repo_id
       WHERE r.owner = ? AND r.name = ? AND v.pr_number = ? AND v.mode = 'peer' ORDER BY v.id DESC LIMIT 1`,
    )
    .get(owner!, name!, number) as { id: number; phase: Phase; headSha: string } | null;
}

export async function getReview(id: number): Promise<ReviewDetail | null> {
  const base = db.query(`${SUMMARY_SQL} WHERE v.id = ?`).get(id) as ReviewSummary | null;
  if (!base) return null;
  const x = db
    .query(
      `SELECT head_sha, head_ref, base_ref, error, recon_json, files_json, read_at, verdict, review_summary, coverage,
              posted_event, posted_body, gh_review_id, parent_review_id, prior_status_json, diff_text, worktree_path,
              local_path, include_dirty, dirty_files, reviewer_questions_json
       FROM reviews WHERE id = ?`,
    )
    .get(id) as any;
  const stack = db
    .query("SELECT pr_number AS number, title, head_ref AS headRef, base_ref AS baseRef, relation, depth FROM stack_links WHERE review_id = ?")
    .all(id) as StackPr[];
  return {
    ...base,
    headSha: x.head_sha,
    headRef: x.head_ref,
    baseRef: x.base_ref,
    error: x.error,
    recon: x.recon_json ? (JSON.parse(x.recon_json) as Recon) : null,
    files: x.files_json ? (JSON.parse(x.files_json) as PrFile[]) : [],
    stack,
    runs: listRuns(id),
    readAt: x.read_at,
    verdict: x.verdict,
    reviewSummary: x.review_summary,
    coverage: x.coverage,
    findings: await listFindings(id, x.diff_text, x.worktree_path),
    postedEvent: x.posted_event,
    postedBody: x.posted_body,
    ghReviewId: x.gh_review_id,
    parentReviewId: x.parent_review_id,
    priorStatus: x.prior_status_json ? (JSON.parse(x.prior_status_json) as PriorStatus[]) : [],
    turnLimit: base.phase === "failed" ? turnLimitStop(id) : null,
    localPath: x.local_path,
    includeDirty: Boolean(x.include_dirty),
    dirtyFiles: x.dirty_files,
    reviewerQuestions: x.reviewer_questions_json ? (JSON.parse(x.reviewer_questions_json) as ReviewerQuestion[]) : [],
    prMessages: db
      .query("SELECT id, role, content, created_at AS createdAt FROM review_messages WHERE review_id = ? ORDER BY id")
      .all(id) as FindingMessage[],
  };
}

/** The failed step's last run, if it stopped at its turn cap and left a session to resume. */
export function lastStoppedRun(reviewId: number): { kind: "recon" | "review"; sessionId: string; maxTurns: number | null } | null {
  const run = db
    .query(
      `SELECT kind, session_id AS sessionId, max_turns AS maxTurns, hit_turn_limit AS hit FROM claude_runs
       WHERE review_id = ? AND kind IN ('recon', 'review') ORDER BY id DESC LIMIT 1`,
    )
    .get(reviewId) as { kind: "recon" | "review"; sessionId: string | null; maxTurns: number | null; hit: number } | null;
  return run?.hit && run.sessionId ? { kind: run.kind, sessionId: run.sessionId, maxTurns: run.maxTurns } : null;
}

function turnLimitStop(reviewId: number): TurnLimitStop | null {
  const run = lastStoppedRun(reviewId);
  if (!run) return null;
  const s = getSettings();
  return { stage: run.kind, limit: run.maxTurns, defaultLimit: run.kind === "recon" ? s.reconMaxTurns : s.reviewMaxTurns };
}

/** Shown instead of the CLI's `error_max_turns`. */
export function turnLimitMessage(stage: "recon" | "review", limit: number | null): string {
  const what = stage === "recon" ? "the overview" : "the deep review";
  const used = limit ? `all ${limit} of its turns` : "all of its turns";
  return `Claude used ${used} before finishing ${what}. Continue to give it more turns from where it stopped, or retry to start over.`;
}

const SEVERITY_ORDER = "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";
const CONFIDENCE_ORDER = "CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END";

async function listFindings(reviewId: number, diffText: string | null, worktree: string | null): Promise<Finding[]> {
  const rows = db
    .query(
      `SELECT id, position, severity, lens, title, path, line, start_line AS startLine, side, why, fix, comment, confidence,
              anchorable, decision, dismiss_reason AS dismissReason, posted, file_snippet_json,
              agent_prompt AS agentPrompt, resolved_run AS resolvedRun, still_open_run AS stillOpenRun, still_note AS stillNote
       FROM findings WHERE review_id = ? ORDER BY ${SEVERITY_ORDER}, ${CONFIDENCE_ORDER}, position`,
    )
    .all(reviewId) as any[];
  if (!rows.length) return [];
  const diff = diffText ? parseDiff(diffText) : new Map();
  const messages = db
    .query(
      `SELECT m.id, m.finding_id AS findingId, m.role, m.content, m.created_at AS createdAt FROM finding_messages m
       JOIN findings f ON f.id = m.finding_id WHERE f.review_id = ? ORDER BY m.id`,
    )
    .all(reviewId) as Array<FindingMessage & { findingId: number }>;

  return Promise.all(
    rows.map(async (r) => {
      const anchor = { path: r.path, line: r.line, startLine: r.startLine, side: r.side };
      const { file_snippet_json, ...finding } = r;
      let snippet = snippetFromDiff(diff, anchor) ?? (file_snippet_json ? JSON.parse(file_snippet_json) : []);
      if (!snippet.length && worktree && r.path && r.line) {
        const from = Math.max(1, (r.startLine ?? r.line) - 4);
        const lines = await readLines(worktree, r.path, from, r.line + 4);
        if (lines) snippet = snippetFromFile(lines, from, { from: r.startLine ?? r.line, to: r.line });
      }
      return {
        ...finding,
        anchorable: Boolean(r.anchorable),
        posted: Boolean(r.posted),
        snippet,
        messages: messages.filter((m) => m.findingId === r.id).map(({ findingId, ...m }) => m),
      } satisfies Finding;
    }),
  );
}

const RUN_SQL = `
  SELECT id, kind, model, status, cost_usd AS costUsd, duration_ms AS durationMs, input_tokens AS inputTokens,
         output_tokens AS outputTokens, error, started_at AS startedAt
  FROM claude_runs`;

function listRuns(reviewId: number): ClaudeRun[] {
  return db.query(`${RUN_SQL} WHERE review_id = ? ORDER BY id`).all(reviewId) as ClaudeRun[];
}

function getRun(id: number): ClaudeRun {
  return db.query(`${RUN_SQL} WHERE id = ?`).get(id) as ClaudeRun;
}

export function markRead(id: number) {
  db.run("UPDATE reviews SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL", [id]);
}

// ---------- Claude run bookkeeping ----------

export async function trackedRun<T>(
  reviewId: number,
  kind: ClaudeRun["kind"],
  model: string,
  run: (logName: string, onProgress: (p: { text: string; tool?: string }) => void) => Promise<ClaudeResult<T>>,
  opts: { quiet?: boolean; stripPrefix?: string; maxTurns?: number } = {},
): Promise<ClaudeResult<T>> {
  // Codex runs are labelled as such in the run list ("codex/gpt-5"); Claude's stay bare.
  const label = getSettings().provider === "codex" ? `codex/${model}` : model;
  const { id: runId } = db
    .query("INSERT INTO claude_runs (review_id, kind, model, status, max_turns) VALUES (?, ?, ?, 'running', ?) RETURNING id")
    .get(reviewId, kind, label, opts.maxTurns ?? null) as { id: number };
  emit({ type: "run", reviewId, run: getRun(runId) });
  const onProgress = (p: { text: string; tool?: string }) => {
    if (opts.quiet) return;
    const text = opts.stripPrefix ? p.text.replaceAll(opts.stripPrefix + "/", "") : p.text;
    emit({ type: "progress", reviewId, runKind: kind, text, tool: p.tool, at: Date.now() });
  };

  let res: ClaudeResult<T>;
  try {
    res = await run(`review-${reviewId}-${kind}-${runId}`, onProgress);
  } catch (e) {
    db.run("UPDATE claude_runs SET status = 'error', error = ? WHERE id = ?", [String(e), runId]);
    emit({ type: "run", reviewId, run: getRun(runId) });
    throw e;
  }
  db.run(
    `UPDATE claude_runs SET status = ?, session_id = ?, cost_usd = ?, duration_ms = ?, input_tokens = ?, output_tokens = ?,
            error = ?, log_path = ?, hit_turn_limit = ? WHERE id = ?`,
    [res.isError ? "error" : "success", res.sessionId, res.costUsd, res.durationMs, res.inputTokens, res.outputTokens, res.error, res.logPath,
     res.hitTurnLimit ? 1 : 0, runId],
  );
  emit({ type: "run", reviewId, run: getRun(runId) });
  return res;
}

// ---------- recon ----------

/**
 * Creates a review for the PR and kicks off recon in the background. If this exact commit already
 * has a live (non-failed) review, returns that instead of starting over.
 */
export async function startReview(input: string, defaultRepo?: string): Promise<number> {
  const ref = parsePrRef(input, defaultRepo || lastRepo());
  const pr = await prView(ref);

  // Your own PR: that's a self-review (findings stay private, "Open PR"/re-run flow), not a peer review.
  if (isMine(pr.author, await viewer().catch(() => null))) {
    const { startSelfReview } = await import("./self"); // self.ts imports this module
    return (await startSelfReview({ repo: `${ref.owner}/${ref.repo}`, pr: pr.number })).id;
  }

  const existing = latestReviewFor(`${ref.owner}/${ref.repo}`, pr.number);
  if (existing && existing.headSha === pr.headRefOid && existing.phase !== "failed") return existing.id;

  const id = insertReview(ref, pr, "recon_running");
  runRecon(id, ref, pr).catch((e) => setPhase(id, "failed", e instanceof Error ? e.message : String(e)));
  return id;
}

/** Is a PR's author the signed-in gh user? GitHub logins are case-insensitive. */
export const isMine = (author: string | null | undefined, me: string | null | undefined) =>
  Boolean(author && me && author.toLowerCase() === me.toLowerCase());

export function insertReview(ref: PrRef, pr: Awaited<ReturnType<typeof prView>>, phase: Phase, parentReviewId: number | null = null): number {
  const repoId = upsertRepo(ref.owner, ref.repo);
  const { id } = db
    .query(
      `INSERT INTO reviews (repo_id, pr_number, title, author, url, head_sha, head_ref, base_ref, additions, deletions,
                            changed_files, files_json, phase, parent_review_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(repoId, pr.number, pr.title, pr.author, pr.url, pr.headRefOid, pr.headRefName, pr.baseRefName, pr.additions,
         pr.deletions, pr.changedFiles, JSON.stringify(pr.files), phase, parentReviewId) as { id: number };
  return id;
}

/** Re-runs recon for a review whose recon failed. */
export async function retryRecon(id: number) {
  const row = getRow(id);
  if (!row) throw new Error("Not found");
  if (isLocalSelf(row)) {
    setPhase(id, "recon_running");
    runRecon(id, refOf(row), localPrView(row, ""), { diff: row.diff_text ?? "" }).catch((e) =>
      setPhase(id, "failed", e instanceof Error ? e.message : String(e)),
    );
    return;
  }
  const pr = await prView(refOf(row));
  setPhase(id, "recon_running");
  runRecon(id, refOf(row), pr).catch((e) => setPhase(id, "failed", e instanceof Error ? e.message : String(e)));
}

/** A self-review of a branch in the user's checkout (no PR on GitHub to fetch from). */
export const isLocalSelf = (row: ReviewRow) => row.mode === "self" && row.pr_number === 0;

/** The PrView-shaped record the recon prompt wants, for a branch with no PR. */
export function localPrView(row: ReviewRow, body: string): Awaited<ReturnType<typeof prView>> {
  const files: PrFile[] = row.files_json ? JSON.parse(row.files_json) : [];
  return {
    number: 0,
    title: row.title,
    body,
    url: row.url,
    author: row.author,
    isDraft: false,
    state: "OPEN",
    headRefName: row.head_ref,
    headRefOid: row.head_sha,
    baseRefName: row.base_ref,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    changedFiles: files.length,
    labels: [],
    files,
  };
}

export async function saveStack(id: number, ref: PrRef, pr: Awaited<ReturnType<typeof prView>>): Promise<StackPr[]> {
  const stack = findStack(pr, await listOpenPrs(ref.owner, ref.repo));
  const insertLink = db.prepare(
    "INSERT OR REPLACE INTO stack_links (review_id, pr_number, relation, depth, title, head_ref, base_ref) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const s of stack) insertLink.run(id, s.number, s.relation, s.depth, s.title, s.headRef, s.baseRef);
  })();
  return stack;
}

/**
 * The overview. For a PR it fetches the diff and stack from GitHub; a self-review of a local
 * branch passes `local` (the snapshot's diff), and has no stack.
 */
export async function runRecon(id: number, ref: PrRef, pr: Awaited<ReturnType<typeof prView>>, local?: { diff: string }) {
  const progress = (text: string) => emit({ type: "progress", reviewId: id, runKind: "recon", text, at: Date.now() });
  const self = getRow(id)?.mode === "self";

  let fullDiff: string;
  let stack: StackPr[] = [];
  if (local) {
    fullDiff = local.diff;
  } else {
    progress("Fetching diff and open PRs");
    [fullDiff, stack] = await Promise.all([prDiff(ref), saveStack(id, ref, pr)]);
  }
  db.run("UPDATE reviews SET diff_text = ? WHERE id = ?", [fullDiff, id]);
  if (stack.length) progress(`Found a stack of ${stack.length + 1} PRs`);

  const areas = groupAreas(pr.files);
  const heuristic = heuristicMinutes(pr.files);
  const diffTruncated = fullDiff.length > RECON_DIFF_CHAR_LIMIT;
  const diff = diffTruncated ? fullDiff.slice(0, RECON_DIFF_CHAR_LIMIT) : fullDiff;

  progress("Asking Claude for an overview");
  const { models, effort, reconMaxTurns } = getSettings();
  const res = await trackedRun<ReconOutput>(
    id,
    "recon",
    models.recon,
    (logName, onProgress) =>
      runAgent({
        prompt: reconPrompt({ repo: `${ref.owner}/${ref.repo}`, pr, areas, heuristicMinutes: heuristic, stack, diff, diffTruncated }),
        cwd: DATA_DIR,
        model: models.recon,
        effort: effort.recon,
        tools: [],
        jsonSchema: self ? RECON_SELF_SCHEMA : RECON_SCHEMA,
        appendSystemPrompt: self ? RECON_SELF_SYSTEM : RECON_SYSTEM,
        maxTurns: reconMaxTurns,
        logName,
        onProgress,
      }),
    { maxTurns: reconMaxTurns },
  );
  saveRecon(id, pr.files, res, diffTruncated, reconMaxTurns);
}

type ReconOutput = Omit<Recon, "heuristicMinutes" | "diffTruncated"> & { reviewerQuestions?: ReviewerQuestion[] };

function saveRecon(id: number, files: PrFile[], res: ClaudeResult<ReconOutput>, diffTruncated: boolean, maxTurns: number) {
  if (res.hitTurnLimit) throw new Error(turnLimitMessage("recon", maxTurns));
  if (res.isError || !res.structured) throw new Error(res.error ?? "Recon returned nothing");

  // Numbers come from the diff, not from Claude; Claude only names and describes each area.
  const { reviewerQuestions, ...structured } = res.structured;
  const labels = new Map(structured.areas.map((a) => [a.path, a]));
  const recon: Recon = {
    ...structured,
    areas: groupAreas(files).map((a) => ({
      ...a,
      label: labels.get(a.path)?.label ?? a.path,
      note: labels.get(a.path)?.note ?? "",
    })),
    heuristicMinutes: heuristicMinutes(files),
    diffTruncated,
  };
  db.run("UPDATE reviews SET recon_json = ?, reviewer_questions_json = ? WHERE id = ?", [
    JSON.stringify(recon),
    reviewerQuestions ? JSON.stringify(reviewerQuestions) : null,
    id,
  ]);
  setPhase(id, "recon_ready");
}

/** Resumes an overview that ran out of turns, in the same Claude session, with `turns` more. */
export async function continueRecon(id: number, sessionId: string, turns: number) {
  const row = getRow(id);
  if (!row) throw new Error("Not found");
  const { models, effort } = getSettings();
  setPhase(id, "recon_running");
  const files: PrFile[] = row.files_json ? JSON.parse(row.files_json) : [];
  const diffTruncated = (row.diff_text?.length ?? 0) > RECON_DIFF_CHAR_LIMIT;
  (async () => {
    const res = await trackedRun<ReconOutput>(
      id,
      "recon",
      models.recon,
      (logName, onProgress) =>
        runAgent({
          prompt: CONTINUE_PROMPT,
          resume: sessionId,
          cwd: DATA_DIR,
          model: models.recon,
          effort: effort.recon,
          tools: [],
          jsonSchema: row.mode === "self" ? RECON_SELF_SCHEMA : RECON_SCHEMA,
          appendSystemPrompt: row.mode === "self" ? RECON_SELF_SYSTEM : RECON_SYSTEM,
          maxTurns: turns,
          logName,
          onProgress,
        }),
      { maxTurns: turns },
    );
    saveRecon(id, files, res, diffTruncated, turns);
  })().catch((e) => setPhase(id, "failed", e instanceof Error ? e.message : String(e)));
}

/** Sent when resuming a run that hit its turn cap. */
export const CONTINUE_PROMPT =
  "You ran out of turns before finishing. Pick up where you left off, then return your final answer through the StructuredOutput tool with every required field filled in.";
