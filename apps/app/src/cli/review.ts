// `bunny review`: self-review the work in this checkout. Talks to the local server.
//
//   bunny review                 self-review the checked-out branch (with uncommitted changes)
//   bunny review <branch>        self-review another branch of this checkout
//   bunny review --base <b>      compare against <b> instead of origin's default branch
//   bunny review --committed     leave uncommitted and untracked files out
//   bunny review --pr <n>        self-review your PR #n in this repo
//   bunny review --rerun         re-run this branch's self-review after fixing
//   bunny review --no-open       print the link instead of opening it
const PORT = Number(process.env.PORT ?? 4477);
const API = `http://127.0.0.1:${PORT}`;

const USAGE = `usage: bunny review [branch] [--base <branch>] [--committed] [--pr <number>] [--rerun] [--no-open]

Self-reviews your work in PR Bunny before anyone else sees it. Run it inside a checkout.`;

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

export async function review(rest: string[]) {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const opts: { branch?: string; base?: string; committed: boolean; pr?: number; rerun: boolean; open: boolean } = { committed: false, rerun: false, open: true };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const value = () => rest[++i] ?? fail(`${a} needs a value.`);
    if (a === "--base") opts.base = value();
    else if (a === "--pr") {
      const n = Number(value().replace(/^#/, ""));
      if (!Number.isInteger(n) || n <= 0) fail("--pr needs a PR number.");
      opts.pr = n;
    } else if (a === "--committed") opts.committed = true;
    else if (a === "--rerun") opts.rerun = true;
    else if (a === "--no-open") opts.open = false;
    else if (a.startsWith("-")) fail(`unknown option ${a}.\n\n${USAGE}`);
    else if (!opts.branch) opts.branch = a;
    else fail(`unexpected argument "${a}".`);
  }

  async function post(path: string, body: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      fail(NOT_RUNNING);
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) fail(data.error ?? `${res.status} ${res.statusText}`);
    return data;
  }

  const localPath = process.cwd();
  const out = opts.rerun
    ? await post("/api/self-reviews/rerun", { localPath, branch: opts.branch })
    : await post("/api/self-reviews", { localPath, branch: opts.branch, base: opts.base, includeDirty: !opts.committed, pr: opts.pr });

  const url = `${(await health()).url}/review/${out.id}`;
  console.log(opts.rerun ? `Re-running → ${url}` : out.reused ? `Already reviewed; opening it → ${url}` : `Self-review started → ${url}`);
  if (out.reused && !opts.rerun) console.log("After fixing, run `bunny review --rerun` to check again.");
  if (opts.open) Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
}
