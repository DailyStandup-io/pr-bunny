// `bunny review`: self-review the work in this checkout. Talks to the local server.
//
//   bunny review                 self-review the checked-out branch (with uncommitted changes)
//   bunny review <branch>        self-review another branch of this checkout
//   bunny review --base <b>      compare against <b> instead of origin's default branch
//   bunny review --committed     leave uncommitted and untracked files out
//   bunny review --pr <n>        self-review your PR #n in this repo
//   bunny review --pr 12,13      several PRs at once (or repeat --pr); they run in parallel
//   bunny review --deep          go straight on to the deep review once the overview is in
//   bunny review --rerun         re-run this branch's self-review after fixing
//   bunny review --no-open       print the link instead of opening it
//   bunny review --stack         review the whole stack this branch's PR is in (Review all)
const PORT = Number(process.env.PORT ?? 4477);
const API = `http://127.0.0.1:${PORT}`;

const USAGE = `usage: bunny review [branch] [--base <branch>] [--committed] [--pr <number>[,<number>...]] [--deep] [--rerun] [--stack] [--no-open]

Self-reviews your work in PR Bunny before anyone else sees it. Run it inside a checkout.
Repeat --pr (or give a comma list) to start up to 5 PRs at once; they review in parallel.
--deep goes straight on to the in-depth review when the overview is in.`;

const NOT_RUNNING = `PR Bunny isn't running on port ${PORT}. Start it with \`bunny service install\` (or \`bunny setup\`).`;

/** The running server's version and the URL to open (https://prbunny.localhost or http://127.0.0.1:4477). */
export async function health(): Promise<{ version: string; url: string }> {
  try {
    const res = await fetch(`${API}/api/health`);
    if (res.ok) return (await res.json()) as { version: string; url: string };
  } catch {}
  fail(NOT_RUNNING);
}

function fail(msg: string, code = 1): never {
  console.error(`bunny: ${msg}`);
  process.exit(code);
}

/** PRs one `bunny review` starts together. Each runs its own overview and deep review agent. */
export const MAX_PRS = 5;

export interface ReviewOpts {
  branch?: string;
  base?: string;
  committed: boolean;
  prs: number[];
  rerun: boolean;
  stack: boolean;
  deep: boolean;
  open: boolean;
}

/** Parses `bunny review` arguments. Throws with the message to show. */
export function parseReviewArgs(rest: string[]): ReviewOpts {
  const opts: ReviewOpts = { committed: false, prs: [], rerun: false, stack: false, deep: false, open: true };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const value = () => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${a} needs a value.`);
      return v;
    };
    if (a === "--base") opts.base = value();
    else if (a === "--pr") {
      for (const part of value().split(",")) {
        const n = Number(part.trim().replace(/^#/, ""));
        if (!Number.isInteger(n) || n <= 0) throw new Error("--pr needs a PR number.");
        if (!opts.prs.includes(n)) opts.prs.push(n);
      }
    } else if (a === "--committed") opts.committed = true;
    else if (a === "--rerun") opts.rerun = true;
    else if (a === "--stack") opts.stack = true;
    else if (a === "--deep") opts.deep = true;
    else if (a === "--no-open") opts.open = false;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}.\n\n${USAGE}`);
    else if (!opts.branch) opts.branch = a;
    else throw new Error(`unexpected argument "${a}".`);
  }
  if (opts.prs.length > MAX_PRS) throw new Error(`At most ${MAX_PRS} PRs at once: each runs its own agent, and more will hit your plan's rate limits.`);
  if (opts.prs.length > 1) {
    const clash = opts.stack ? "--stack" : opts.rerun ? "--rerun" : opts.branch ? "a branch" : null;
    if (clash) throw new Error(`${clash} works on one PR at a time; pass a single --pr.`);
  }
  return opts;
}

export async function review(rest: string[]) {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(USAGE);
    return;
  }
  let opts: ReviewOpts;
  try {
    opts = parseReviewArgs(rest);
  } catch (e) {
    fail((e as Error).message);
  }

  /** POSTs to the server; throws with the message to show. */
  async function request(path: string, body: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      throw new Error(NOT_RUNNING);
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
    return data;
  }
  const post = (path: string, body: unknown) => request(path, body).catch((e: Error) => fail(e.message));
  const open = (url: string) => opts.open && Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });

  const localPath = process.cwd();
  if (opts.stack) {
    const pr = opts.prs[0];
    const { id } = await post("/api/stacks", pr ? { pr, ...(await repoOf(localPath)), reviewAll: true } : { localPath, branch: opts.branch, reviewAll: true });
    const url = `${(await health()).url}/stack/${id}`;
    console.log(`Reviewing the whole stack → ${url}`);
    open(url);
    return;
  }
  const deepNote = opts.deep ? " (deep review follows the overview)" : "";
  const said = (out: { reused?: boolean; resumed?: boolean }) =>
    out.resumed ? "was stopped; resuming it" : out.reused ? (opts.deep ? "already reviewed; deep review requested" : "already reviewed") : `started${deepNote}`;
  if (opts.prs.length > 1) {
    // All at once: the server runs every review in parallel. One PR failing doesn't hide the others.
    const base = (await health()).url;
    const results = await Promise.allSettled(
      opts.prs.map((pr) => request("/api/self-reviews", { localPath, base: opts.base, includeDirty: !opts.committed, pr, deep: opts.deep })),
    );
    console.log(`Self-reviewing ${opts.prs.length} PRs in parallel:`);
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`  #${opts.prs[i]} failed: ${(r.reason as Error).message}`);
        return;
      }
      const url = `${base}/review/${r.value.id}`;
      console.log(`  #${opts.prs[i]} ${said(r.value)} → ${url}`);
      open(url);
    });
    if (results.some((r) => r.status === "rejected")) process.exit(1);
    return;
  }
  const out = opts.rerun
    ? await post("/api/self-reviews/rerun", { localPath, branch: opts.branch })
    : await post("/api/self-reviews", { localPath, branch: opts.branch, base: opts.base, includeDirty: !opts.committed, pr: opts.prs[0], deep: opts.deep });

  const url = `${(await health()).url}/review/${out.id}`;
  console.log(
    opts.rerun ? `Re-running → ${url}`
    : out.resumed ? `Self-review was stopped; resuming it → ${url}`
    : out.reused ? `Already reviewed${opts.deep ? "; deep review requested" : ""}; opening it → ${url}`
    : `Self-review started${deepNote} → ${url}`,
  );
  if (out.reused && !out.resumed && !opts.rerun) console.log("After fixing, run `bunny review --rerun` to check again.");
  open(url);
}

/** owner/name of the checkout at `path`, from its origin remote. */
async function repoOf(path: string): Promise<{ repo: string }> {
  const url = (await Bun.$`git remote get-url origin`.cwd(path).quiet().nothrow()).stdout.toString().trim();
  const m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!m) fail("This checkout has no GitHub origin remote.");
  return { repo: `${m[1]}/${m[2]}` };
}
