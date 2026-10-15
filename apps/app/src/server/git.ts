// Per-repo blobless clone cache + one detached worktree per review. Never touches the user's
// own checkouts.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPOS_DIR, WORKTREES_DIR } from "./config";
import { ghBin } from "./gh";

/** Serialises git operations per repo — concurrent fetches fight over ref locks. */
const locks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  return next;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await $`git ${args}`.cwd(cwd).quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`);
  return res.stdout.toString().trim();
}

export function clonePath(owner: string, repo: string) {
  return join(REPOS_DIR, owner, repo);
}

async function ensureClone(owner: string, repo: string, log: (m: string) => void): Promise<string> {
  const dir = clonePath(owner, repo);
  if (existsSync(join(dir, ".git")) || existsSync(join(dir, "HEAD"))) return dir;
  mkdirSync(join(REPOS_DIR, owner), { recursive: true });
  log(`Cloning ${owner}/${repo} (first time only, blobless)`);
  const res = await $`${ghBin()} repo clone ${`${owner}/${repo}`} ${dir} -- --filter=blob:none --no-checkout`.quiet().nothrow();
  if (res.exitCode !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Cloning ${owner}/${repo} failed: ${res.stderr.toString().trim()}`);
  }
  return dir;
}

export interface Worktree {
  path: string;
  mergeBase: string;
  clone: string;
}

/**
 * Fetches the PR head and its base branch, then checks the reviewed commit out into a fresh
 * detached worktree. `mergeBase` is what GitHub diffs the PR against.
 */
export function prepareWorktree(
  opts: { reviewId: number; owner: string; repo: string; prNumber: number; headSha: string; baseRef: string },
  log: (m: string) => void,
): Promise<Worktree> {
  const key = `${opts.owner}/${opts.repo}`;
  return withRepoLock(key, async () => {
    const clone = await ensureClone(opts.owner, opts.repo, log);
    log(`Fetching PR #${opts.prNumber} and ${opts.baseRef}`);
    await git(clone, [
      "fetch", "--quiet", "--force", "origin",
      `+refs/pull/${opts.prNumber}/head:refs/rp/pr-${opts.prNumber}`,
      `+refs/heads/${opts.baseRef}:refs/remotes/origin/${opts.baseRef}`,
    ]);
    const mergeBase = await git(clone, ["merge-base", opts.headSha, `refs/remotes/origin/${opts.baseRef}`]);

    const path = join(WORKTREES_DIR, opts.owner, opts.repo, `review-${opts.reviewId}`);
    if (existsSync(path)) await removeWorktreeUnlocked(clone, path);
    mkdirSync(join(WORKTREES_DIR, opts.owner, opts.repo), { recursive: true });
    log(`Checking out ${opts.headSha.slice(0, 8)}`);
    await git(clone, ["worktree", "add", "--detach", "--force", path, opts.headSha]);
    return { path, mergeBase, clone };
  });
}

/**
 * A checkout for a fix (src/server/fix.ts): the PR head, detached, at `fix-<id>`, where the agent
 * may edit. Like prepareWorktree, it fetches the PR head first so the commit is in our clone.
 * `gitDir` is the worktree's admin folder in our clone, read before anything else can touch the
 * checkout; later git calls use it explicitly instead of trusting the checkout's `.git` file.
 */
export function prepareFixWorktree(
  opts: { fixId: number; owner: string; repo: string; prNumber: number; headSha: string },
  log: (m: string) => void,
): Promise<{ path: string; clone: string; gitDir: string }> {
  return withRepoLock(`${opts.owner}/${opts.repo}`, async () => {
    const clone = await ensureClone(opts.owner, opts.repo, log);
    log(`Fetching PR #${opts.prNumber}`);
    await git(clone, ["fetch", "--quiet", "--force", "origin", `+refs/pull/${opts.prNumber}/head:refs/rp/pr-${opts.prNumber}`]);
    const path = fixWorktreePath(opts.owner, opts.repo, opts.fixId);
    if (existsSync(path)) await removeWorktreeUnlocked(clone, path);
    mkdirSync(join(WORKTREES_DIR, opts.owner, opts.repo), { recursive: true });
    log(`Checking out ${opts.headSha.slice(0, 8)}`);
    await git(clone, ["worktree", "add", "--detach", "--force", path, opts.headSha]);
    const gitDir = await git(path, ["rev-parse", "--absolute-git-dir"]);
    return { path, clone, gitDir };
  });
}

