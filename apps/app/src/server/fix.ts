// Fixes: a reviewer requested changes on one of your PRs. "Fix" runs the agent in PR Bunny's own
// checkout of the PR head (never your working copy) with edit tools scoped to that checkout, and
// saves the resulting diff for you to read. Approve commits it and pushes to the PR branch; Decline
// throws it away. The push is the only GitHub write here, and only from the confirmed click.
import { existsSync } from "node:fs";
import type { FixDetail, FixEvent, FixFile, FixRequest, FixState } from "../shared/types";
import { parseDiff } from "./anchors";
import { agentName, runAgent } from "./agents";
import { clonePath, commitAndPush, gitIdentity, prepareFixWorktree, removeWorktree, stagedChanges } from "./git";
import { ghJson, prDiff, prReviewComments, prReviews, prView, viewer, type PrRef } from "./gh";
import { publish } from "./live";
import { FIX_SCHEMA, fixPrompt, fixSystem, type FixOutput } from "./prompts/fix";
import { db } from "./db/db";
import { isMine, upsertRepo } from "./reviews";
import { getSettings } from "./settings";

const DIFF_CHAR_LIMIT = 120_000;

export interface FixRow {
  id: number;
  repo_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  title: string;
  url: string;
  author: string;
  head_ref: string | null;
  base_ref: string | null;
  head_sha: string | null;
  state: FixState;
  error: string | null;
  requests_json: string | null;
  worktree_path: string | null;
  session_id: string | null;
  summary: string | null;
  commit_message: string | null;
  addressed_json: string | null;
  not_addressed_json: string | null;
  diff_text: string | null;
  files_json: string | null;
  pushed_sha: string | null;
  model: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
  finished_at: string | null;
}

export function getFixRow(id: number): FixRow | null {
  return db.query("SELECT f.*, r.owner, r.name AS repo FROM fixes f JOIN repos r ON r.id = f.repo_id WHERE f.id = ?").get(id) as FixRow | null;
}

const refOf = (f: FixRow): PrRef => ({ owner: f.owner, repo: f.repo, number: f.pr_number });

// ---------- live progress ----------

export const fixTopic = (id: number) => `fix:${id}`;
const backlog = new Map<number, Array<{ text: string; tool?: string; at: number }>>();

function progress(id: number, text: string, tool?: string) {
  const list = backlog.get(id) ?? [];
  list.push({ text, tool, at: Date.now() });
  if (list.length > 300) list.splice(0, list.length - 300);
  backlog.set(id, list);
  publish(fixTopic(id), { type: "progress", fixId: id, text, tool, at: Date.now() } satisfies FixEvent);
}

export const fixBacklog = (id: number) => backlog.get(id) ?? [];

function setState(id: number, state: FixState, error: string | null = null) {
  const done = state === "ready" || state === "failed";
  db.run(`UPDATE fixes SET state = ?, error = ?${done ? ", finished_at = datetime('now')" : ""} WHERE id = ?`, [state, error, id]);
  publish(fixTopic(id), { type: "state", fixId: id, state } satisfies FixEvent);
  // The bell shows the fix's state on its "changes requested" entry.
  publish("notifications", { type: "sync" });
  onStateChange?.(id, state);
}

/** notify.ts hooks this to raise "Fix ready" / "Fix failed" (set from there to avoid an import cycle). */
let onStateChange: ((id: number, state: FixState) => void) | null = null;
export function onFixState(fn: (id: number, state: FixState) => void) {
  onStateChange = fn;
}

// ---------- what the reviewer asked for ----------

/**
 * The "changes requested" reviews that still stand (each reviewer's latest review, when it asks
 * for changes), with their inline comments. The viewer's own reviews don't count.
 */
