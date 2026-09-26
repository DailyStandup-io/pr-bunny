// A self-review's pull request: found automatically for the branch, its state on GitHub (checks,
// reviews, whether it can merge), and the Ready check's GitHub writes: merge, mark ready. Reads
// run in the background (the page polls, and watchSelfPrs keeps the lists current); the writes
// only ever run from an explicit, confirmed click.
import { $ } from "bun";
import type { MergeMethod, SelfPr, SelfPrCheck, SelfPrReviewState } from "../shared/types";
import { snapshotOf } from "../shared/pr";
import { DATA_DIR } from "./config";
import { db } from "./db/db";
import { ghJson, remoteBranchSha, viewer } from "./gh";
import { emit } from "./live";
import { getRow, type ReviewRow } from "./reviews";

const FIELDS = [
  "number", "url", "title", "author", "state", "isDraft", "reviewDecision", "mergeable", "mergeStateStatus",
  "statusCheckRollup", "latestReviews", "reviewRequests", "baseRefName", "headRefName", "headRefOid", "commits",
  "createdAt", "mergedAt", "mergedBy", "mergeCommit", "closedAt", "isCrossRepository",
].join(",");

const repoOf = (row: ReviewRow) => `${row.owner}/${row.repo}`;
const linked = (row: ReviewRow) => row.pr_number || row.opened_pr_number || 0;
const parseUtc = (t: string) => Date.parse(t.includes("T") ? t : `${t.replace(" ", "T")}Z`);

/**
 * The PR for this self-review: the linked one, else an open PR for the branch, else one for the
 * branch that merged or closed after the review started. Links what it finds.
 */
async function findPr(row: ReviewRow): Promise<number | null> {
  const known = linked(row);
  if (known) return known;
  const prs = await ghJson<Array<{ number: number; state: string; mergedAt: string | null; closedAt: string | null }>>([
    "pr", "list", "-R", repoOf(row), "--head", row.head_ref, "--state", "all", "--limit", "10", "--json", "number,state,mergedAt,closedAt",
  ]).catch(() => []);
  const since = parseUtc(row.started_at);
  const pr = prs.find((p) => p.state === "OPEN") ?? prs.find((p) => (p.mergedAt ?? p.closedAt) && Date.parse((p.mergedAt ?? p.closedAt)!) >= since);
  if (!pr) return null;
  db.run("UPDATE reviews SET opened_pr_number = ? WHERE id = ?", [pr.number, row.id]);
  return pr.number;
}

const repoCache = new Map<string, { at: number; methods: MergeMethod[] }>();
async function mergeMethods(repo: string): Promise<MergeMethod[]> {
  const hit = repoCache.get(repo);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.methods;
  const r = await ghJson<{ allow_merge_commit?: boolean; allow_squash_merge?: boolean; allow_rebase_merge?: boolean }>(["api", `repos/${repo}`]).catch(() => null);
  // Without the settings (no access to them), offer all three and let GitHub say no.
  const methods = r
    ? (["merge", "squash", "rebase"] as const).filter((m) => (m === "merge" ? r.allow_merge_commit : m === "squash" ? r.allow_squash_merge : r.allow_rebase_merge) !== false)
    : (["merge", "squash", "rebase"] as MergeMethod[]);
  repoCache.set(repo, { at: Date.now(), methods: [...methods] });
  return [...methods];
}