export const fixWorktreePath = (owner: string, repo: string, fixId: number) => join(WORKTREES_DIR, owner, repo, `fix-${fixId}`);

/**
 * Git in a checkout an agent has had write access to. The admin folder is passed explicitly (a
 * rewritten `.git` file can't redirect it), and nothing the checkout could influence runs: no
 * hooks, no fsmonitor; the diff calls also pass --no-ext-diff and --no-textconv.
 */
const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false"];

async function guardedGit(worktree: string, gitDir: string, args: string[]): Promise<string> {
  const dotGit = join(worktree, ".git");
  let pointer = "";
  try {
    pointer = readFileSync(dotGit, "utf8").trim();
  } catch {}
  if (pointer !== `gitdir: ${gitDir}`) throw new Error("The checkout's .git was changed during the fix, so PR Bunny won't read it. Run the fix again.");
  return git(worktree, [...SAFE_GIT, `--git-dir=${gitDir}`, `--work-tree=${worktree}`, ...args]);
}

export interface FixFileStat {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * Everything the agent changed in a fix checkout, staged, as a plain-text patch plus per-file
 * stats. The patch is exactly what Approve applies, and exactly what the page shows: no renames
 * (each side shown in full), no textconv, and changes the page can't show honestly are refused.
 */
export async function stagedChanges(worktree: string, gitDir: string): Promise<{ diff: string; files: FixFileStat[] }> {
  await guardedGit(worktree, gitDir, ["add", "-A"]);
  const flags = ["diff", "--cached", "--no-renames", "--no-ext-diff", "--no-textconv"];
  // Not via git(): it trims, and a patch's trailing newline matters.
  const res = await $`git ${[...SAFE_GIT, `--git-dir=${gitDir}`, `--work-tree=${worktree}`, ...flags, "--text"]}`.cwd(worktree).quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`git diff failed: ${res.stderr.toString().trim()}`);
  const diff = res.stdout.toString();
  const numstat = await guardedGit(worktree, gitDir, [...flags, "--numstat", "-z"]);
  const files: FixFileStat[] = [];
  const binary: string[] = [];
  for (const rec of numstat.split("\0").filter(Boolean)) {
    const [a, d, ...p] = rec.split("\t");
    const path = p.join("\t");
    if (a === "-" || d === "-") binary.push(path);
    files.push({ path, additions: Number(a) || 0, deletions: Number(d) || 0 });
  }
  const problem = unsupportedChanges(diff, binary);
  if (problem) throw new Error(problem);
  return { diff, files };
}

/**
 * Changes a fix may not make, because the diff page wouldn't show them faithfully: binary files,
 * file mode changes (e.g. making a file executable), symlinks and submodules. Null when there are none.
 */
export function unsupportedChanges(diff: string, binary: string[] = []): string | null {
  const found = new Set<string>();
  if (binary.length) found.add(`changed binary file${binary.length === 1 ? "" : "s"} (${binary.slice(0, 3).join(", ")})`);
  for (const line of diff.split("\n")) {
    if (/^(old|new) mode /.test(line) || /^new file mode 100755/.test(line)) found.add("changed a file's mode");
    if (/^(new|deleted) file mode 120000/.test(line) || /^index \S+ 120000$/.test(line)) found.add("added, changed or removed a symlink");
    if (/^(new|deleted) file mode 160000/.test(line) || /^index \S+ 160000$/.test(line) || /^Subproject commit /.test(line)) found.add("changed a submodule");
    if (/^GIT binary patch$/.test(line) || /^Binary files .* differ$/.test(line)) found.add("changed a binary file");
  }
  return found.size ? `The fix ${[...found].join(", ")}. PR Bunny only pushes plain text edits it can show you in full, so it stopped here.` : null;
}