export async function loadRequests(ref: PrRef): Promise<FixRequest[]> {
  const me = (await viewer().catch(() => "")).toLowerCase();
  const [reviews, comments] = await Promise.all([prReviews(ref), prReviewComments(ref).catch(() => [])]);
  const latest = new Map<string, (typeof reviews)[number]>();
  for (const r of reviews) {
    if (!r.author || r.author.toLowerCase() === me || r.state === "PENDING" || r.state === "DISMISSED") continue;
    // COMMENTED after a CHANGES_REQUESTED doesn't lift the request; APPROVED does.
    if (r.state === "COMMENTED" && latest.get(r.author)?.state === "CHANGES_REQUESTED") continue;
    latest.set(r.author, r);
  }
  return [...latest.values()]
    .filter((r) => r.state === "CHANGES_REQUESTED")
    .map((r) => ({
      id: r.id,
      author: r.author,
      body: r.body,
      submittedAt: r.submittedAt,
      url: r.url,
      comments: comments
        .filter((c) => c.reviewId === r.id)
        .map((c) => ({ id: c.id, author: c.author, path: c.path, line: c.line, body: c.body, hunk: c.diffHunk, url: c.url })),
    }));
}

// ---------- rows ----------

/** The fix for this PR that's still live (not settled), if any. */
function liveFixFor(ref: PrRef): FixRow | null {
  return db
    .query(
      `SELECT f.*, r.owner, r.name AS repo FROM fixes f JOIN repos r ON r.id = f.repo_id
       WHERE r.owner = ? AND r.name = ? AND f.pr_number = ? AND f.state IN ('new', 'running', 'ready') ORDER BY f.id DESC LIMIT 1`,
    )
    .get(ref.owner, ref.repo, ref.number) as FixRow | null;
}

/**
 * The fix to show for a PR with changes requested: the live one, else a new row with the PR and
 * the reviewer's requests loaded from GitHub (read-only). Only your own PRs.
 */
export async function ensureFix(ref: PrRef, opts: { notificationId?: number } = {}): Promise<FixRow> {
  const existing = liveFixFor(ref);
  if (existing) {
    link(opts.notificationId, existing.id);
    return existing;
  }
  const pr = await prView(ref);
  const me = await viewer().catch(() => null);
  if (!isMine(pr.author, me)) throw new Error(`#${pr.number} was opened by ${pr.author}. PR Bunny only fixes your own PRs.`);
  if (pr.state !== "OPEN") throw new Error(`#${pr.number} is already ${pr.state.toLowerCase()}.`);
  const requests = await loadRequests(ref);
  const repoId = upsertRepo(ref.owner, ref.repo);
  const { id } = db
    .query(
      `INSERT INTO fixes (repo_id, pr_number, title, url, author, head_ref, base_ref, head_sha, state, requests_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?) RETURNING id`,
    )
    .get(repoId, pr.number, pr.title, pr.url, pr.author, pr.headRefName, pr.baseRefName, pr.headRefOid, JSON.stringify(requests)) as { id: number };
  link(opts.notificationId, id);
  return getFixRow(id)!;
}

/**
 * "Don't fix": records the choice (no checkout, nothing runs) so the bell stops asking. The PR and
 * the reviewer's comments are still loaded (read-only), so the fix page can offer Fix later.
 */
export async function skipFix(ref: PrRef, info: { title: string; url: string }, notificationId?: number): Promise<FixRow> {
  const live = liveFixFor(ref) ?? (await ensureFix(ref).catch(() => null));
  if (live) {
    if (live.state === "new") db.run("UPDATE fixes SET state = 'skipped', decided_at = datetime('now') WHERE id = ?", [live.id]);
    link(notificationId, live.id);
    publish("notifications", { type: "sync" });
    return getFixRow(live.id)!;
  }
  // Not yours, closed, or GitHub unreachable: still remember the choice.
  const repoId = upsertRepo(ref.owner, ref.repo);
  const { id } = db
    .query("INSERT INTO fixes (repo_id, pr_number, title, url, state, decided_at) VALUES (?, ?, ?, ?, 'skipped', datetime('now')) RETURNING id")
    .get(repoId, ref.number, info.title, info.url) as { id: number };
  link(notificationId, id);
  publish("notifications", { type: "sync" });
  return getFixRow(id)!;
}

/** "Don't fix" on the fix page. */
export function skipFixById(id: number): FixRow {
  const row = getFixRow(id);
  if (!row) throw new Error("Fix not found");
  if (row.state !== "new") throw new Error("This fix has already been started.");
  db.run("UPDATE fixes SET decided_at = datetime('now') WHERE id = ?", [id]);
  setState(id, "skipped");
  return getFixRow(id)!;
}

function link(notificationId: number | undefined, fixId: number) {
  if (notificationId) db.run("UPDATE notifications SET fix_id = ? WHERE id = ?", [fixId, notificationId]);
}

