// Real git repos for the fictional world, so checkouts, merge-base and `git fetch origin` work for
// real in the demo. Each fixture repo becomes a bare "origin" (with refs/pull/N/head like GitHub)
// under the mock state folder; `gh repo clone` (the fake) clones from it. The viewer's own checkouts
// (for setup and self-review) are clones whose origin URL looks like GitHub's.
import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BRANCHES, findRepo, initialFiles, mainFiles, prHeadFiles, PRS, prsOf, REPOS, repoName, branchFiles, type FixtureRepo, type ShaMap } from "./fixtures";
import { applyEdits } from "./fixtures";
import type { FixturePr } from "./types";
import { emailOf, person, VIEWER } from "./world/people";

/** Where the fake tools keep their state: origins, agent sessions and the GitHub write log. */
export function mockStateDir(): string {
  const dir = process.env.PR_BUNNY_MOCK_STATE ?? join(process.env.PR_BUNNY_HOME ?? tmpdir(), "mock");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const originPath = (state: string, repo: string) => join(state, "origins", `${repo}.git`);
const shasFile = (state: string) => join(state, "origins", "shas.json");

/** Git with no user or system config (no hooks, signing or templates from this machine). */
const gitEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  ...extra,
});

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const res = await $`git ${args}`.cwd(cwd).env(gitEnv(env)).quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr.toString().trim()}`);
  return res.stdout.toString().trim();
}

/** Replaces the work tree's files with exactly `files`. */
function writeTree(dir: string, files: Map<string, string>) {
  for (const entry of readdirSync(dir)) if (entry !== ".git") rmSync(join(dir, entry), { recursive: true, force: true });
  for (const [path, text] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

async function commit(dir: string, files: Map<string, string>, message: string, author: string, date: Date): Promise<string> {
  writeTree(dir, files);
  await git(dir, ["add", "-A"]);
  const who = person(author);
  const when = date.toISOString();
  await git(dir, ["commit", "-q", "--allow-empty", "--no-verify", "-m", message], {
    GIT_AUTHOR_NAME: who.name,
    GIT_AUTHOR_EMAIL: emailOf(author),
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: who.name,
    GIT_COMMITTER_EMAIL: emailOf(author),
    GIT_COMMITTER_DATE: when,
  });
  return git(dir, ["rev-parse", "HEAD"]);
}

const ago = (now: number, minutes: number) => new Date(now - minutes * 60_000);

/** Builds one repo's history in `work` and returns its SHAs. Parents are built before children. */
async function buildRepo(repo: FixtureRepo, work: string, now: number): Promise<ShaMap> {
  const name = repoName(repo);
  const shas: ShaMap = {};
  await git(work, ["init", "-q", "-b", repo.defaultBranch]);
  const c0 = await commit(work, initialFiles(repo), "Initial import", repo.committers[0]!, ago(now, 60 * 24 * 45));

  const prCommits = async (pr: FixturePr, from: string) => {
    await git(work, ["checkout", "-q", "-B", pr.branch, from]);
    for (let i = 1; i <= pr.commits.length; i++) {
      const minutes = pr.updatedMinutesAgo + (pr.commits.length - i) * 45 + 5;
      shas[`${name}#${pr.number}@${i}`] = await commit(work, prHeadFiles(pr, i), pr.commits[i - 1]!.message, pr.author, ago(now, minutes));
    }
    shas[`${name}#${pr.number}`] = shas[`${name}#${pr.number}@${pr.commits.length}`]!;
    shas[`${name}:${pr.branch}`] = shas[`${name}#${pr.number}`]!;
  };

  // Merged PRs branch from the initial import and land on main as squash commits, oldest first.
  let main = initialFiles(repo);
  let mainSha = c0;
  const merged = prsOf(name).filter((p) => p.state === "MERGED").sort((a, b) => b.updatedMinutesAgo - a.updatedMinutesAgo);
  for (const pr of merged) {
    await prCommits(pr, c0);
    main = applyEdits(main, pr.commits.flatMap((c) => c.edits), `#${pr.number}`);
    await git(work, ["checkout", "-q", repo.defaultBranch]);
    mainSha = await commit(work, main, `${pr.title} (#${pr.number})`, pr.author, ago(now, pr.updatedMinutesAgo - 30));
  }
  if (mainFiles(repo).size !== main.size) throw new Error(`${name}: main doesn't match the fixture`);
  shas[`${name}:${repo.defaultBranch}`] = mainSha;

  for (const pr of prsOf(name).filter((p) => p.state === "CLOSED")) await prCommits(pr, c0);

  // Open PRs: a layer waits for the PR it's based on.
  const open = prsOf(name).filter((p) => p.state === "OPEN");
  const done = new Set<number>();
  while (done.size < open.length) {
    const ready = open.filter((p) => !done.has(p.number) && (p.base === repo.defaultBranch || open.some((q) => q.branch === p.base && done.has(q.number))));
    if (!ready.length) throw new Error(`${name}: PR base branches form a cycle or point at unknown branches`);
    for (const pr of ready) {
      await prCommits(pr, shas[`${name}:${pr.base}`]!);
      done.add(pr.number);
    }
  }

  // Branches with no PR that are already pushed.
  for (const b of BRANCHES.filter((x) => x.repo === name && x.pushed)) {
    await git(work, ["checkout", "-q", "-B", b.branch, shas[`${name}:${b.base}`]!]);
    let files = branchFiles(repo, b.base);
    for (const [i, c] of b.commits.entries()) {
      files = applyEdits(files, c.edits, b.branch);
      shas[`${name}:${b.branch}`] = await commit(work, files, c.message, VIEWER.login, ago(now, 60 * 7 - i * 30));
    }
  }
  await git(work, ["checkout", "-q", repo.defaultBranch]);
  return shas;
}