/**
 * Approving a fix: a fresh checkout of the PR head, the saved patch applied and committed, then
 * pushed to the PR's branch in the PR's own repo (`origin` here: fork PRs are refused before this).
 * A plain push: if the branch moved on GitHub, git refuses and nothing changes. Returns the new
 * commit. Only ever called from the confirmed Approve click.
 */
export async function commitAndPush(
  opts: { fixId: number; owner: string; repo: string; prNumber: number; headSha: string; branch: string; diff: string; message: string; identity: { name: string; email: string } | null },
  log: (m: string) => void,
): Promise<string> {
  const { path, clone } = await prepareFixWorktree(opts, log);
  try {
    const patch = join(path, ".git-rp-fix.patch");
    await Bun.write(patch, opts.diff);
    await git(path, [...SAFE_GIT, "apply", "--index", "--whitespace=nowarn", patch]);
    rmSync(patch, { force: true });
    log("Committing");
    const identity = opts.identity ? ["-c", `user.name=${opts.identity.name}`, "-c", `user.email=${opts.identity.email}`] : [];
    await git(path, [...SAFE_GIT, ...identity, "commit", "-q", "--no-verify", "-m", opts.message]);
    const sha = await git(path, ["rev-parse", "HEAD"]);
    if ((await git(path, ["rev-parse", "HEAD^"])) !== opts.headSha) throw new Error("The commit isn't on top of the PR head. Nothing was pushed.");
    log(`Pushing to ${opts.branch}`);
    const res = await $`git ${SAFE_GIT} push --quiet --no-verify origin ${`${sha}:refs/heads/${opts.branch}`}`.cwd(path).env({ ...process.env, GIT_TERMINAL_PROMPT: "0" }).quiet().nothrow();
    if (res.exitCode !== 0) {
      const err = res.stderr.toString().trim();
      throw new Error(/rejected|non-fast-forward|fetch first/i.test(err) ? `${opts.branch} moved on GitHub since this fix was made. Run the fix again on the new commits.` : `Push failed: ${err}`);
    }
    return sha;
  } finally {
    await withRepoLock(`${opts.owner}/${opts.repo}`, () => removeWorktreeUnlocked(clone, path));
  }
}

/**
 * The identity git would commit with in `cwd`. Pass the user's own checkout when there is one, so
 * `includeIf`-scoped identities (a work email for ~/work) apply. Null if none is set.
 */
export async function gitIdentity(cwd: string): Promise<{ name: string; email: string } | null> {
  if (!existsSync(cwd)) return null;
  const name = (await $`git config user.name`.cwd(cwd).quiet().nothrow()).stdout.toString().trim();
  const email = (await $`git config user.email`.cwd(cwd).quiet().nothrow()).stdout.toString().trim();
  return name && email ? { name, email } : null;
}

async function removeWorktreeUnlocked(clone: string, path: string) {
  await $`git worktree remove --force ${path}`.cwd(clone).quiet().nothrow();
  rmSync(path, { recursive: true, force: true });
  await $`git worktree prune`.cwd(clone).quiet().nothrow();
}

export function removeWorktree(owner: string, repo: string, path: string): Promise<void> {
  const clone = clonePath(owner, repo);
  if (!existsSync(clone)) return Promise.resolve(rmSync(path, { recursive: true, force: true }));
  return withRepoLock(`${owner}/${repo}`, () => removeWorktreeUnlocked(clone, path));
}

