// Stack review: a stack of PRs reviewed together. Each layer is an ordinary review (peer, or a
// self-review for your own PRs); the stack ties them together, runs "Review all" base first (or
// top first), adds an "across the stack" pass once every layer is reviewed, and posts one GitHub
// review per PR. Nothing here writes to GitHub except postStack, from an explicit click.
import { $ } from "bun";
import type {
  LayerState,
  ReviewEvent,
  Severity,
  StackBadge,
  StackDetail,
  StackFinding,
  StackLayer,
  StackSubmissionLayer,
  StackSummary,
} from "../shared/types";
import { agentName, runAgent } from "./agents";
import { buildSubmission, startRereview, submit } from "./actions";
import { db } from "./db/db";
import { ensureWorktree, readOnlyTools, rerunSelfReview, startDeepReview } from "./deep";
import { listOpenPrs, parsePrRef, prForBranch, prView, viewer, type OpenPr } from "./gh";
import { recentProgress } from "./live";
import { checkoutInfo } from "./local";
import { STACK_SCHEMA, stackPrompt, stackSystem, type StackLayerInput, type StackOutput } from "./prompts/stack";
import { getRow, isMine, markRead, startReview, upsertRepo } from "./reviews";
import { getSettings } from "./settings";

// ---------- open PRs, cached briefly ----------

const OPEN_TTL_MS = 30_000;
const openCache = new Map<string, { at: number; value: Promise<OpenPr[]> }>();
function openPrs(repo: string): Promise<OpenPr[]> {
  const hit = openCache.get(repo);
  if (hit && Date.now() - hit.at < OPEN_TTL_MS) return hit.value;
  const [owner, name] = repo.split("/") as [string, string];
  const value = listOpenPrs(owner, name);
  openCache.set(repo, { at: Date.now(), value });
  value.catch(() => openCache.delete(repo));
  return value;
}

interface TreeNode {
  pr: OpenPr;
  depth: number;
  parentPr: number | null;
}

/**
 * The whole stack a PR belongs to, in stack order (base first, each child after its parent). The
 * root is the lowest PR whose base isn't another open PR's head. A stack of one isn't a stack.
 */
export function stackTree(open: OpenPr[], number: number): TreeNode[] | null {
  const byHead = new Map(open.map((p) => [p.headRefName, p]));
  const byBase = new Map<string, OpenPr[]>();
  for (const p of open) byBase.set(p.baseRefName, [...(byBase.get(p.baseRefName) ?? []), p]);
  let root = open.find((p) => p.number === number);
  if (!root) return null;
  const seen = new Set<number>([root.number]);
  for (let parent = byHead.get(root.baseRefName); parent && !seen.has(parent.number); parent = byHead.get(root.baseRefName)) {
    seen.add(parent.number);
    root = parent;
  }
  const out: TreeNode[] = [];
  const visit = (pr: OpenPr, depth: number, parentPr: number | null, guard: Set<number>) => {
    if (guard.has(pr.number)) return;
    guard.add(pr.number);
    out.push({ pr, depth, parentPr });
    for (const child of [...(byBase.get(pr.headRefName) ?? [])].sort((a, b) => a.number - b.number)) visit(child, depth + 1, pr.number, guard);
  };
  visit(root, 1, null, new Set());
  return out.length > 1 ? out : null;
}

/** "2 of 5" for a PR in a stack, or null, plus the saved stack it's in and whether that's running Review all. */
export async function stackBadge(repo: string, number: number): Promise<StackBadge | null> {
  const tree = stackTree(await openPrs(repo).catch(() => []), number);
  if (!tree) return null;
  const [owner, name] = repo.split("/");
  const saved = db
    .query(
      `SELECT s.id, s.run_state AS runState FROM stacks s JOIN repos r ON r.id = s.repo_id
       JOIN stack_layers l ON l.stack_id = s.id AND l.pr_number = ? AND l.gh_state = 'open'
       WHERE r.owner = ? AND r.name = ? ORDER BY (s.run_state = 'running') DESC, s.updated_at DESC LIMIT 1`,
    )
    .get(number, owner!, name!) as { id: number; runState: string } | null;
  return {
    pos: tree.findIndex((n) => n.pr.number === number) + 1,
    size: tree.length,
    stackId: saved?.id ?? null,
    running: saved?.runState === "running",
  };
}

/** Adds stack badges to inbox/search entries (one gh call per repo, cached). */
export async function withStackBadges<T extends { repo: string; number: number }>(entries: T[]): Promise<Array<T & { stack: StackBadge | null }>> {
  return Promise.all(entries.map(async (e) => ({ ...e, stack: await stackBadge(e.repo, e.number).catch(() => null) })));
}

// ---------- rows ----------

interface StackRow {
  id: number;
  repo_id: number;
  owner: string;
  name: string;
  root_pr: number;
  base_ref: string;
  title: string;
  run_state: StackDetail["runState"];
  cross_state: "running" | "done" | "failed" | null;
  cross_error: string | null;
  summary_on: number;
  summary_text: string | null;
  posted_at: string | null;
  updated_at: string;
}