/** Waits for (or takes) a directory lock, so concurrent fake `gh` calls build each origin once. */
async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${dir}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  for (let waited = 0; ; waited += 100) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // A lock older than two minutes belongs to a build that died.
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 120_000) rmSync(lock, { recursive: true, force: true });
      else await Bun.sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * The bare origins for every fixture repo, built on first use, and every commit's SHA. `now` sets
 * the commit dates (so branches look recent); the SHAs are stable for a given state folder.
 */
export async function ensureOrigins(state = mockStateDir(), now = Date.now()): Promise<ShaMap> {
  const file = Bun.file(shasFile(state));
  if (await file.exists()) return file.json();
  return withLock(join(state, "origins"), async () => {
    if (await file.exists()) return file.json();
    const shas: ShaMap = {};
    for (const repo of REPOS) {
      const name = repoName(repo);
      const work = join(state, "origins", `.work-${repo.name}`);
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      Object.assign(shas, await buildRepo(repo, work, now));
      const bare = originPath(state, name);
      const tmp = `${bare}.tmp`;
      rmSync(tmp, { recursive: true, force: true });
      await git(state, ["clone", "-q", "--bare", work, tmp]);
      for (const pr of prsOf(name)) await git(tmp, ["update-ref", `refs/pull/${pr.number}/head`, shas[`${name}#${pr.number}`]!]);
      rmSync(bare, { recursive: true, force: true });
      renameSync(tmp, bare);
      rmSync(work, { recursive: true, force: true });
    }
    await Bun.write(shasFile(state), JSON.stringify(shas, null, 2));
    return shas;
  });
}

/** `gh repo clone`: a clone of the fixture origin (the app then fetches from it as `origin`). */
export async function cloneRepo(repo: string, dir: string, flags: string[]): Promise<void> {
  const state = mockStateDir();
  await ensureOrigins(state);
  if (!findRepo(repo)) throw new Error(`GraphQL: Could not resolve to a Repository with the name '${repo}'. (repository)`);
  // Local clones can't filter blobs; drop the flag and keep the rest (e.g. --no-checkout).
  const keep = flags.filter((f) => !f.startsWith("--filter"));
  mkdirSync(dirname(dir), { recursive: true });
  await git(dirname(dir), ["clone", "-q", ...keep, originPath(state, repo), dir]);
}

/**
 * The viewer's own checkouts, under `<home>/Developer/quokka-labs/<repo>`, as setup and self-review
 * expect to find them: origin points at github.com (never contacted; its refs are already here),
 * user.email is the viewer's, and their own PR branches and branches without a PR are checked out.
 */
export async function makeCheckouts(home: string, state = mockStateDir()): Promise<string[]> {
  await ensureOrigins(state);
  const out: string[] = [];
  for (const repo of REPOS) {
    const name = repoName(repo);
    const dir = join(home, "Developer", repo.owner, repo.name);
    if (existsSync(join(dir, ".git"))) {
      out.push(dir);
      continue;
    }
    mkdirSync(dirname(dir), { recursive: true });
    await git(dirname(dir), ["clone", "-q", originPath(state, name), dir]);
    await git(dir, ["remote", "set-url", "origin", `https://github.com/${name}.git`]);
    await git(dir, ["config", "user.name", VIEWER.name]);
    await git(dir, ["config", "user.email", VIEWER.email]);
    const mine = [
      ...PRS.filter((p) => p.repo === name && p.author === VIEWER.login && p.state === "OPEN").map((p) => p.branch),
      ...BRANCHES.filter((b) => b.repo === name && b.pushed).map((b) => b.branch),
    ];
    for (const branch of mine) await git(dir, ["branch", "-q", "--track", branch, `origin/${branch}`]);
    // Leave the most recent of your branches checked out, like a real working copy.
    if (mine.length) await git(dir, ["checkout", "-q", mine.at(-1)!]);
    out.push(dir);
  }
  return out;
}