/** Commits between two SHAs, for re-reviews. */
export async function diffBetween(worktree: string, from: string, to: string): Promise<string> {
  const res = await $`git diff ${from} ${to}`.cwd(worktree).quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`git diff ${from}..${to} failed: ${res.stderr.toString().trim()}`);
  return res.stdout.toString();
}

/** Reads a slice of a file from a worktree (for snippets of findings outside the diff). */
export async function readLines(worktree: string, relPath: string, from: number, to: number): Promise<string[] | null> {
  if (relPath.includes("..")) return null;
  const file = Bun.file(join(worktree, relPath));
  if (!(await file.exists())) return null;
  const lines = (await file.text()).split("\n");
  return lines.slice(Math.max(0, from - 1), Math.min(lines.length, to));
}

// ---------- self-review: snapshots of the user's own branch ----------

/** Runs git in the user's own checkout. Read-only commands only: we never change their repo. */
async function readGit(cwd: string, args: string[]): Promise<string> {
  return git(cwd, args);
}

export interface SelfSnapshot extends Worktree {
  headSha: string;
  /** The branch tip in the user's checkout, before any snapshot commit of uncommitted work. */
  branchSha: string;
  dirtyFiles: number;
}

/** Untracked files larger than this, or beyond this count, are left out of a snapshot. */
const UNTRACKED_MAX_BYTES = 2_000_000;
const UNTRACKED_MAX_FILES = 300;

/**
 * Copies the user's branch (and, if asked, their uncommitted work) into PR Bunny's own clone
 * and checks it out as a detached worktree. Their checkout is only read: commits come across with
 * `git fetch <path>`, uncommitted changes as a patch, untracked files by copying. Anything
 * uncommitted becomes one "snapshot" commit in our worktree, so diffs, anchors and snippets work
 * exactly as they do for a PR.
 */