interface LayerRow {
  stack_id: number;
  pr_number: number;
  depth: number;
  parent_pr: number | null;
  title: string;
  author: string;
  head_ref: string;
  base_ref: string;
  head_sha: string;
  additions: number;
  deletions: number;
  is_draft: number;
  gh_state: "open" | "merged" | "closed";
  review_id: number | null;
  post_event: ReviewEvent | null;
  skipped: number;
}

const stackRow = (id: number) =>
  db.query("SELECT s.*, r.owner, r.name FROM stacks s JOIN repos r ON r.id = s.repo_id WHERE s.id = ?").get(id) as StackRow | null;
const layerRows = (id: number) => db.query("SELECT * FROM stack_layers WHERE stack_id = ?").all(id) as LayerRow[];
const touch = (id: number) => db.run("UPDATE stacks SET updated_at = datetime('now') WHERE id = ?", [id]);

/** Layers in stack order: base first, each child after its parent. */
function ordered(rows: LayerRow[]): LayerRow[] {
  const kids = new Map<number | null, LayerRow[]>();
  for (const r of rows) kids.set(r.parent_pr, [...(kids.get(r.parent_pr) ?? []), r]);
  const out: LayerRow[] = [];
  const known = new Set(rows.map((r) => r.pr_number));
  const visit = (r: LayerRow) => {
    out.push(r);
    for (const c of (kids.get(r.pr_number) ?? []).sort((a, b) => a.pr_number - b.pr_number)) visit(c);
  };
  // Roots: on the base branch, or whose parent left the stack (merged into the base).
  for (const r of rows.filter((x) => x.parent_pr === null || !known.has(x.parent_pr)).sort((a, b) => a.depth - b.depth || a.pr_number - b.pr_number)) visit(r);
  return out;
}

/** The stack running Review all that owns this review (as one of its layers), for the review page. */
export function runningStackFor(reviewId: number): { id: number; title: string; pos: number; size: number } | null {
  const s = db
    .query(
      `SELECT s.id, s.title FROM stack_layers l JOIN stacks s ON s.id = l.stack_id
       WHERE l.review_id = ? AND s.run_state = 'running' ORDER BY s.updated_at DESC LIMIT 1`,
    )
    .get(reviewId) as { id: number; title: string } | null;
  if (!s) return null;
  const layers = ordered(layerRows(s.id)).filter((l) => l.gh_state === "open");
  return { id: s.id, title: s.title, pos: layers.findIndex((l) => l.review_id === reviewId) + 1, size: layers.length };
}

// ---------- open / sync ----------

/** Finds (or creates) the stack a PR belongs to. `pr` can be a URL, owner/repo#n, or a number with `repo`. */
export async function openStack(input: { pr?: string | number; repo?: string; localPath?: string; branch?: string }): Promise<number> {
  let owner: string;
  let name: string;
  let number: number;
  if (input.localPath) {
    const { repo, root } = await checkoutInfo(input.localPath);
    const branch = input.branch ?? (await $`git rev-parse --abbrev-ref HEAD`.cwd(root).quiet().text()).trim();
    const n = await prForBranch(repo, branch);
    if (!n) throw new Error(`${branch} has no open PR, so it isn't part of a stack on GitHub. Push it and open a PR first.`);
    [owner, name] = repo.split("/") as [string, string];
    number = n;
  } else {
    if (input.pr === undefined) throw new Error("Which PR? Pass `pr`.");
    const ref = parsePrRef(String(input.pr), input.repo);
    ({ owner, repo: name, number } = ref);
  }
  const repo = `${owner}/${name}`;
  openCache.delete(repo);
  const tree = stackTree(await openPrs(repo), number);
  if (!tree) throw new Error(`#${number} isn't part of a stack: no open PR is based on it, and it isn't based on another open PR.`);
  const root = tree[0]!.pr;
  const repoId = upsertRepo(owner, name);
  const existing = db.query("SELECT id FROM stacks WHERE repo_id = ? AND root_pr = ?").get(repoId, root.number) as { id: number } | null;
  // The stack's name: the root PR's title is usually the feature ("Schema: …" layers aside).
  const id =
    existing?.id ??
    (db.query("INSERT INTO stacks (repo_id, root_pr, base_ref, title) VALUES (?, ?, ?, ?) RETURNING id").get(repoId, root.number, root.baseRefName, root.title) as {
      id: number;
    }).id;
  syncLayers(id, tree);
  return id;
}