function duration(from?: string | null, to?: string | null): string | null {
  if (!from || !to) return null;
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  if (!(s >= 0)) return null;
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function checksOf(rollup: any[]): SelfPrCheck[] {
  return (rollup ?? []).map((c: any): SelfPrCheck => {
    if (c.__typename === "StatusContext") {
      const st = String(c.state ?? "PENDING");
      return { name: c.context ?? "status", state: PASS.has(st) ? "pass" : FAIL.has(st) ? "fail" : "running", url: c.targetUrl ?? null, took: null };
    }
    const done = c.status === "COMPLETED";
    const concl = String(c.conclusion ?? "NEUTRAL");
    return {
      name: c.name ?? c.workflowName ?? "check",
      state: !done ? "running" : FAIL.has(concl) ? "fail" : "pass",
      url: c.detailsUrl ?? null,
      took: done ? duration(c.startedAt, c.completedAt) : null,
    };
  });
}

/** Commits on GitHub since the last run: 0, a count, or -1 when it changed but can't be counted. */
async function newCommits(row: ReviewRow, repo: string, head: string): Promise<number> {
  const seen = row.branch_sha ?? (row.dirty_files ? null : row.head_sha);
  if (!seen || seen === head) return 0;
  const r = await ghJson<{ ahead_by: number; behind_by: number }>(["api", `repos/${repo}/compare/${seen}...${head}`]).catch(() => null);
  return r && r.ahead_by > 0 && r.behind_by === 0 ? r.ahead_by : -1;
}

function protectionOf(raw: any, me: string): string | null {
  if (raw.mergeStateStatus === "BEHIND") return `Needs to be up to date with ${raw.baseRefName}`;
  if (raw.mergeStateStatus !== "BLOCKED") return null;
  if (raw.reviewDecision === "CHANGES_REQUESTED") {
    const who = (raw.latestReviews ?? []).filter((r: any) => r.state === "CHANGES_REQUESTED").map((r: any) => r.author?.login).filter((l: string) => l && l !== me);
    return who.length ? `Changes requested by ${who.join(", ")}` : "Changes requested";
  }
  if (raw.reviewDecision === "REVIEW_REQUIRED") return "Needs an approving review";
  return "Required conditions aren’t met yet";
}

function reviewsOf(raw: any, me: string, owner: string): SelfPr["reviews"] {
  const out = new Map<string, SelfPrReviewState>();
  for (const r of raw.latestReviews ?? []) {
    const h = r.author?.login;
    if (!h || h === me) continue;
    const st: SelfPrReviewState | null =
      r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "changes" : r.state === "COMMENTED" ? "commented" : null;
    if (st) out.set(h, st);
  }
  for (const q of raw.reviewRequests ?? []) {
    const h = q.login ?? (q.slug ? `@${q.organization?.login ?? owner}/${q.slug}` : q.name);
    if (h && h !== me) out.set(h, "requested");
  }
  return [...out].map(([h, st]) => ({ h, st }));
}

async function fetchPr(row: ReviewRow, number: number): Promise<SelfPr> {
  const repo = repoOf(row);
  const [raw, me, methods] = await Promise.all([ghJson<any>(["pr", "view", String(number), "-R", repo, "--json", FIELDS]), viewer().catch(() => ""), mergeMethods(repo)]);
  const state: SelfPr["state"] = raw.state === "MERGED" ? "merged" : raw.state === "CLOSED" ? "closed" : "open";
  const [commitsSince, branchGone] = await Promise.all([
    state === "open" ? newCommits(row, repo, raw.headRefOid) : Promise.resolve(0),
    state === "merged" && !raw.isCrossRepository ? remoteBranchSha(repo, raw.headRefName).then((sha) => !sha, () => null) : Promise.resolve(null),
  ]);
  return {
    number: raw.number,
    url: raw.url,
    title: raw.title,
    author: raw.author?.login ?? "",
    viewer: me,
    state,
    draft: !!raw.isDraft,
    decision: raw.reviewDecision || null,
    mergeable: raw.mergeable ?? "UNKNOWN",
    mergeStateStatus: raw.mergeStateStatus ?? "UNKNOWN",
    protection: protectionOf(raw, me),
    checks: checksOf(raw.statusCheckRollup),
    reviews: reviewsOf(raw, me, row.owner),
    base: raw.baseRefName,
    head: raw.headRefName,
    headSha: raw.headRefOid,
    commits: Array.isArray(raw.commits) ? raw.commits.length : 0,
    createdAt: raw.createdAt,
    newCommits: commitsSince,
    crossRepo: !!raw.isCrossRepository,
    mergedBy: raw.mergedBy?.login ?? null,
    mergedAt: raw.mergedAt ?? null,
    mergeCommit: raw.mergeCommit?.oid ?? null,
    branchDeleted: branchGone,
    closedAt: raw.closedAt ?? null,
    methods,
    fetchedAt: new Date().toISOString(),
  };
}

/** Saves what the lists show; tells open pages when the PR's state moved. */
function remember(row: ReviewRow, pr: SelfPr) {
  const snap = JSON.stringify(snapshotOf(pr));
  if (snap === row.pr_snap_json) return;
  db.run("UPDATE reviews SET pr_snap_json = ?, opened_pr_number = COALESCE(opened_pr_number, ?) WHERE id = ?", [snap, row.pr_number ? null : pr.number, row.id]);
  emit({ type: "phase", reviewId: row.id, phase: row.phase });
}

/** The self-review's PR as it is on GitHub now, or null if there isn't one yet. Only reads GitHub. */
export async function selfPr(reviewId: number): Promise<SelfPr | null> {
  const row = getRow(reviewId);
  if (!row) throw new Error("Review not found");
  if (row.mode !== "self") throw new Error("Only self-reviews track their PR here.");
  const number = await findPr(row);
  if (!number) return null;
  const pr = await fetchPr(row, number);
  remember(getRow(reviewId)!, pr);
  return pr;
}

// ---------- writes: explicit clicks only ----------

async function mine(reviewId: number): Promise<{ row: ReviewRow; pr: SelfPr }> {
  const row = getRow(reviewId);
  if (!row || row.mode !== "self") throw new Error("Only self-reviews can do this.");
  const number = linked(row);
  if (!number) throw new Error("There's no PR for this branch yet.");
  const pr = await fetchPr(row, number);
  if (!pr.viewer || pr.author !== pr.viewer) throw new Error(`#${pr.number} was opened by ${pr.author}, so PR Bunny leaves merging it to them.`);
  return { row, pr };
}

/**
 * "Merge pull request", after the confirm step. Merges exactly the commit you were shown
 * (--match-head-commit), then deletes the head branch on GitHub if you asked. gh runs outside any
 * checkout, so nothing local changes.
 */
export async function mergePr(reviewId: number, opts: { method: MergeMethod; deleteBranch: boolean; headSha: string }): Promise<SelfPr> {
  const { row, pr } = await mine(reviewId);
  if (pr.state !== "open") throw new Error(`#${pr.number} is already ${pr.state}.`);
  if (!pr.methods.includes(opts.method)) throw new Error(`${pr.url.split("/pull/")[0]!.replace("https://github.com/", "")} doesn't allow that merge method.`);
  if (opts.headSha && opts.headSha !== pr.headSha) throw new Error(`New commits were pushed to ${pr.head} since this page loaded. Check them, then merge again.`);
  const repo = repoOf(row);
  const res = await $`gh pr merge ${String(pr.number)} -R ${repo} ${`--${opts.method}`} --match-head-commit ${pr.headSha}`.cwd(DATA_DIR).quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`Merge failed: ${res.stderr.toString().trim() || res.stdout.toString().trim()}`);
  if (opts.deleteBranch && !pr.crossRepo) {
    // GitHub may already have deleted it (the repo's "automatically delete head branches").
    await $`gh api -X DELETE ${`repos/${repo}/git/refs/heads/${pr.head}`}`.cwd(DATA_DIR).quiet().nothrow();
  }
  // GitHub takes a moment to report the merge.
  let after = pr;
  for (let i = 0; i < 5; i++) {
    after = await fetchPr(getRow(reviewId)!, pr.number);
    if (after.state === "merged") break;
    await Bun.sleep(800);
  }
  remember(getRow(reviewId)!, after);
  return after;
}

