// Thin typed wrappers around the `gh` CLI. Read-only in this milestone.
import { $ } from "bun";
import type { InboxPr, MyPr, PrFile } from "../shared/types";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PrView {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  isDraft: boolean;
  state: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  files: PrFile[];
}

export interface OpenPr {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
}

/**
 * Accepts `https://github.com/o/r/pull/12`, `o/r#12`, or a bare `12` (resolved against
 * `defaultRepo`, typically the last repo reviewed).
 */
export function parsePrRef(input: string, defaultRepo?: string): PrRef {
  const s = input.trim();
  const url = s.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
  if (url) return { owner: url[1]!, repo: url[2]!, number: Number(url[3]) };
  const short = s.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (short) return { owner: short[1]!, repo: short[2]!, number: Number(short[3]) };
  const bare = s.match(/^#?(\d+)$/);
  if (bare) {
    if (!defaultRepo) throw new Error("Bare PR numbers need a repo — paste the full URL the first time.");
    const [owner, repo] = defaultRepo.split("/");
    return { owner: owner!, repo: repo!, number: Number(bare[1]) };
  }
  throw new Error(`Couldn't understand "${s}". Use a PR URL, owner/repo#123, or a number.`);
}

async function ghJson<T>(args: string[]): Promise<T> {
  const res = await $`gh ${args}`.quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${res.stderr.toString().trim()}`);
  return JSON.parse(res.stdout.toString()) as T;
}

export async function prView({ owner, repo, number }: PrRef): Promise<PrView> {
  const fields =
    "number,title,body,url,author,isDraft,state,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,labels,files";
  const raw = await ghJson<any>(["pr", "view", String(number), "-R", `${owner}/${repo}`, "--json", fields]);
  return {
    ...raw,
    body: raw.body ?? "",
    author: raw.author?.login ?? "unknown",
    labels: (raw.labels ?? []).map((l: { name: string }) => l.name),
    files: (raw.files ?? []).map((f: any) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
  };
}

export async function prDiff({ owner, repo, number }: PrRef): Promise<string> {
  const res = await $`gh pr diff ${number} -R ${`${owner}/${repo}`}`.quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`gh pr diff failed: ${res.stderr.toString().trim()}`);
  return res.stdout.toString();
}

export async function listOpenPrs(owner: string, repo: string): Promise<OpenPr[]> {
  return ghJson<OpenPr[]>([
    "pr", "list", "-R", `${owner}/${repo}`, "--state", "open", "--limit", "300",
    "--json", "number,title,headRefName,baseRefName",
  ]);
}

const INBOX_FIELDS = "number,title,author,url,updatedAt,isDraft";

const toInboxPr = (p: any, repo: string): InboxPr => ({
  repo,
  number: p.number,
  title: p.title,
  author: p.author?.login ?? "unknown",
  url: p.url,
  updatedAt: p.updatedAt,
  isDraft: p.isDraft,
});

export async function reviewInbox(): Promise<InboxPr[]> {
  const raw = await ghJson<any[]>([
    "search", "prs", "--review-requested=@me", "--state=open", "--limit", "50",
    "--json", `${INBOX_FIELDS},repository`,
  ]);
  return raw.map((p) => toInboxPr(p, p.repository.nameWithOwner));
}

/** Every open PR in one repo, most recently updated first. */
export async function repoOpenPrs(repo: string): Promise<InboxPr[]> {
  const raw = await ghJson<any[]>(["pr", "list", "-R", repo, "--state", "open", "--limit", "100", "--json", INBOX_FIELDS]);
  return raw.map((p) => toInboxPr(p, repo)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Free-text search over open PRs, limited to the given repos. */
export async function searchOpenPrs(query: string, repos: string[]): Promise<InboxPr[]> {
  if (!repos.length) return [];
  const raw = await ghJson<any[]>([
    "search", "prs", "--state=open", "--limit", "20", ...repos.flatMap((r) => ["--repo", r]),
    "--json", `${INBOX_FIELDS},repository`, "--", query,
  ]);
  return raw.map((p) => toInboxPr(p, p.repository.nameWithOwner));
}

const SAFE_NAME = /^[\w.-]+$/;

/**
 * Who requested your review on each PR, and when: the latest review-request event naming you (or
 * a team), in one GraphQL round trip. Keyed `owner/name#number`.
 */
export async function reviewRequests(prs: Array<{ repo: string; number: number }>, me: string): Promise<Record<string, { by: string; at: string }>> {
  const valid = prs.filter((p) => p.repo.split("/").every((x) => SAFE_NAME.test(x))).slice(0, 40);
  if (!valid.length) return {};
  const fields = valid
    .map((p, i) => {
      const [owner, name] = p.repo.split("/");
      return `p${i}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${Math.trunc(p.number)}) {
        timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 10) { nodes { ... on ReviewRequestedEvent {
          createdAt actor { login } requestedReviewer { ... on User { login } ... on Team { slug } } } } } } }`;
    })
    .join("\n");
  const res = await $`gh api graphql -f ${`query=query { ${fields} }`}`.quiet().nothrow();
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(res.stdout.toString()).data ?? {};
  } catch {}
  const out: Record<string, { by: string; at: string }> = {};
  valid.forEach((p, i) => {
    const nodes: any[] = data[`p${i}`]?.pullRequest?.timelineItems?.nodes ?? [];
    const events = nodes.filter((n) => n?.actor?.login);
    const mine = [...events].reverse().find((n) => n.requestedReviewer?.login?.toLowerCase() === me.toLowerCase()) ?? events.at(-1);
    if (mine) out[`${p.repo}#${p.number}`] = { by: mine.actor.login, at: mine.createdAt };
  });
  return out;
}

/** Open PR counts for many repos in one GraphQL round trip. Repos GitHub can't resolve are left out. */
export async function openPrCounts(repos: string[]): Promise<Record<string, number>> {
  const valid = repos.filter((r) => r.split("/").length === 2 && r.split("/").every((x) => SAFE_NAME.test(x)));
  if (!valid.length) return {};
  const fields = valid
    .map((r, i) => {
      const [owner, name] = r.split("/");
      return `r${i}: repository(owner: "${owner}", name: "${name}") { pullRequests(states: OPEN) { totalCount } }`;
    })
    .join("\n");
  // Partial errors (e.g. a deleted repo) still return data for the rest, so don't fail on exit code.
  const res = await $`gh api graphql -f ${`query=query { ${fields} }`}`.quiet().nothrow();
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(res.stdout.toString()).data ?? {};
  } catch {}
  const out: Record<string, number> = {};
  valid.forEach((r, i) => {
    const n = data[`r${i}`]?.pullRequests?.totalCount;
    if (typeof n === "number") out[r] = n;
  });
  return out;
}

