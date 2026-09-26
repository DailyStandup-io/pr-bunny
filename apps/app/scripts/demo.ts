// `bun run demo`: PR Bunny against a fictional world, for filming and poking around. The app runs
// from source, unchanged, with fake `gh`, `claude` and `codex` (src/mock/bin) first on PATH, in a
// throwaway data folder with its own HOME. It never touches ~/.pr-bunny, the service on 4477, real
// GitHub or a real agent.
//
//   bun run demo                 lived-in: weeks of history, reviews in every phase, stacks, a busy bell
//   bun run demo --fresh         first launch: goes to /setup, with checkouts and review skills to find
//   --dir <path>                 keep the demo folder between takes (reused as-is unless --reset)
//   --reset                      with --dir: wipe it and start over
//   --port <n>                   default 4478
//   --speed <n>                  agent pace: 1 = realistic (~20-40 s a run), 5 = fast, 0 = instant
//   --agent codex                lived-in only: reviews run on (fake) Codex instead of Claude Code
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MOCK_BIN, demoToolProblems } from "../src/server/demo";

const APP = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fresh = argv.includes("--fresh");
const reset = argv.includes("--reset");
const port = Number(opt("--port") ?? 4478);
const speed = opt("--speed") ?? "1";
const agent = opt("--agent") === "codex" ? "codex" : "claude";

const die = (msg: string): never => {
  console.error(`demo: ${msg}`);
  process.exit(1);
};
if (!Number.isInteger(port) || port < 1024 || port > 65535) die("--port must be a number between 1024 and 65535");
if (port === 4477) die("4477 is the real PR Bunny's port (the launchd service or `bun run dev`). Pick another.");
if (!Number.isFinite(Number(speed)) || Number(speed) < 0) die("--speed must be 0 or more");

// ---------- the demo folder ----------

const MARKER = ".pr-bunny-demo";
const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
const protectedDirs = [".pr-bunny", ".review-pr", ".review-desk"].map((d) => real(join(homedir(), d)));

let dir: string;
const given = opt("--dir");
if (given) {
  dir = resolve(given);
  if (protectedDirs.includes(real(dir)) || protectedDirs.some((p) => real(dir).startsWith(`${p}/`))) die(`${dir} is PR Bunny's real data folder. Use another --dir.`);
  if (existsSync(dir) && readdirSync(dir).length && !existsSync(join(dir, MARKER))) die(`${dir} isn't empty and wasn't made by the demo. Use an empty or new folder.`);
  if (reset) rmSync(dir, { recursive: true, force: true });
} else {
  if (reset) die("--reset only makes sense with --dir (a new temp folder is fresh anyway)");
  dir = mkdtempSync(join(tmpdir(), "pr-bunny-demo-"));
}
const paths = {
  data: join(dir, "data"),
  home: join(dir, "home"),
  mock: join(dir, "mock"),
  gh: join(dir, "gh-config"),
  codex: join(dir, "codex"),
  claude: join(dir, "claude-config"),
};
const reused = existsSync(join(paths.data, "pr-bunny.db"));
for (const p of Object.values(paths)) mkdirSync(p, { recursive: true });
writeFileSync(join(dir, MARKER), `PR Bunny demo folder (${fresh ? "fresh" : "lived-in"})\n`);

// Codex reads its sign-in from CODEX_HOME/auth.json: a ChatGPT sign-in for the fictional viewer (unsigned, local only).
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({ email: "robin.vale@quokka-labs.example", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } })}.demo`;
writeFileSync(join(paths.codex, "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: idToken, access_token: "demo", refresh_token: "demo" } }, null, 2));

// ---------- environment ----------

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
// Anything that could reach real GitHub or a paid API goes.
for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]) delete env[k];
for (const k of Object.keys(env)) if (/^(PR_BUNNY|REVIEW_PR|REVIEW_DESK)_/.test(k)) delete env[k];
// The fakes are linked into the demo HOME's ~/.local/bin, so Setup shows paths like a real install.
const localBin = join(paths.home, ".local", "bin");
mkdirSync(localBin, { recursive: true });
for (const tool of ["gh", "claude", "codex"]) {
  rmSync(join(localBin, tool), { force: true });
  symlinkSync(join(MOCK_BIN, tool), join(localBin, tool));
}
Object.assign(env, {
  PATH: `${localBin}:${MOCK_BIN}:${process.env.PATH ?? ""}`,
  HOME: paths.home,
  PR_BUNNY_HOME: paths.data,
  PR_BUNNY_DEMO: "1",
  PR_BUNNY_MOCK_STATE: paths.mock,
  PR_BUNNY_MOCK_SPEED: speed,
  PR_BUNNY_UPDATE_URL: "off",
  PORT: String(port),
  GH_CONFIG_DIR: paths.gh,
  GH_PROMPT_DISABLED: "1",
  CODEX_HOME: paths.codex,
  CLAUDE_CONFIG_DIR: paths.claude,
  GIT_TERMINAL_PROMPT: "0",
  NODE_ENV: "production",
});
const problems = demoToolProblems(env.PATH);
if (problems.length) die(`the fakes aren't first on PATH:\n  ${problems.join("\n  ")}`);