/** Brings the layers in line with GitHub: new PRs join, left-behind ones are marked merged/closed. */
function syncLayers(id: number, tree: TreeNode[]) {
  const upsert = db.prepare(
    `INSERT INTO stack_layers (stack_id, pr_number, depth, parent_pr, title, author, head_ref, base_ref, head_sha, additions, deletions, is_draft, gh_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
     ON CONFLICT (stack_id, pr_number) DO UPDATE SET depth = excluded.depth, parent_pr = excluded.parent_pr, title = excluded.title,
       author = excluded.author, head_ref = excluded.head_ref, base_ref = excluded.base_ref, head_sha = excluded.head_sha,
       additions = excluded.additions, deletions = excluded.deletions, is_draft = excluded.is_draft, gh_state = 'open'`,
  );
  const inTree = new Set(tree.map((n) => n.pr.number));
  db.transaction(() => {
    for (const n of tree) {
      const p = n.pr;
      upsert.run(id, p.number, n.depth, n.parentPr, p.title, p.author ?? "unknown", p.headRefName, p.baseRefName, p.headRefOid ?? "", p.additions ?? 0, p.deletions ?? 0, p.isDraft ? 1 : 0);
    }
    for (const l of layerRows(id)) if (!inTree.has(l.pr_number) && l.gh_state === "open") db.run("UPDATE stack_layers SET gh_state = 'gone' WHERE stack_id = ? AND pr_number = ?", [id, l.pr_number]);
  })();
  linkReviews(id);
}

/** Each layer follows its PR's latest review (a re-review replaces the one before). */
function linkReviews(id: number) {
  const s = stackRow(id);
  if (!s) return;
  for (const l of layerRows(id)) {
    const latest = db
      .query(
        `SELECT v.id FROM reviews v WHERE v.repo_id = ? AND v.pr_number = ? ORDER BY v.id DESC LIMIT 1`,
      )
      .get(s.repo_id, l.pr_number) as { id: number } | null;
    if (latest && latest.id !== l.review_id) db.run("UPDATE stack_layers SET review_id = ? WHERE stack_id = ? AND pr_number = ?", [latest.id, id, l.pr_number]);
  }
}

const lastSync = new Map<number, number>();
/** Refreshes from GitHub at most every 30s; PRs that left the open list get their real state. */
async function refresh(id: number, force = false) {
  const s = stackRow(id);
  if (!s) throw new Error("Stack not found");
  if (!force && Date.now() - (lastSync.get(id) ?? 0) < OPEN_TTL_MS) return linkReviews(id);
  lastSync.set(id, Date.now());
  const repo = `${s.owner}/${s.name}`;
  if (force) openCache.delete(repo);
  const open = await openPrs(repo).catch(() => null);
  if (!open) return linkReviews(id);
  // Anchor on any layer that's still open (the root may have merged).
  const anchor = layerRows(id).find((l) => open.some((p) => p.number === l.pr_number));
  const tree = anchor ? stackTree(open, anchor.pr_number) : null;
  if (tree) syncLayers(id, tree);
  for (const l of layerRows(id).filter((x) => x.gh_state === ("gone" as LayerRow["gh_state"]))) {
    const state = await prView({ owner: s.owner, repo: s.name, number: l.pr_number }).then((p) => p.state.toLowerCase(), () => "closed");
    db.run("UPDATE stack_layers SET gh_state = ? WHERE stack_id = ? AND pr_number = ?", [state === "merged" ? "merged" : "closed", id, l.pr_number]);
  }
  linkReviews(id);
}

// ---------- layer state ----------

interface ReviewBits {
  id: number;
  phase: string;
  mode: "peer" | "self";
  head_sha: string;
  posted_event: string | null;
  review_summary: string | null;
  started_at: string | null;
}
const reviewBits = (id: number) =>
  db.query("SELECT id, phase, mode, head_sha, posted_event, review_summary, started_at FROM reviews WHERE id = ?").get(id) as ReviewBits | null;

function layerState(l: LayerRow, r: ReviewBits | null): LayerState {
  if (l.gh_state === "merged") return "merged";
  if (l.skipped) return "skipped";
  if (!r) return "waiting";
  const changed = Boolean(l.head_sha && r.head_sha && l.head_sha !== r.head_sha);
  switch (r.phase) {
    case "recon_running":
      return "scanning";
    case "recon_ready":
      return "readable";
    case "read":
    case "reviewing":
      return "reviewing";
    case "failed":
      return "failed";
    case "submitted":
      return changed ? "changed" : r.posted_event === "APPROVE" ? "approved" : "submitted";
    default:
      return changed ? "changed" : "decide";
  }
}

const RUNNING: LayerState[] = ["scanning", "readable", "reviewing"];
const DONE_REVIEWING: LayerState[] = ["decide", "submitted", "approved", "changed"];

/** Rough minutes for a layer's scan + deep review, from its size. */
const estimate = (l: LayerRow) => Math.min(15, Math.max(3, Math.round(2 + (l.additions + l.deletions) / 100)));

const changeNotes = new Map<string, string>();
async function changeNote(s: StackRow, l: LayerRow, r: ReviewBits): Promise<string> {
  const key = `${r.head_sha}...${l.head_sha}`;
  const hit = changeNotes.get(key);
  if (hit) return hit;
  const short = r.head_sha.slice(0, 8);
  const res = await $`gh api repos/${s.owner}/${s.name}/compare/${key} --jq ${"[.status, .ahead_by, ([.commits[].commit.message | split(\"\\n\")[0]] | join(\"\\u0000\"))] | @tsv"}`
    .quiet()
    .nothrow();
  let note = `New commits since \`${short}\`.`;
  if (res.exitCode === 0) {
    const [status, ahead, msgs] = res.stdout.toString().trim().split("\t");
    const titles = (msgs ?? "").split("\\u0000").filter(Boolean).slice(-3).map((m) => `“${m}”`);
    if (status === "ahead")
      note = `${ahead} new commit${ahead === "1" ? "" : "s"} since \`${short}\`${titles.length ? `: ${titles.join(", ")}` : ""}.`;
    else if (status === "diverged") note = `Rebased or force-pushed since \`${short}\`.`;
  }
  changeNotes.set(key, note);
  return note;
}