/** Your open PRs in a repo (drafts included), newest first. */
export async function myOpenPrs(repo: string): Promise<MyPr[]> {
  return ghJson<MyPr[]>(["pr", "list", "-R", repo, "--author", "@me", "--state", "open", "--limit", "20", "--json", "number,title,isDraft,headRefName,updatedAt,url"]);
}

/** Logins of recent committers to a file on the default branch, most recent first. */
export async function recentCommitters(repo: string, path: string): Promise<string[]> {
  const raw = await ghJson<any[]>(["api", `repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=20`]).catch(() => []);
  return raw.map((c) => c.author?.login).filter((l): l is string => typeof l === "string" && !l.endsWith("[bot]"));
}

/** The branch's tip on GitHub, or null if it hasn't been pushed. */
export async function remoteBranchSha(repo: string, branch: string): Promise<string | null> {
  const res = await $`gh api ${`repos/${repo}/branches/${encodeURIComponent(branch)}`} --jq .commit.sha`.quiet().nothrow();
  return res.exitCode === 0 ? res.stdout.toString().trim() || null : null;
}

export async function prForBranch(repo: string, branch: string): Promise<number | null> {
  const prs = await ghJson<Array<{ number: number }>>(["pr", "list", "-R", repo, "--head", branch, "--state", "open", "--json", "number"]).catch(() => []);
  return prs[0]?.number ?? null;
}