// ---------- the run ----------

const running = new Map<number, AbortController>();
export const isFixRunning = (id: number) => running.has(id);

/** Starts the agent on a fix in the background. No-op if it's already running. */
export function startFix(id: number): FixRow {
  const row = getFixRow(id);
  if (!row) throw new Error("Fix not found");
  if (running.has(id)) return row;
  if (row.state === "running") throw new Error("This fix is already running.");
  if (row.state === "pushed") throw new Error("This fix was already pushed.");
  const ctrl = new AbortController();
  running.set(id, ctrl);
  backlog.delete(id);
  db.run("UPDATE fixes SET error = NULL, summary = NULL, commit_message = NULL, addressed_json = NULL, not_addressed_json = NULL, diff_text = NULL, files_json = NULL, finished_at = NULL WHERE id = ?", [id]);
  setState(id, "running");
  runFix(row, ctrl.signal)
    .catch(async (e) => {
      setState(id, ctrl.signal.aborted ? "new" : "failed", ctrl.signal.aborted ? null : e instanceof Error ? e.message : String(e));
      // A run that didn't finish leaves its checkout behind; nothing needs it.
      const left = getFixRow(id);
      if (left?.worktree_path) {
        await removeWorktree(left.owner, left.repo, left.worktree_path).catch(() => {});
        db.run("UPDATE fixes SET worktree_path = NULL WHERE id = ?", [id]);
      }
    })
    .finally(() => {
      if (running.get(id) === ctrl) running.delete(id);
    });
  return getFixRow(id)!;
}