async function buildLayers(s: StackRow): Promise<StackLayer[]> {
  const me = await viewer().catch(() => null);
  const rows = ordered(layerRows(s.id));
  const crossCounts = new Map<number, number>();
  for (const f of db.query("SELECT prs_json FROM stack_findings WHERE stack_id = ?").all(s.id) as Array<{ prs_json: string }>)
    for (const pr of JSON.parse(f.prs_json) as number[]) crossCounts.set(pr, (crossCounts.get(pr) ?? 0) + 1);
  return Promise.all(
    rows.map(async (l) => {
      const r = l.review_id ? reviewBits(l.review_id) : null;
      const state = layerState(l, r);
      const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
      let total = 0;
      let decided = 0;
      if (r)
        for (const f of db
          .query("SELECT severity, decision FROM findings WHERE review_id = ? AND superseded_by IS NULL AND stack_finding_id IS NULL")
          .all(r.id) as Array<{ severity: Severity; decision: string | null }>) {
          counts[f.severity]++;
          total++;
          if (f.decision) decided++;
        }
      const kind = state === "scanning" || state === "readable" ? "recon" : "review";
      const last = r && RUNNING.includes(state) ? recentProgress(r.id, kind, 1)[0] : undefined;
      let note: string | null = null;
      if (state === "changed" && r) note = await changeNote(s, l, r);
      else if (state === "merged") note = `Merged into ${s.base_ref}. Its children now build on ${s.base_ref}.`;
      else if (state === "failed" && r) note = (db.query("SELECT error FROM reviews WHERE id = ?").get(r.id) as { error: string | null })?.error ?? "The review failed.";
      else if (l.gh_state === "closed") note = "Closed without merging.";
      return {
        pr: l.pr_number,
        title: l.title,
        author: l.author,
        headRef: l.head_ref,
        baseRef: l.base_ref,
        parentPr: l.parent_pr,
        depth: l.depth,
        additions: l.additions,
        deletions: l.deletions,
        isDraft: Boolean(l.is_draft),
        url: `https://github.com/${s.owner}/${s.name}/pull/${l.pr_number}`,
        mine: r ? r.mode === "self" : isMine(l.author, me),
        state,
        reviewId: r?.id ?? null,
        counts,
        total,
        decided,
        across: crossCounts.get(l.pr_number) ?? 0,
        summary: r?.review_summary ?? null,
        note,
        line: last ? { text: last.text, at: last.at } : null,
        startedAt: r?.started_at ?? null,
        skipped: Boolean(l.skipped),
      } satisfies StackLayer;
    }),
  );
}

// ---------- read ----------

const crossLines = new Map<number, Array<{ text: string; at: number }>>();

export async function getStack(id: number): Promise<StackDetail> {
  await refresh(id);
  const s = stackRow(id)!;
  const settings = getSettings();
  const layers = await buildLayers(s);
  const pending = layers.filter((l) => !l.skipped && (l.state === "waiting" || RUNNING.includes(l.state)));
  const rows = new Map(layerRows(id).map((r) => [r.pr_number, r]));
  const minutes = pending.reduce((n, l) => n + estimate(rows.get(l.pr)!), 0);
  const findings = stackFindings(id);
  return {
    id,
    repo: `${s.owner}/${s.name}`,
    baseRef: s.base_ref,
    title: s.title,
    layers,
    runState: s.run_state,
    cross: { state: s.cross_state ?? "pending", error: s.cross_error, findings, lines: crossLines.get(id) ?? [] },
    maxAll: settings.stackMaxAll,
    order: settings.stackOrder,
    concurrency: settings.stackConcurrency,
    minutesLeft: pending.length ? Math.max(1, Math.round(minutes / Math.max(1, settings.stackConcurrency))) : null,
    postedAt: s.posted_at,
    summaryOn: Boolean(s.summary_on),
    summaryText: s.summary_text ?? defaultSummary(layers),
    updatedAt: s.updated_at,
  };
}