export function prepareSelfWorktree(
  opts: { reviewId: number; owner: string; repo: string; localPath: string; branch: string; base: string; includeDirty: boolean },
  log: (m: string) => void,
): Promise<SelfSnapshot> {
  return withRepoLock(`${opts.owner}/${opts.repo}`, async () => {
    const clone = await ensureClone(opts.owner, opts.repo, log);
    const headRef = `refs/rp/self/${opts.branch}`;
    const baseRef = `refs/rp/base/${opts.base}`;
    log(`Copying ${opts.branch} from your checkout`);
    await git(clone, ["fetch", "--quiet", "--force", opts.localPath, `+refs/heads/${opts.branch}:${headRef}`]);
    // Compare against origin's base if the user's checkout knows it, else their local base, else origin.
    const baseSources: string[][] = [
      [opts.localPath, `+refs/remotes/origin/${opts.base}:${baseRef}`],
      [opts.localPath, `+refs/heads/${opts.base}:${baseRef}`],
      ["origin", `+refs/heads/${opts.base}:${baseRef}`],
    ];
    let gotBase = false;
    for (const [src, spec] of baseSources) {
      if ((await $`git fetch --quiet --force ${src!} ${spec!}`.cwd(clone).quiet().nothrow()).exitCode === 0) {
        gotBase = true;
        break;
      }
    }
    if (!gotBase) throw new Error(`Couldn't find the base branch "${opts.base}" in your checkout or on GitHub.`);

    const branchSha = await git(clone, ["rev-parse", headRef]);
    const mergeBase = await git(clone, ["merge-base", branchSha, baseRef]);
    const path = join(WORKTREES_DIR, opts.owner, opts.repo, `review-${opts.reviewId}`);
    if (existsSync(path)) await removeWorktreeUnlocked(clone, path);
    mkdirSync(join(WORKTREES_DIR, opts.owner, opts.repo), { recursive: true });
    log(`Checking out ${branchSha.slice(0, 8)}`);
    await git(clone, ["worktree", "add", "--detach", "--force", path, branchSha]);

    let dirtyFiles = 0;
    let headSha = branchSha;
    if (opts.includeDirty && (await currentBranch(opts.localPath)) === opts.branch) {
      const changed = (await readGit(opts.localPath, ["diff", "--name-only", "HEAD"])).split("\n").filter(Boolean);
      const untracked = (await readGit(opts.localPath, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
      if (changed.length) {
        const patch = await $`git diff --binary HEAD`.cwd(opts.localPath).quiet();
        const file = join(path, ".git-rp-uncommitted.patch");
        await Bun.write(file, patch.stdout);
        await git(path, ["apply", "--whitespace=nowarn", file]);
        rmSync(file, { force: true });
      }
      let copied = 0;
      for (const rel of untracked) {
        if (copied >= UNTRACKED_MAX_FILES || rel.includes("..")) break;
        const src = Bun.file(join(opts.localPath, rel));
        if (!(await src.exists()) || src.size > UNTRACKED_MAX_BYTES) continue;
        await Bun.write(join(path, rel), src);
        copied++;
      }
      dirtyFiles = new Set([...changed, ...untracked.slice(0, copied)]).size;
      if (dirtyFiles) {
        log(`Including ${dirtyFiles} uncommitted file${dirtyFiles === 1 ? "" : "s"}`);
        await git(path, ["add", "-A"]);
        await git(path, ["-c", "user.name=PR Bunny", "-c", "user.email=bunny@prbunny.localhost", "commit", "-q", "--no-verify", "-m", "Uncommitted changes (PR Bunny snapshot)"]);
        headSha = await git(path, ["rev-parse", "HEAD"]);
      }
    }
    return { path, mergeBase, clone, headSha, branchSha, dirtyFiles };
  });
}

/**
 * Recreates a worktree at a commit that's already in our clone (e.g. a self-review snapshot after
 * cleanup removed its checkout). Same path, so resumed Claude sessions still find their files.
 */
export function worktreeAt(opts: { reviewId: number; owner: string; repo: string; sha: string }): Promise<string> {
  return withRepoLock(`${opts.owner}/${opts.repo}`, async () => {
    const clone = clonePath(opts.owner, opts.repo);
    const path = join(WORKTREES_DIR, opts.owner, opts.repo, `review-${opts.reviewId}`);
    if (existsSync(path)) await removeWorktreeUnlocked(clone, path);
    mkdirSync(join(WORKTREES_DIR, opts.owner, opts.repo), { recursive: true });
    await git(clone, ["worktree", "add", "--detach", "--force", path, opts.sha]);
    return path;
  });
}

export async function currentBranch(path: string): Promise<string | null> {
  const res = await $`git rev-parse --abbrev-ref HEAD`.cwd(path).quiet().nothrow();
  const b = res.stdout.toString().trim();
  return res.exitCode === 0 && b !== "HEAD" ? b : null;
}

/** Files with uncommitted changes (tracked and untracked) in the user's checkout. */
export async function dirtyCount(path: string): Promise<number> {
  const res = await $`git status --porcelain`.cwd(path).quiet().nothrow();
  return res.exitCode === 0 ? res.stdout.toString().split("\n").filter(Boolean).length : 0;
}

/** Unified diff plus per-file stats between two commits in a worktree. */
export async function diffWithStats(worktree: string, from: string, to = "HEAD") {
  const diff = await diffBetween(worktree, from, to);
  const numstat = await git(worktree, ["diff", "--numstat", from, to]);
  const files = numstat
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...p] = l.split("\t");
      return { path: p.join("\t"), additions: Number(a) || 0, deletions: Number(d) || 0 };
    });
  return { diff, files };
}

/** One line per commit, for self-review commit hygiene and as the "description" of a branch. */
export async function commitLog(worktree: string, from: string, to = "HEAD"): Promise<string[]> {
  const out = await git(worktree, ["log", "--reverse", "--format=%h %s", `${from}..${to}`]);
  return out.split("\n").filter(Boolean);
}
