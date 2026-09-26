// The fake `gh` (src/mock/bin/gh): every command shape PR Bunny runs, answered from the fixtures.
// Reads come from the fictional world; writes (posting a review, approving, commenting, opening a
// PR, adding reviewers) are only appended to <mock state>/gh-writes.jsonl. Anything else exits 1
// with "mock gh: unsupported: …" so gaps are obvious.
import { $ } from "bun";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRANCHES,
  findBranch,
  findPr,
  findRepo,
  minutesAgoIso,
  prsOf,
  PRS,
  prUrl,
  prViewJson,
  REPOS,
  repoName,
  VIEWER,
  type FixturePr,
  type ShaMap,
} from "./fixtures";
import { cloneRepo, ensureOrigins, mockStateDir, originPath } from "./git";

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

const ok = (out: unknown): GhResult => ({ code: 0, stdout: typeof out === "string" ? out : `${JSON.stringify(out, null, 2)}\n`, stderr: "" });
const fail = (stderr: string, code = 1): GhResult => ({ code, stdout: "", stderr: `${stderr}\n` });
const unsupported = (args: string[]) => fail(`mock gh: unsupported: gh ${args.join(" ")}`);

// ---------- args ----------

/** Value of `--name value` or `--name=value` (also a short alias like `-R`). */
function flag(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n) return args[i + 1];
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return undefined;
}
function flags(args: string[], ...names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n && args[i + 1] !== undefined) out.push(args[++i]!);
      else if (a.startsWith(`${n}=`)) out.push(a.slice(n.length + 1));
    }
  }
  return out;
}
const has = (args: string[], name: string) => args.includes(name) || args.some((a) => a.startsWith(`${name}=`));
/** Positional arguments (skipping flags and their values) after the subcommand words. */
function positionals(args: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (a.startsWith("-")) {
      if (!a.includes("=") && valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const pick = (obj: Record<string, unknown>, fields: string | undefined) =>
  fields ? Object.fromEntries(fields.split(",").map((f) => [f.trim(), obj[f.trim()] ?? null])) : obj;

// ---------- state: SHAs and the write log ----------

const writeLog = () => join(mockStateDir(), "gh-writes.jsonl");

export interface GhWrite {
  at: string;
  kind: "review" | "approve" | "comment" | "pr-create" | "add-reviewers";
  repo: string;
  pr: number;
  [key: string]: unknown;
}

export function readWrites(): GhWrite[] {
  const file = writeLog();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GhWrite);
}

function logWrite(w: Omit<GhWrite, "at">): GhWrite {
  const entry = { at: new Date().toISOString(), ...w } as GhWrite;
  appendFileSync(writeLog(), `${JSON.stringify(entry)}\n`);
  return entry;
}

/** PRs opened through `gh pr create` in this demo, as fixture PRs (from the branch they were opened for). */
function createdPrs(): FixturePr[] {
  return readWrites()
    .filter((w) => w.kind === "pr-create")
    .flatMap((w) => {
      const b = findBranch(w.repo, String(w.head));
      if (!b) return [];
      return [
        {
          repo: b.repo,
          number: w.pr,
          title: b.commits[0]!.message,
          body: b.commits.map((c) => `- ${c.message}`).join("\n"),
          author: VIEWER.login,
          branch: b.branch,
          base: String(w.base ?? b.base),
          state: "OPEN" as const,
          updatedMinutesAgo: Math.max(0, Math.round((Date.now() - Date.parse(w.at)) / 60_000)),
          commits: b.commits,
        },
      ];
    });
}

const allPrs = () => [...PRS, ...createdPrs()];
const prOf = (repo: string, n: number) => findPr(repo, n) ?? createdPrs().find((p) => p.repo === repo && p.number === n) ?? null;

async function shas(): Promise<ShaMap> {
  const map = { ...(await ensureOrigins()) };
  for (const p of createdPrs()) map[`${p.repo}#${p.number}`] = map[`${p.repo}:${p.branch}`] ?? "";
  return map;
}

/** Reviews the viewer posted through this fake, shown back in `pr view`'s latestReviews. */
function postedReviews(repo: string, n: number) {
  return readWrites()
    .filter((w) => w.repo === repo && w.pr === n && (w.kind === "review" || w.kind === "approve"))
    .map((w) => ({
      author: VIEWER.login,
      state: w.kind === "approve" ? "APPROVED" : ({ APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED" } as Record<string, string>)[String((w.payload as any)?.event)] ?? "COMMENTED",
      submittedAt: w.at,
    }));
}

async function viewJson(pr: FixturePr) {
  return prViewJson(pr, Date.now(), await shas(), postedReviews(pr.repo, pr.number));
}

const noPr = (repo: string, n: string) => fail(`GraphQL: Could not resolve to a PullRequest with the number of ${n}. (repository.pullRequest)`);
const noRepo = (repo: string) => fail(`GraphQL: Could not resolve to a Repository with the name '${repo}'. (repository)`);

// ---------- commands ----------

async function pr(args: string[], stdin: string): Promise<GhResult> {
  const sub = args[1];
  const repo = flag(args, "-R", "--repo") ?? "";
  if (repo && !findRepo(repo)) return noRepo(repo);
  const valueFlags = ["-R", "--repo", "--json", "--state", "--limit", "--author", "--head", "--base", "--reviewer", "--add-reviewer", "--body", "--jq", "--template"];
  const [, , num] = positionals(args, valueFlags);

  if (sub === "view" || sub === "diff") {
    if (!repo || !num) return unsupported(args);
    const p = prOf(repo, Number(num.replace(/^#/, "")));
    if (!p) return noPr(repo, num);
    if (sub === "diff") {
      const { prChange } = await import("./fixtures");
      return ok(prChange(p).diff);
    }
    return ok(pick(await viewJson(p), flag(args, "--json")));
  }

  if (sub === "list") {
    if (!repo) return unsupported(args);
    const state = (flag(args, "--state") ?? "open").toUpperCase();
    const author = flag(args, "--author");
    const head = flag(args, "--head");
    const limit = Number(flag(args, "--limit") ?? 30);
    const list = allPrs()
      .filter((p) => p.repo === repo && (state === "ALL" || p.state === state))
      .filter((p) => !author || p.author === (author === "@me" ? VIEWER.login : author))
      .filter((p) => !head || p.branch === head)
      .sort((a, b) => a.updatedMinutesAgo - b.updatedMinutesAgo)
      .slice(0, limit);
    const fields = flag(args, "--json");
    return ok(await Promise.all(list.map(async (p) => pick(await viewJson(p), fields))));
  }

  if (sub === "create") {
    const headRef = flag(args, "--head");
    const base = flag(args, "--base");
    if (!repo || !headRef || !base) return unsupported(args);
    const b = findBranch(repo, headRef);
    if (!b || !b.pushed) return fail(`pull request create failed: GraphQL: Head sha can't be blank, No commits between ${base} and ${headRef} (createPullRequest)`);
    const existing = allPrs().find((p) => p.repo === repo && p.branch === headRef && p.state === "OPEN");
    if (existing) return fail(`a pull request for branch "${headRef}" into branch "${base}" already exists:\n${prUrl(existing)}`);
    const number = Math.max(...allPrs().filter((p) => p.repo === repo).map((p) => p.number)) + 1;
    logWrite({ kind: "pr-create", repo, pr: number, head: headRef, base, reviewers: flags(args, "--reviewer"), fill: has(args, "--fill") });
    return ok(`${prUrl({ repo, number })}\n`);
  }

  if (sub === "edit") {
    const reviewers = flags(args, "--add-reviewer");
    if (!repo || !num || !reviewers.length) return unsupported(args);
    if (!prOf(repo, Number(num))) return noPr(repo, num);
    logWrite({ kind: "add-reviewers", repo, pr: Number(num), reviewers });
    return ok(`${prUrl({ repo, number: Number(num) })}\n`);
  }

  if (sub === "review") {
    if (!repo || !num || !has(args, "--approve")) return unsupported(args);
    if (!prOf(repo, Number(num))) return noPr(repo, num);
    logWrite({ kind: "approve", repo, pr: Number(num), body: flag(args, "--body") ?? "" });
    return { code: 0, stdout: "", stderr: `✓ Approved pull request ${repo}#${num}\n` };
  }

  if (sub === "comment") {
    const body = flag(args, "--body");
    if (!repo || !num || body === undefined) return unsupported(args);
    if (!prOf(repo, Number(num))) return noPr(repo, num);
    logWrite({ kind: "comment", repo, pr: Number(num), body });
    return ok(`${prUrl({ repo, number: Number(num) })}#issuecomment-${4200000 + readWrites().length}\n`);
  }

  return unsupported(args);
}

async function search(args: string[]): Promise<GhResult> {
  if (args[1] !== "prs") return unsupported(args);
  const state = (flag(args, "--state") ?? "open").toUpperCase();
  const repos = flags(args, "--repo", "-R").map((r) => r.toLowerCase());
  const requested = flag(args, "--review-requested");
  const assignee = flag(args, "--assignee");
  const limit = Number(flag(args, "--limit", "-L") ?? 30);
  const dash = args.indexOf("--");
  const words = (dash >= 0 ? args.slice(dash + 1) : positionals(args.slice(2), ["--json", "--limit", "-L", "--repo", "-R", "--state"]))
    .join(" ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const now = Date.now();
  const list = allPrs()
    .filter((p) => state === "ALL" || p.state === state)
    .filter((p) => !repos.length || repos.includes(p.repo.toLowerCase()))
    .filter((p) => !requested || (requested === "@me" || requested === VIEWER.login ? Boolean(p.requestedBy) : false))
    .filter((p) => !assignee || (assignee === "@me" || assignee === VIEWER.login ? Boolean(p.assigned) : false))
    .filter((p) => words.every((w) => `${p.title} ${p.body} ${p.number} ${p.author} ${p.branch}`.toLowerCase().includes(w.replace(/^#/, ""))))
    .sort((a, b) => a.updatedMinutesAgo - b.updatedMinutesAgo)
    .slice(0, limit)
    .map((p) => ({
      number: p.number,
      title: p.title,
      body: p.body,
      author: { login: p.author, type: p.author.endsWith("[bot]") ? "Bot" : "User" },
      url: prUrl(p),
      updatedAt: minutesAgoIso(p.updatedMinutesAgo, now),
      createdAt: minutesAgoIso(p.updatedMinutesAgo + 180, now),
      isDraft: Boolean(p.draft),
      state: p.state.toLowerCase(),
      labels: (p.labels ?? []).map((name) => ({ name })),
      repository: { name: p.repo.split("/")[1], nameWithOwner: p.repo },
    }));
  return ok(list.map((p) => pick(p, flag(args, "--json"))));
}

/** `gh api graphql -f query=…`: the four queries PR Bunny sends, recognised by their aliases and selections. */
async function graphql(args: string[]): Promise<GhResult> {
  const query = flags(args, "-f", "--raw-field", "-F", "--field").find((f) => f.startsWith("query="))?.slice(6);
  if (!query) return unsupported(args);
  const now = Date.now();

  if (/viewer\s*\{\s*login\s+pullRequests/.test(query)) {
    const nodes = allPrs()
      .filter((p) => p.author === VIEWER.login && p.state === "OPEN")
      .sort((a, b) => a.updatedMinutesAgo - b.updatedMinutesAgo)
      .map((p) => ({
        number: p.number,
        title: p.title,
        url: prUrl(p),
        repository: { nameWithOwner: p.repo },
        reviews: {
          nodes: (p.github?.reviews ?? []).map((r, i) => ({
            id: `PRR_${Buffer.from(`${p.repo}#${p.number}:${i}`).toString("base64url")}`,
            state: r.state,
            submittedAt: minutesAgoIso(r.minutesAgo, now),
            author: { login: r.author },
            comments: { totalCount: r.comments },
          })),
        },
      }));
    return ok({ data: { viewer: { login: VIEWER.login, pullRequests: { nodes } } } });
  }

  const aliases = [...query.matchAll(/(\w+):\s*repository\(owner:\s*"([^"]+)",\s*name:\s*"([^"]+)"\)\s*\{\s*(pullRequests?)(?:\((?:number:\s*(\d+)|states:\s*OPEN)\))?/g)];
  if (!aliases.length) return unsupported(args);
  const map = await shas();
  const data: Record<string, unknown> = {};
  const errors: unknown[] = [];
  for (const [, alias, owner, name, kind, num] of aliases) {
    const repo = `${owner}/${name}`;
    if (!findRepo(repo)) {
      data[alias!] = null;
      errors.push({ type: "NOT_FOUND", path: [alias], message: `Could not resolve to a Repository with the name '${repo}'.` });
      continue;
    }
    if (kind === "pullRequests") {
      data[alias!] = { pullRequests: { totalCount: allPrs().filter((p) => p.repo === repo && p.state === "OPEN").length } };
      continue;
    }
    const p = prOf(repo, Number(num));
    if (!p) {
      data[alias!] = { pullRequest: null };
      errors.push({ type: "NOT_FOUND", path: [alias, "pullRequest"], message: `Could not resolve to a PullRequest with the number of ${num}.` });
      continue;
    }
    if (query.includes("timelineItems")) {
      const nodes = p.requestedBy
        ? [{ createdAt: minutesAgoIso(p.requestedMinutesAgo ?? p.updatedMinutesAgo, now), actor: { login: p.requestedBy }, requestedReviewer: { login: VIEWER.login } }]
        : [];
      data[alias!] = { pullRequest: { timelineItems: { nodes } } };
    } else {
      data[alias!] = { pullRequest: { headRefOid: map[`${repo}#${p.number}`] ?? "", state: p.state, title: p.title } };
    }
  }
  return ok(errors.length ? { data, errors } : { data });
}

/** A tiny `--jq` for the plain paths the app uses (e.g. `.commit.sha`). */
function jq(value: unknown, expr: string | undefined): GhResult | null {
  if (!expr) return null;
  if (!/^(\.[\w]+)+$/.test(expr)) return null;
  let v: any = value;
  for (const key of expr.slice(1).split(".")) v = v?.[key];
  return ok(v == null ? "\n" : typeof v === "string" ? `${v}\n` : `${JSON.stringify(v)}\n`);
}

async function api(args: string[], stdin: string): Promise<GhResult> {
  const endpoint = args[1] ?? "";
  if (endpoint === "graphql") return graphql(args);
  if (endpoint === "user") {
    const user = { login: VIEWER.login, id: 7100001, name: VIEWER.name, email: VIEWER.email, type: "User", company: "Quokka Labs", html_url: `https://github.com/${VIEWER.login}` };
    return jq(user, flag(args, "--jq", "-q")) ?? ok(user);
  }

  const m = endpoint.replace(/^\//, "").match(/^repos\/([\w.-]+)\/([\w.-]+)\/(.+)$/);
  if (!m) return unsupported(args);
  const repo = `${m[1]}/${m[2]}`;
  const rest = m[3]!;
  const fixture = findRepo(repo);
  if (!fixture) return fail(`gh: Not Found (HTTP 404)`);

  // POST repos/o/r/pulls/N/reviews --input -  (the one review per submit)
  const review = rest.match(/^pulls\/(\d+)\/reviews$/);
  if (review && (flag(args, "--method", "-X") ?? "GET").toUpperCase() === "POST") {
    const n = Number(review[1]);
    if (!prOf(repo, n)) return fail(`gh: Not Found (HTTP 404)`);
    let payload: unknown;
    try {
      payload = JSON.parse(stdin || "{}");
    } catch {
      return fail("gh: Problems parsing JSON (HTTP 400)");
    }
    logWrite({ kind: "review", repo, pr: n, payload });
    const id = 3100000 + readWrites().length;
    const event = String((payload as any)?.event ?? "COMMENT");
    return ok({ id, node_id: `PRR_mock${id}`, state: event === "APPROVE" ? "APPROVED" : event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED", html_url: `${prUrl({ repo, number: n })}#pullrequestreview-${id}`, user: { login: VIEWER.login } });
  }

  // GET repos/o/r/commits?path=…&per_page=20 (suggested reviewers)
  if (rest.startsWith("commits")) {
    const path = decodeURIComponent(new URLSearchParams(rest.split("?")[1] ?? "").get("path") ?? "");
    const touched = PRS.filter((p) => p.repo === repo && p.state === "MERGED" && p.commits.some((c) => c.edits.some((e) => e.path === path || path.startsWith(e.path.split("/").slice(0, -1).join("/")))));
    const logins = [...touched.map((p) => p.author), ...fixture.committers];
    const now = Date.now();
    return ok(
      logins.slice(0, 20).map((login, i) => ({
        sha: `${i}`.padStart(40, "a"),
        commit: { message: `Update ${path}`, author: { name: login, date: minutesAgoIso(60 * 24 * (i + 1), now) } },
        author: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
      })),
    );
  }

  // GET repos/o/r/branches/<branch> [--jq .commit.sha] (is the branch pushed?)
  const branch = rest.match(/^branches\/(.+)$/);
  if (branch) {
    const name = decodeURIComponent(branch[1]!);
    const sha = (await shas())[`${repo}:${name}`];
    const pushed = sha && (name === fixture.defaultBranch || PRS.some((p) => p.repo === repo && p.branch === name) || BRANCHES.some((b) => b.repo === repo && b.branch === name && b.pushed));
    if (!pushed) return fail("gh: Branch not found (HTTP 404)");
    const body = { name, commit: { sha, url: `https://api.github.com/repos/${repo}/commits/${sha}` }, protected: name === fixture.defaultBranch };
    return jq(body, flag(args, "--jq", "-q")) ?? ok(body);
  }

  // GET repos/o/r/compare/a...b --jq '[.status, .ahead_by, (commit titles joined)] | @tsv' (stack change notes)
  const compare = rest.match(/^compare\/([0-9a-f]{7,40})\.\.\.([0-9a-f]{7,40})$/);
  if (compare) {
    const bare = originPath(mockStateDir(), repo);
    const [from, to] = [compare[1]!, compare[2]!];
    const count = async (range: string) => Number((await $`git rev-list --count ${range}`.cwd(bare).quiet().nothrow()).stdout.toString().trim()) || 0;
    const ahead = await count(`${from}..${to}`);
    const behind = await count(`${to}..${from}`);
    const status = ahead && behind ? "diverged" : ahead ? "ahead" : behind ? "behind" : "identical";
    const titles = (await $`git log --reverse --format=%s ${`${from}..${to}`}`.cwd(bare).quiet().nothrow()).stdout.toString().trim().split("\n").filter(Boolean);
    if (flag(args, "--jq", "-q")) return ok(`${status}\t${ahead}\t${titles.join("\\u0000")}\n`);
    return ok({ status, ahead_by: ahead, behind_by: behind, commits: titles.map((t) => ({ commit: { message: t } })) });
  }

  return unsupported(args);
}

async function auth(args: string[]): Promise<GhResult> {
  if (args[1] !== "status") return unsupported(args);
  const host = { state: "success", active: true, host: "github.com", login: VIEWER.login, tokenSource: "keyring", scopes: "gist, read:org, repo, workflow", gitProtocol: "https" };
  if (has(args, "--json")) return ok({ hosts: { "github.com": [host] } });
  return {
    code: 0,
    stdout: "",
    stderr: `github.com\n  ✓ Logged in to github.com account ${VIEWER.login} (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_************************************\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n`,
  };
}

async function repoCmd(args: string[]): Promise<GhResult> {
  if (args[1] !== "clone") return unsupported(args);
  const [, , name, dir] = positionals(args, []);
  if (!name || !dir) return unsupported(args);
  const dash = args.indexOf("--");
  try {
    await cloneRepo(name, dir, dash >= 0 ? args.slice(dash + 1) : []);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  return { code: 0, stdout: "", stderr: `Cloning into '${dir}'...\n` };
}

export async function runGh(args: string[], stdin = ""): Promise<GhResult> {
  if (args[0] === "--version" || args[0] === "version") return ok("gh version 2.83.0 (2026-08-20)\nhttps://github.com/cli/cli/releases/tag/v2.83.0\n");
  switch (args[0]) {
    case "auth":
      return auth(args);
    case "api":
      return api(args, stdin);
    case "pr":
      return pr(args, stdin);
    case "search":
      return search(args);
    case "repo":
      return repoCmd(args);
    default:
      return unsupported(args);
  }
}

export { REPOS, repoName, prsOf };