function stackFindings(id: number): StackFinding[] {
  const rows = db.query("SELECT * FROM stack_findings WHERE stack_id = ? ORDER BY position").all(id) as Array<{
    id: number;
    kind: StackFinding["kind"];
    severity: Severity;
    lens: string | null;
    title: string;
    why: string;
    fix: string | null;
    fixed_note: string | null;
    fixed_in: number | null;
    prs_json: string;
    confidence: StackFinding["confidence"];
    agent_prompt: string | null;
  }>;
  return rows.map((r) => {
    const placements = db
      .query(
        `SELECT f.id AS findingId, f.review_id AS reviewId, v.pr_number AS pr, f.path, f.line, f.comment, f.decision, f.dismiss_reason AS dismissReason, f.soft
         FROM findings f JOIN reviews v ON v.id = f.review_id WHERE f.stack_finding_id = ? ORDER BY v.pr_number`,
      )
      .all(r.id) as Array<{ findingId: number; reviewId: number; pr: number; path: string | null; line: number | null; comment: string; decision: StackFinding["decision"]; dismissReason: string | null; soft: number }>;
    const first = placements[0];
    return {
      id: r.id,
      kind: r.kind,
      severity: r.severity,
      lens: r.lens,
      title: r.title,
      why: r.why,
      fix: r.fix,
      fixedNote: r.fixed_note,
      fixedIn: r.fixed_in,
      prs: JSON.parse(r.prs_json),
      confidence: r.confidence,
      agentPrompt: r.agent_prompt,
      placements: placements.map(({ decision, dismissReason, soft, ...p }) => p),
      decision: first?.decision ?? null,
      dismissReason: first?.dismissReason ?? null,
      soft: Boolean(first?.soft),
    };
  });
}

export function listStacks(): StackSummary[] {
  const rows = db
    .query("SELECT s.*, r.owner, r.name FROM stacks s JOIN repos r ON r.id = s.repo_id ORDER BY s.updated_at DESC LIMIT 20")
    .all() as StackRow[];
  return rows.map((s) => {
    const layers = ordered(layerRows(s.id));
    const states = layers.map((l) => layerState(l, l.review_id ? reviewBits(l.review_id) : null));
    const running = states.some((x) => RUNNING.includes(x)) || s.cross_state === "running";
    const active = layers.find((_, i) => RUNNING.includes(states[i]!));
    const ready = states.filter((x) => x === "decide").length;
    const changed = states.filter((x) => x === "changed").length;
    const detail = active
      ? `Reviewing #${active.pr_number} (${layers.indexOf(active) + 1} of ${layers.length})`
      : s.cross_state === "running"
        ? "Looking across the stack"
        : changed
          ? `${changed} PR${changed === 1 ? "" : "s"} changed since your review`
          : ready
            ? `${ready} PR${ready === 1 ? "" : "s"} ready to decide`
            : states.every((x) => x === "approved" || x === "merged")
              ? "Stack approved"
              : states.every((x) => x === "waiting")
                ? "Not started"
                : `${states.filter((x) => x === "submitted" || x === "approved").length} of ${layers.length} posted`;
    return {
      id: s.id,
      repo: `${s.owner}/${s.name}`,
      title: s.title,
      baseRef: s.base_ref,
      topRef: layers[layers.length - 1]?.head_ref ?? "",
      size: layers.length,
      states,
      runState: s.run_state,
      running,
      detail,
      updatedAt: s.updated_at,
    };
  });
}

// ---------- Review all ----------

export function setRunState(id: number, state: StackDetail["runState"]) {
  const s = stackRow(id);
  if (!s) throw new Error("Stack not found");
  if (state === "running") {
    const size = layerRows(id).filter((l) => l.gh_state === "open").length;
    const max = getSettings().stackMaxAll;
    if (size > max) throw new Error(`This stack has ${size} PRs, more than the Review all limit (${max}). Change it in Settings › Review › Stacks, or review each layer.`);
  }
  db.run("UPDATE stacks SET run_state = ?, updated_at = datetime('now') WHERE id = ?", [state, id]);
  if (state === "running") tickStack(id).catch((e) => console.warn(`stack ${id}:`, e));
}

export function skipLayer(id: number, pr: number, skip: boolean) {
  db.run("UPDATE stack_layers SET skipped = ? WHERE stack_id = ? AND pr_number = ?", [skip ? 1 : 0, id, pr]);
  touch(id);
}

/** Starts (or restarts) one layer: a fresh review if it failed, else whatever's next for it. */
export async function startLayer(id: number, pr: number): Promise<number> {
  const s = stackRow(id);
  if (!s) throw new Error("Stack not found");
  const l = layerRows(id).find((x) => x.pr_number === pr);
  if (!l) throw new Error(`#${pr} isn't in this stack`);
  linkReviews(id); // act on the PR's latest review, not a stale link
  const current = layerRows(id).find((x) => x.pr_number === pr)?.review_id ?? null;
  const r = current ? reviewBits(current) : null;
  // `fresh` never starts a second run: startReview returns the PR's running review if there is one.
  const reviewId = await startReview(`${s.owner}/${s.name}#${pr}`, undefined, { fresh: r?.phase === "failed" });
  db.run("UPDATE stack_layers SET review_id = ?, skipped = 0 WHERE stack_id = ? AND pr_number = ?", [reviewId, id, pr]);
  touch(id);
  return reviewId;
}