// ---------- build the world ----------

const run = async (cmd: string[], opts: { quiet?: boolean } = {}) => {
  const proc = Bun.spawn(cmd, { cwd: APP, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) die(`${cmd.join(" ")} failed:\n${err || out}`);
  if (!opts.quiet && err.trim()) process.stderr.write(err);
  return out;
};

console.log(`Building the demo world in ${dir}`);
await run(["bun", "../../scripts/generate.ts"], { quiet: true });
// Origins (bare repos with refs/pull/N/head) and your checkouts under the demo HOME.
await run(["bun", "-e", `import { ensureOrigins, makeCheckouts } from "./src/mock/git"; await ensureOrigins(); await makeCheckouts(${JSON.stringify(paths.home)});`]);

let scenario: { reviews: Record<string, number>; stacks: Record<string, number>; live: { scan: { repo: string; number: number }; deep: { reviewId: number } }; notes: string[] } | null = null;
if (!fresh && !reused) scenario = JSON.parse((await run(["bun", "src/mock/seed.ts", "--home", paths.home, "--agent", agent])).trim().split("\n").at(-1)!);
if (fresh && reused) console.log("(reusing the folder as it is; pass --reset for a clean first launch)");

// ---------- the server ----------

const url = `http://127.0.0.1:${port}`;
const busy = await fetch(`${url}/api/health`).then(
  () => true,
  () => false,
);
if (busy) die(`something is already listening on ${url}. Stop it or pass --port.`);

const server = Bun.spawn(["bun", "src/server/index.ts"], { cwd: APP, env, stdout: "inherit", stderr: "inherit" });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

let up = false;
for (let i = 0; i < 100 && !up && server.exitCode === null; i++) {
  await Bun.sleep(150);
  up = await fetch(`${url}/api/health`).then(
    (r) => r.ok,
    () => false,
  );
}
if (!up) {
  stop();
  die("the server didn't come up (see its output above)");
}
const health = (await (await fetch(`${url}/api/health`)).json()) as { demo?: boolean };
if (!health.demo) {
  stop();
  die("the server on that port isn't in demo mode");
}

// Live runs, so the rail spinner and live cards have something to show.
const post = (path: string, body?: unknown) =>
  fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).then((r) => r.json() as Promise<any>);
const liveNotes: string[] = [];
if (scenario) {
  const scan = await post("/api/reviews", { pr: `${scenario.live.scan.repo}#${scenario.live.scan.number}` });
  liveNotes.push(`PR #${scenario.live.scan.number} (mobile) is scanning (overview running): /review/${scan.id}`);
  await post(`/api/reviews/${scenario.live.deep.reviewId}/read`);
  liveNotes.push(`PR #236 (api, assigned to you) has a deep review running: /review/${scenario.live.deep.reviewId}`);
}

const pace = speed === "0" ? "instant" : speed === "1" ? "realistic (~20-40 s a run)" : `${speed}x`;
console.log(`
  PR Bunny demo · ${fresh ? "fresh (first launch → /setup)" : "lived-in"} · agents ${pace}
  ${url}

  Folder:     ${dir}${given ? "" : " (temporary)"}
  Signed in:  robin-vale (fictional) on GitHub, Claude Code (Max) and Codex (ChatGPT Pro), all fakes
  GitHub writes (post, approve, Open PR) land in ${join(paths.mock, "gh-writes.jsonl")}
${
  fresh
    ? `
  Setup will find three checkouts in ${join(paths.home, "Developer", "quokka-labs")}:
    checkout (review skill .claude/skills/review-pr/SKILL.md), api (CLAUDE.md "Code review"), mobile (none)
`
    : scenario
      ? `
${[...liveNotes, ...scenario.notes].map((n) => `  • ${n}`).join("\n")}
`
      : "\n  (reused folder: whatever state it was left in)\n"
}
  Ctrl-C stops the server.`);

await server.exited;
// A temporary folder goes with the server; --dir folders are kept for the next take.
if (!given) {
  rmSync(dir, { recursive: true, force: true });
  console.log(`Removed ${dir}`);
}
process.exit(0);
