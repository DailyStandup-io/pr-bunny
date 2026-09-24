// Per-repo blobless clone cache + one detached worktree per review. Never touches the user's
// own checkouts.
import { $ } from "bun";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPOS_DIR, WORKTREES_DIR } from "./config";

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
  const res = await $`gh repo clone ${`${owner}/${repo}`} ${dir} -- --filter=blob:none --no-checkout`.quiet().nothrow();
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