const ticking = new Set<number>();
/** One step of Review all: start what's next, up to the concurrency limit, and move scans on to deep reviews. */
async function tickStack(id: number) {
  if (ticking.has(id)) return;
  ticking.add(id);
  try {
    const s = stackRow(id);
    if (!s) return;
    // Follow each PR's latest review first, so a review started from the inbox is seen as this layer's run.
    linkReviews(id);
    const settings = getSettings();
    const layers = await buildLayers(s);
    const done = (l: StackLayer) => l.state === "merged" || (!settings.stackIncludeDone && (l.state === "approved" || l.state === "submitted"));
    const todo = layers.filter((l) => !l.skipped && !done(l) && l.state !== "failed" && l.state !== "decide" && l.state !== "changed" && l.state !== "submitted" && l.state !== "approved");
    const include = settings.stackIncludeDone ? layers.filter((l) => !l.skipped && (l.state === "approved" || l.state === "submitted")) : [];
    const queue = [...todo, ...include].sort((a, b) => (settings.stackOrder === "top" ? b.depth - a.depth : a.depth - b.depth));
    const running = s.run_state === "running";
    // During Review all, scans don't wait for "I've read it": they go straight on to the deep review.
    if (running)
      for (const l of layers)
        if (l.state === "readable" && l.reviewId && !l.skipped) {
          markRead(l.reviewId);
          startDeepReview(l.reviewId);
        }
    let inFlight = layers.filter((l) => RUNNING.includes(l.state)).length;
    for (const l of running ? queue : []) {
      if (inFlight >= settings.stackConcurrency) break;
      if (l.state !== "waiting" && !include.includes(l)) continue;
      // Returns the PR's running review instead of starting a second one (even with `fresh`).
      const reviewId = await startReview(`${s.owner}/${s.name}#${l.pr}`, undefined, { fresh: include.includes(l) });
      db.run("UPDATE stack_layers SET review_id = ? WHERE stack_id = ? AND pr_number = ?", [reviewId, id, l.pr]);
      inFlight++;
    }
    const stillGoing = inFlight > 0 || queue.some((l) => l.state === "waiting");
    if (!stillGoing && s.run_state === "running") db.run("UPDATE stacks SET run_state = 'idle', updated_at = datetime('now') WHERE id = ?", [id]);
    // Once every open layer has its own review, look across the stack (once per set of reviews).
    const reviewed = layers.filter((l) => !l.skipped && l.state !== "merged" && l.state !== "waiting");
    const allReviewed = reviewed.length >= 2 && reviewed.every((l) => DONE_REVIEWING.includes(l.state) || l.state === "failed") && reviewed.filter((l) => DONE_REVIEWING.includes(l.state)).length >= 2;
    if (allReviewed && !inFlight && s.cross_state === null) runCross(id).catch((e) => console.warn(`stack ${id} cross:`, e));
  } finally {
    ticking.delete(id);
  }
}

/** Runs Review all for every stack that's running, and the cross pass for any that's ready. */
export function startStackRunner() {
  const tick = () => {
    const ids = db.query("SELECT id FROM stacks WHERE run_state = 'running' OR cross_state IS NULL").all() as Array<{ id: number }>;
    for (const { id } of ids) tickStack(id).catch((e) => console.warn(`stack ${id}:`, e));
  };
  setInterval(tick, 3000).unref?.();
}

// ---------- changed layers ----------

/** Re-reviews every layer that changed since its review: a delta re-review for PRs, a re-run for yours. */
export async function rereviewChanged(id: number): Promise<number> {
  await refresh(id, true);
  const s = stackRow(id)!;
  const layers = await buildLayers(s);
  let n = 0;
  for (const l of layers.filter((x) => x.state === "changed" && x.reviewId)) {
    if (l.mine) rerunSelfReview(l.reviewId!);
    else {
      const next = await startRereview(l.reviewId!);
      db.run("UPDATE stack_layers SET review_id = ? WHERE stack_id = ? AND pr_number = ?", [next, id, l.pr]);
    }
    n++;
  }
  // The layers changed, so the look across the stack needs doing again.
  if (n) resetCross(id);
  touch(id);
  return n;
}

function resetCross(id: number) {
  db.transaction(() => {
    db.run("DELETE FROM stack_findings WHERE stack_id = ?", [id]); // cascades to their placements; superseded ones come back
    db.run("UPDATE stacks SET cross_state = NULL, cross_error = NULL WHERE id = ?", [id]);
  })();
}

// ---------- across the stack ----------

const LAYER_DIFF_LIMIT = 40_000;
const TOTAL_DIFF_LIMIT = 140_000;