// ---------- status + writes (only ever called from an explicit user action) ----------

let viewerLogin: string | null = null;
export async function viewer(): Promise<string> {
  viewerLogin ??= (await ghJson<{ login: string }>(["api", "user"])).login;
  return viewerLogin;
}

export interface RawStatus {
  state: string;
  isDraft: boolean;
  headRefOid: string;
  reviewDecision: string | null;
  mergeable: string;
  mergeStateStatus: string;
  checks: Array<{ name: string; state: string; url: string | null }>;
  reviews: Array<{ author: string; state: string; submittedAt: string }>;
}

export async function prStatus({ owner, repo, number }: PrRef): Promise<RawStatus> {
  const raw = await ghJson<any>([
    "pr", "view", String(number), "-R", `${owner}/${repo}`, "--json",
    "state,isDraft,headRefOid,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,latestReviews",
  ]);
  const checks = (raw.statusCheckRollup ?? []).map((c: any) =>
    c.__typename === "StatusContext"
      ? { name: c.context, state: c.state ?? "PENDING", url: c.targetUrl ?? null }
      : { name: c.name ?? c.workflowName ?? "check", state: c.status === "COMPLETED" ? (c.conclusion ?? "NEUTRAL") : (c.status ?? "PENDING"), url: c.detailsUrl ?? null },
  );
  return {
    state: raw.state,
    isDraft: raw.isDraft,
    headRefOid: raw.headRefOid,
    reviewDecision: raw.reviewDecision || null,
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
    checks,
    reviews: (raw.latestReviews ?? []).map((r: any) => ({ author: r.author?.login ?? "?", state: r.state, submittedAt: r.submittedAt })),
  };
}

export interface ReviewPayload {
  commit_id: string;
  body: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  comments: Array<{ path: string; line: number; side: "RIGHT" | "LEFT"; start_line?: number; start_side?: "RIGHT" | "LEFT"; body: string }>;
}

/** Posts one review (all inline comments + body) so the author gets a single notification. */
export async function postReview({ owner, repo, number }: PrRef, payload: ReviewPayload): Promise<{ id: number; html_url: string }> {
  const proc = Bun.spawn(["gh", "api", `repos/${owner}/${repo}/pulls/${number}/reviews`, "--method", "POST", "--input", "-"], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    let detail = err.trim();
    try {
      const j = JSON.parse(out);
      detail = [j.message, ...(j.errors ?? []).map((e: any) => (typeof e === "string" ? e : e.message ?? JSON.stringify(e)))].filter(Boolean).join(" — ") || detail;
    } catch {}
    throw new Error(`GitHub rejected the review: ${detail}`);
  }
  return JSON.parse(out);
}

/** Opens a PR for a pushed branch with the given reviewers. Only from an explicit click. */
export async function createPr(repo: string, opts: { head: string; base: string; reviewers: string[] }): Promise<number> {
  const args = ["pr", "create", "-R", repo, "--head", opts.head, "--base", opts.base, "--fill"];
  for (const r of opts.reviewers) args.push("--reviewer", r.replace(/^@/, ""));
  const res = await $`gh ${args}`.quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`gh pr create failed: ${res.stderr.toString().trim()}`);
  const n = res.stdout.toString().match(/\/pull\/(\d+)/)?.[1];
  if (!n) throw new Error("gh pr create didn't return a PR URL");
  return Number(n);
}

export async function addReviewers(repo: string, number: number, reviewers: string[]): Promise<void> {
  if (!reviewers.length) return;
  const args = ["pr", "edit", String(number), "-R", repo];
  for (const r of reviewers) args.push("--add-reviewer", r.replace(/^@/, ""));
  const res = await $`gh ${args}`.quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`Adding reviewers failed: ${res.stderr.toString().trim()}`);
}

export async function approvePr({ owner, repo, number }: PrRef, body?: string): Promise<void> {
  const args = ["pr", "review", String(number), "-R", `${owner}/${repo}`, "--approve"];
  if (body?.trim()) args.push("--body", body.trim());
  const res = await $`gh ${args}`.quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`Approve failed: ${res.stderr.toString().trim()}`);
}