/** "Mark ready for review" on a draft. */
export async function markReady(reviewId: number): Promise<SelfPr> {
  const { row, pr } = await mine(reviewId);
  if (!pr.draft) return pr;
  const res = await $`gh pr ready ${String(pr.number)} -R ${repoOf(row)}`.cwd(DATA_DIR).quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`Marking it ready failed: ${res.stderr.toString().trim()}`);
  const after = await fetchPr(getRow(reviewId)!, pr.number);
  remember(getRow(reviewId)!, after);
  return after;
}

// ---------- people to request a review from ----------

export interface Collaborator {
  h: string;
  sub: string;
  team: boolean;
}

const collabCache = new Map<string, { at: number; list: Collaborator[] }>();

/** People who can be asked to review (assignable users, with names) and the org's teams. */
export async function collaborators(reviewId: number): Promise<Collaborator[]> {
  const row = getRow(reviewId);
  if (!row) throw new Error("Review not found");
  const repo = repoOf(row);
  const hit = collabCache.get(repo);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){assignableUsers(first:100){nodes{login name}}}}`;
  const [users, teams] = await Promise.all([
    ghJson<any>(["api", "graphql", "-f", `query=${query}`, "-F", `owner=${row.owner}`, "-F", `name=${row.repo}`])
      .then((r) => (r.data?.repository?.assignableUsers?.nodes ?? []) as Array<{ login: string; name: string | null }>)
      .catch(() => []),
    ghJson<Array<{ slug: string; name: string; description: string | null }>>(["api", `orgs/${row.owner}/teams`, "--paginate"]).catch(() => []),
  ]);
  const list: Collaborator[] = [
    ...users.map((u) => ({ h: u.login, sub: u.name ?? "", team: false })),
    ...teams.map((t) => ({ h: `@${row.owner}/${t.slug}`, sub: t.name && t.name !== t.slug ? `Team · ${t.name}` : "Team", team: true })),
  ];
  collabCache.set(repo, { at: Date.now(), list });
  return list;
}

// ---------- keeping the lists current ----------

/**
 * Self-reviews from the last 30 days whose PR isn't merged or closed yet: refresh what the lists
 * show, so a PR that merges on GitHub moves to Done without opening it here. Read-only.
 */
export async function watchSelfPrs() {
  if (!db.query("SELECT 1 FROM onboarding WHERE id = 1").get()) return;
  const rows = db
    .query(
      `SELECT v.id FROM reviews v WHERE v.mode = 'self' AND v.cleared_at IS NULL AND v.phase = 'walkthrough'
         AND v.started_at > datetime('now', '-30 days')
         AND (v.pr_snap_json IS NULL OR json_extract(v.pr_snap_json, '$.state') = 'open')
       ORDER BY v.id DESC LIMIT 20`,
    )
    .all() as Array<{ id: number }>;
  for (const { id } of rows) {
    const row = getRow(id);
    // Unlinked branches are looked for only when they might have a PR: pushed, or linked before.
    if (!row || (!linked(row) && !(await remoteBranchSha(repoOf(row), row.head_ref).catch(() => null)))) continue;
    await selfPr(id).catch(() => {});
  }
}