/** Stop: kills the agent; the fix goes back to "new" so it can be run again. */
export function stopFix(id: number): boolean {
  const ctrl = running.get(id);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

async function runFix(row: FixRow, signal: AbortSignal) {
  const id = row.id;
  const ref = refOf(row);
  const log = (text: string) => progress(id, text);

  // Fresh look at the PR: the head may have moved and the reviewer may have said more since.
  const pr = await prView(ref);
  if (pr.state !== "OPEN") throw new Error(`#${pr.number} is ${pr.state.toLowerCase()} now.`);
  if (!isMine(pr.author, await viewer().catch(() => null))) throw new Error(`#${pr.number} was opened by ${pr.author}. PR Bunny only fixes your own PRs.`);
  const requests = await loadRequests(ref);
  if (!requests.length) throw new Error("Nobody is requesting changes on this PR any more.");
  db.run("UPDATE fixes SET title = ?, head_ref = ?, base_ref = ?, head_sha = ?, requests_json = ? WHERE id = ?", [pr.title, pr.headRefName, pr.baseRefName, pr.headRefOid, JSON.stringify(requests), id]);
  if (signal.aborted) throw new Error("Cancelled");

  const wt = await prepareFixWorktree({ fixId: id, owner: row.owner, repo: row.repo, prNumber: row.pr_number, headSha: pr.headRefOid }, log);
  db.run("UPDATE fixes SET worktree_path = ? WHERE id = ?", [wt.path, id]);
  if (signal.aborted) throw new Error("Cancelled");

  const fullDiff = await prDiff(ref);
  const diffTruncated = fullDiff.length > DIFF_CHAR_LIMIT;
  const settings = getSettings();
  const n = requests.reduce((a, r) => a + r.comments.length, 0);
  log(`${agentName()} is making the changes ${requests.map((r) => `@${r.author}`).join(", ")} asked for (${n} inline comment${n === 1 ? "" : "s"})`);
  const started = Date.now();
  const res = await runAgent<FixOutput>({
    prompt: fixPrompt({
      repo: `${row.owner}/${row.repo}`,
      pr: { number: pr.number, title: pr.title, body: pr.body, author: pr.author, headRef: pr.headRefName, baseRef: pr.baseRefName, headSha: pr.headRefOid },
      requests,
      diff: diffTruncated ? fullDiff.slice(0, DIFF_CHAR_LIMIT) : fullDiff,
      diffTruncated,
    }),
    cwd: wt.path,
    model: settings.models.review,
    effort: settings.effort.review,
    ...writeTools(wt.path),
    jsonSchema: FIX_SCHEMA,
    appendSystemPrompt: fixSystem(wt.path),
    maxTurns: settings.reviewMaxTurns,
    logName: `fix-${id}`,
    onProgress: (p) => progress(id, p.text.replaceAll(wt.path + "/", ""), p.tool),
    signal,
  });
  db.run("UPDATE fixes SET session_id = ?, model = ?, cost_usd = ?, duration_ms = ?, input_tokens = ?, output_tokens = ?, log_path = ? WHERE id = ?", [
    res.sessionId,
    settings.provider === "codex" ? `codex/${settings.models.review}` : settings.models.review,
    res.costUsd,
    res.durationMs ?? Date.now() - started,
    res.inputTokens,
    res.outputTokens,
    res.logPath,
    id,
  ]);
  if (signal.aborted) throw new Error("Cancelled");
  if (res.denials.length) log(`${res.denials.length} tool call(s) were blocked by the sandbox`);
  if (res.hitTurnLimit) throw new Error(`${agentName()} used all ${settings.reviewMaxTurns} of its turns before finishing. Run it again, or raise the review turn limit in Settings.`);
  if (res.isError || !res.structured) throw new Error(res.error ?? "The fix returned nothing");

  const { diff, files } = await stagedChanges(wt.path);
  // The checkout has done its job: the diff is what's kept (approving applies it to a fresh checkout).
  await removeWorktree(row.owner, row.repo, wt.path).catch(() => {});
  db.run("UPDATE fixes SET worktree_path = NULL WHERE id = ?", [id]);
  const out = res.structured;
  if (!files.length) {
    db.run("UPDATE fixes SET summary = ?, commit_message = ?, addressed_json = ?, not_addressed_json = ? WHERE id = ?", [out.summary, out.commitMessage, JSON.stringify(out.addressed ?? []), JSON.stringify(out.notAddressed ?? []), id]);
    throw new Error(`${agentName()} didn't change anything. ${out.summary}`);
  }
  db.run("UPDATE fixes SET summary = ?, commit_message = ?, addressed_json = ?, not_addressed_json = ?, diff_text = ?, files_json = ? WHERE id = ?", [
    out.summary,
    cleanMessage(out.commitMessage),
    JSON.stringify(out.addressed ?? []),
    JSON.stringify(out.notAddressed ?? []),
    diff,
    JSON.stringify(files),
    id,
  ]);
  log(`Changed ${files.length} file${files.length === 1 ? "" : "s"}`);
  setState(id, "ready");
}

/** Edit tools scoped to one checkout. `dontAsk` denies anything not listed here. */
export function writeTools(worktree: string) {
  return {
    tools: ["Read", "Grep", "Glob", "Bash", "Edit", "Write"],
    permissionMode: "dontAsk" as const,
    write: true,
    allowedTools: [
      `Read(/${worktree}/**)`, // leading "//" = absolute path in permission rules
      `Edit(/${worktree}/**)`,
      `Write(/${worktree}/**)`,
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "Bash(git blame:*)",
      "Bash(git status:*)",
      "Bash(git ls-files:*)",
    ],
  };
}

/** No trailers, no sign-offs: the commit is the user's. */
export function cleanMessage(m: string): string {
  return m
    .split("\n")
    .filter((l) => !/^(co-authored-by|signed-off-by|generated[- ]with|🤖)/i.test(l.trim()))
    .join("\n")
    .trim();
}

// ---------- decisions ----------

/**
 * Approve: commits the saved diff on the PR head it was made for and pushes it to the PR branch.
 * Refuses if the PR moved on GitHub since (the diff may not apply, and you haven't seen the new
 * commits). Only from the confirmed click.
 */
export async function approveFix(id: number, input: { commitMessage: string; headSha: string }): Promise<FixRow> {
  const row = getFixRow(id);
  if (!row) throw new Error("Fix not found");
  if (row.state !== "ready" || !row.diff_text || !row.head_sha || !row.head_ref) throw new Error("This fix isn't waiting for approval.");
  if (input.headSha !== row.head_sha) throw new Error("This page is out of date. Reload and look at the fix again.");
  const message = cleanMessage(input.commitMessage);
  if (!message) throw new Error("Write a commit message first.");
  const pr = await prView(refOf(row));
  if (pr.state !== "OPEN") throw new Error(`#${pr.number} is ${pr.state.toLowerCase()} now.`);
  if (pr.headRefOid !== row.head_sha) throw new Error(`New commits were pushed to ${row.head_ref} since this fix was made. Run the fix again on the new commits.`);
  const me = await viewer().catch(() => null);
  if (!isMine(pr.author, me)) throw new Error(`#${pr.number} was opened by ${pr.author}, so PR Bunny won't push to it.`);
  const identity = (await gitIdentity(clonePath(row.owner, row.repo))) ?? (await fallbackIdentity());
  const sha = await commitAndPush(
    { fixId: id, owner: row.owner, repo: row.repo, prNumber: row.pr_number, headSha: row.head_sha, branch: row.head_ref, diff: row.diff_text, message, identity },
    (text) => progress(id, text),
  );
  db.run("UPDATE fixes SET commit_message = ?, pushed_sha = ?, decided_at = datetime('now') WHERE id = ?", [message, sha, id]);
  setState(id, "pushed");
  return getFixRow(id)!;
}

/** Without a git identity on this machine, commit as the GitHub account (its noreply address). */
async function fallbackIdentity(): Promise<{ name: string; email: string } | null> {
  const u = await ghJson<{ login: string; name: string | null; id: number }>(["api", "user"]).catch(() => null);
  return u ? { name: u.name || u.login, email: `${u.id}+${u.login}@users.noreply.github.com` } : null;
}

/** Decline: the diff is thrown away. The fix can be run again. */
export function declineFix(id: number): FixRow {
  const row = getFixRow(id);
  if (!row) throw new Error("Fix not found");
  if (row.state !== "ready") throw new Error("Only a fix that's waiting for approval can be declined.");
  db.run("UPDATE fixes SET decided_at = datetime('now') WHERE id = ?", [id]);
  setState(id, "declined");
  return getFixRow(id)!;
}

// ---------- reading ----------

function filesOf(row: FixRow): FixFile[] {
  const stats: Array<{ path: string; additions: number; deletions: number }> = row.files_json ? JSON.parse(row.files_json) : [];
  if (!row.diff_text) return stats.map((s) => ({ ...s, lines: [] }));
  const parsed = parseDiff(row.diff_text);
  return stats.map((s) => {
    const fd = parsed.get(s.path);
    const lines: FixFile["lines"] = [];
    for (const [i, hunk] of (fd?.hunks ?? []).entries()) {
      if (i) lines.push({ kind: "gap", oldNo: null, newNo: null, text: "", target: false });
      for (const l of hunk) lines.push({ kind: l.kind, oldNo: l.oldNo, newNo: l.newNo, text: l.text, target: false });
    }
    return { ...s, lines };
  });
}

export function getFix(id: number): FixDetail | null {
  const r = getFixRow(id);
  if (!r) return null;
  return {
    id: r.id,
    repo: `${r.owner}/${r.repo}`,
    prNumber: r.pr_number,
    title: r.title,
    url: r.url,
    author: r.author,
    headRef: r.head_ref ?? "",
    baseRef: r.base_ref ?? "",
    headSha: r.head_sha ?? "",
    state: r.state,
    error: r.error,
    requests: r.requests_json ? (JSON.parse(r.requests_json) as FixRequest[]) : [],
    summary: r.summary,
    commitMessage: r.commit_message,
    addressed: r.addressed_json ? JSON.parse(r.addressed_json) : [],
    notAddressed: r.not_addressed_json ? JSON.parse(r.not_addressed_json) : [],
    files: filesOf(r),
    pushedSha: r.pushed_sha,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    run: r.model ? { model: r.model, costUsd: r.cost_usd, durationMs: r.duration_ms, inputTokens: r.input_tokens, outputTokens: r.output_tokens } : null,
    lines: fixBacklog(r.id),
  };
}

/** Fixes that were running when the server restarted can't finish: say so. */
export function recoverInterruptedFixes() {
  db.run("UPDATE fixes SET state = 'failed', error = ?, finished_at = datetime('now') WHERE state = 'running'", ["Interrupted: the server restarted while this was running. Run it again."]);
}

/** Paths of fix checkouts the cleanup must leave alone (a run in progress). */
export function runningFixWorktrees(): Set<string> {
  const out = new Set<string>();
  for (const id of running.keys()) {
    const p = (db.query("SELECT worktree_path AS p FROM fixes WHERE id = ?").get(id) as { p: string | null } | null)?.p;
    if (p && existsSync(p)) out.add(p);
  }
  return out;
}