export async function runCross(id: number) {
  const s = stackRow(id);
  if (!s) throw new Error("Stack not found");
  if (s.cross_state === "running") return;
  db.run("UPDATE stacks SET cross_state = 'running', cross_error = NULL, updated_at = datetime('now') WHERE id = ?", [id]);
  const lines: Array<{ text: string; at: number }> = [];
  crossLines.set(id, lines);
  const progress = (text: string) => {
    lines.push({ text, at: Date.now() });
    if (lines.length > 40) lines.shift();
  };
  try {
    const layers = (await buildLayers(s)).filter((l) => !l.skipped && l.reviewId && DONE_REVIEWING.includes(l.state));
    if (layers.length < 2) throw new Error("Needs at least two reviewed layers.");
    let budget = TOTAL_DIFF_LIMIT;
    const inputs: StackLayerInput[] = layers.map((l) => {
      const row = getRow(l.reviewId!)!;
      const diff = row.diff_text ?? "";
      const cap = Math.min(LAYER_DIFF_LIMIT, Math.max(4_000, budget));
      budget -= Math.min(diff.length, cap);
      const findings = db
        .query("SELECT id, severity, title, path, line, why FROM findings WHERE review_id = ? AND superseded_by IS NULL AND stack_finding_id IS NULL ORDER BY position")
        .all(l.reviewId!) as StackLayerInput["findings"];
      return {
        pr: l.pr,
        title: l.title,
        author: l.author,
        headRef: l.headRef,
        baseRef: l.baseRef,
        parentPr: l.parentPr,
        summary: l.summary,
        findings,
        diff: diff.slice(0, cap),
        diffTruncated: diff.length > cap,
      };
    });
    // The top layer's checkout has every layer's code.
    const top = layers.reduce((a, b) => (b.depth > a.depth ? b : a));
    const wt = await ensureWorktree(getRow(top.reviewId!)!);
    progress(`${agentName()} is reading ${layers.length} layers together`);
    const settings = getSettings();
    const res = await runAgent<StackOutput>({
      prompt: stackPrompt({ repo: `${s.owner}/${s.name}`, baseRef: s.base_ref, layers: inputs }),
      cwd: wt,
      model: settings.models.review,
      effort: settings.effort.review,
      ...readOnlyTools(wt),
      jsonSchema: STACK_SCHEMA,
      appendSystemPrompt: stackSystem(wt),
      maxTurns: settings.reviewMaxTurns,
      logName: `stack-${id}-cross`,
      onProgress: (p) => progress(p.text.replaceAll(`${wt}/`, "")),
    });
    if (res.isError || !res.structured) throw new Error(res.error ?? "The look across the stack didn't return a result.");
    saveCross(id, layers, res.structured);
    progress(`Found ${res.structured.findings.length} across the stack`);
    db.run("UPDATE stacks SET cross_state = 'done', updated_at = datetime('now') WHERE id = ?", [id]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    progress(`Failed: ${msg}`);
    db.run("UPDATE stacks SET cross_state = 'failed', cross_error = ?, updated_at = datetime('now') WHERE id = ?", [msg, id]);
  }
}

function saveCross(id: number, layers: StackLayer[], out: StackOutput) {
  const reviewOf = new Map(layers.map((l) => [l.pr, l]));
  const reviewIds = layers.map((l) => l.reviewId!);
  db.transaction(() => {
    db.run("DELETE FROM stack_findings WHERE stack_id = ?", [id]);
    out.findings.forEach((f, i) => {
      const prs = [...new Set(f.prs)].filter((pr) => reviewOf.has(pr));
      const placements = f.placements.filter((p) => {
        const l = reviewOf.get(p.pr);
        return l && l.state === "decide"; // only reviews that can still be posted
      });
      if (prs.length < 1 || !placements.length) return;
      const { id: sfId } = db
        .query(
          `INSERT INTO stack_findings (stack_id, position, kind, severity, lens, title, why, fix, fixed_note, fixed_in, prs_json, confidence, agent_prompt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(id, i, f.kind, f.severity, f.lens, f.title, f.why, f.fix, f.fixedNote, f.fixedIn, JSON.stringify(prs), f.confidence, f.prompt) as { id: number };
      for (const p of placements) {
        const reviewId = reviewOf.get(p.pr)!.reviewId!;
        const { n } = db.query("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM findings WHERE review_id = ?").get(reviewId) as { n: number };
        db.run(
          `INSERT INTO findings (review_id, position, severity, lens, title, path, line, side, why, fix, comment, confidence, anchorable, agent_prompt, stack_finding_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [reviewId, n, f.severity, f.lens, f.title, p.path, p.line, p.path && p.line ? "RIGHT" : null, f.why, f.fix, p.comment, f.confidence, p.path && p.line ? 1 : 0, f.prompt, sfId],
        );
      }
      // Findings this one covers aren't decided twice.
      const replaces = f.replaces.filter(Number.isInteger);
      if (replaces.length)
        db.run(
          `UPDATE findings SET superseded_by = ? WHERE id IN (${replaces.map(() => "?").join(",")}) AND review_id IN (${reviewIds.map(() => "?").join(",")})`,
          [sfId, ...replaces, ...reviewIds],
        );
    });
  })();
}

/** Re-runs the look across the stack (e.g. after it failed). */
export function rerunCross(id: number) {
  resetCross(id);
  runCross(id).catch((e) => console.warn(`stack ${id} cross:`, e));
}

// ---------- deciding stack findings ----------

/** A stack finding is decided once, for every PR it's posted on. */
export function decideStackFinding(stackFindingId: number, decision: "accepted" | "dismissed" | null, opts: { soft?: boolean; reason?: string | null } = {}) {
  const posted = db.query("SELECT COUNT(*) AS n FROM findings f JOIN reviews v ON v.id = f.review_id WHERE f.stack_finding_id = ? AND v.phase = 'submitted'").get(stackFindingId) as { n: number };
  if (posted.n) throw new Error("This finding is already posted on one of its PRs.");
  db.run(
    `UPDATE findings SET decision = ?, dismiss_reason = ?, soft = ?, decided_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END WHERE stack_finding_id = ?`,
    [decision, decision === "dismissed" ? (opts.reason ?? null) : null, decision === "accepted" && opts.soft ? 1 : 0, decision, stackFindingId],
  );
}

export function editStackComment(findingId: number, comment: string) {
  db.run("UPDATE findings SET comment = ? WHERE id = ? AND stack_finding_id IS NOT NULL", [comment.trim(), findingId]);
}

// ---------- submit ----------

export async function stackSubmission(id: number): Promise<StackSubmissionLayer[]> {
  const s = stackRow(id);
  if (!s) throw new Error("Stack not found");
  const layers = await buildLayers(s);
  const events = new Map(layerRows(id).map((l) => [l.pr_number, l.post_event]));
  return layers
    .filter((l) => l.reviewId && !l.skipped && l.state !== "merged")
    .map((l) => {
      const sub = buildSubmission(l.reviewId!);
      const openFindings = l.mine
        ? (db
            .query("SELECT COUNT(*) AS n FROM findings WHERE review_id = ? AND superseded_by IS NULL AND resolved_run IS NULL AND COALESCE(decision, '') != 'dismissed'")
            .get(l.reviewId!) as { n: number }).n
        : 0;
      return {
        pr: l.pr,
        reviewId: l.reviewId!,
        mine: l.mine,
        canPost: !l.mine && l.state === "decide",
        suggestedEvent: sub.suggestedEvent,
        event: events.get(l.pr) ?? sub.suggestedEvent,
        comments: sub.comments.length + (sub.body.includes("### Other notes") ? 1 : 0),
        undecided: sub.undecided,
        openFindings,
      };
    });
}

export function setLayerEvent(id: number, pr: number, event: ReviewEvent | null) {
  if (event !== null && !["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(event)) throw new Error("Invalid review type");
  db.run("UPDATE stack_layers SET post_event = ? WHERE stack_id = ? AND pr_number = ?", [event, id, pr]);
}

export function setSummary(id: number, on: boolean, text: string | null) {
  db.run("UPDATE stacks SET summary_on = ?, summary_text = ? WHERE id = ?", [on ? 1 : 0, text, id]);
}

const EVENT_LABEL: Record<ReviewEvent, string> = { COMMENT: "Commented", APPROVE: "Approved", REQUEST_CHANGES: "Changes requested" };

function defaultSummary(layers: StackLayer[]): string {
  const lines = layers
    .filter((l) => !l.skipped && l.state !== "merged")
    .map((l) => `- #${l.pr} ${l.title}${l.mine ? " (self-reviewed)" : ""}`);
  return `Reviewed this stack together, from the base up:\n${lines.join("\n")}\n\nEach PR has its own review with the details.`;
}

/**
 * Posts one GitHub review per postable layer, in stack order, then the optional summary comment on
 * the top PR. One failure doesn't stop the rest; each layer's result is returned.
 */
export async function postStack(id: number): Promise<Array<{ pr: number; ok: boolean; url?: string; error?: string }>> {
  const s = stackRow(id);
  if (!s) throw new Error("Stack not found");
  const subs = (await stackSubmission(id)).filter((x) => x.canPost);
  if (!subs.length) throw new Error("Nothing to post: no layer has a finished review that isn't posted yet.");
  const results: Array<{ pr: number; ok: boolean; url?: string; error?: string }> = [];
  for (const x of subs) {
    try {
      const sub = buildSubmission(x.reviewId);
      const body = sub.body || (x.event === "APPROVE" ? "" : "See the inline comments.");
      const { url } = await submit(x.reviewId, { event: x.event, body });
      results.push({ pr: x.pr, ok: true, url });
    } catch (e) {
      results.push({ pr: x.pr, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (s.summary_on) {
    const layers = await buildLayers(s);
    const top = [...layers].reverse().find((l) => l.state !== "merged");
    const outcome = new Map(subs.map((x) => [x.pr, EVENT_LABEL[x.event]]));
    const text = (s.summary_text ?? defaultSummary(layers)).replace(/^(- #(\d+) .*)$/gm, (line, _all, pr) => (outcome.has(Number(pr)) ? `${line}: ${outcome.get(Number(pr))}` : line));
    if (top) {
      const res = await $`gh pr comment ${String(top.pr)} -R ${`${s.owner}/${s.name}`} --body ${text}`.quiet().nothrow();
      if (res.exitCode !== 0) results.push({ pr: top.pr, ok: false, error: `Summary comment: ${res.stderr.toString().trim()}` });
    }
  }
  if (results.some((r) => r.ok)) db.run("UPDATE stacks SET posted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [id]);
  return results;
}
