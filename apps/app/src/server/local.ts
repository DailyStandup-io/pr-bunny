// Your own checkouts, for self-review: finding the one for a repo and listing your branches.
// Everything here only reads the checkout (git plumbing and .git/config); nothing is changed.
import { $ } from "bun";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SelfBranch, SelfSources } from "../shared/types";
import { db } from "./db/db";
import { currentBranch, dirtyCount } from "./git";
import { myOpenPrs } from "./gh";

/** Where people usually keep code. Searched two levels deep for a checkout of a repo. */
export const SEARCH_ROOTS = ["Developer", "code", "Code", "src", "Projects", "projects", "dev", "work", "repos", "git", "GitHub"].map((d) => join(homedir(), d));
const BASE_NAMES = new Set(["main", "master", "develop", "trunk"]);
/** Shared branches: offered as a base to compare against, never listed as your work. */
const isBaseBranch = (name: string) => BASE_NAMES.has(name) || /^(release|hotfix|releases)\//.test(name);

/** `git@github.com:o/r.git`, `https://github.com/o/r(.git)` → `o/r`. */
export function parseGithubRemote(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

function originOf(dir: string): string | null {
  try {
    const config = readFileSync(join(dir, ".git", "config"), "utf8");
    const origin = config.split(/^\[/m).find((s) => s.startsWith('remote "origin"'));
    const url = origin?.match(/^\s*url\s*=\s*(.+)$/m)?.[1];
    return url ? parseGithubRemote(url) : null;
  } catch {
    return null;
  }
}

/** The GitHub repo (`owner/name`) and top-level directory of a checkout, from any path inside it. */
export async function checkoutInfo(path: string): Promise<{ repo: string; root: string }> {
  const top = await $`git rev-parse --show-toplevel`.cwd(path).quiet().nothrow();
  if (top.exitCode !== 0) throw new Error(`${path} isn't inside a git checkout.`);
  const root = top.stdout.toString().trim();
  const url = (await $`git remote get-url origin`.cwd(root).quiet().nothrow()).stdout.toString();
  const repo = parseGithubRemote(url);
  if (!repo) throw new Error(`${root} has no GitHub "origin" remote.`);
  return { repo, root };
}

const misses = new Map<string, number>();

/** Remembers where a repo is checked out, so the branch list doesn't have to search again. */
export function rememberCheckout(repo: string, root: string) {
  const [owner, name] = repo.split("/");
  db.run("INSERT INTO repos (owner, name, local_path) VALUES (?, ?, ?) ON CONFLICT (owner, name) DO UPDATE SET local_path = excluded.local_path", [
    owner!,
    name!,
    root,
  ]);
  misses.delete(repo.toLowerCase());
}

/** Your checkout of `owner/name`: the remembered one if it still matches, else a search of the usual folders. */
export function findCheckout(repo: string): string | null {
  const [owner, name] = repo.split("/");
  const known = db.query("SELECT local_path FROM repos WHERE owner = ? AND name = ?").get(owner!, name!) as { local_path: string | null } | null;
  if (known?.local_path && existsSync(join(known.local_path, ".git")) && originOf(known.local_path)?.toLowerCase() === repo.toLowerCase()) {
    return known.local_path;
  }
  const key = repo.toLowerCase();
  if ((misses.get(key) ?? 0) > Date.now() - 5 * 60_000) return null;
  for (const dir of checkoutDirs()) {
    if (originOf(dir)?.toLowerCase() === key) {
      rememberCheckout(repo, dir);
      return dir;
    }
  }
  misses.set(key, Date.now());
  return null;
}

/** Git checkouts in the usual code folders, two levels deep (`~/Developer/x`, `~/Developer/org/x`). */
function* checkoutDirs(): Generator<string> {
  const dirs = (root: string) => {
    try {
      return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => join(root, d.name));
    } catch {
      return [];
    }
  };
  const isCheckout = (dir: string) => {
    try {
      return statSync(join(dir, ".git")).isDirectory();
    } catch {
      return false;
    }
  };
  for (const root of SEARCH_ROOTS) {
    for (const a of dirs(root)) {
      if (isCheckout(a)) yield a;
      else for (const b of dirs(a)) if (isCheckout(b)) yield b;
    }
  }
}

/** Every GitHub checkout in the usual code folders; the first one found wins for each repo. */
export function scanCheckouts(): Array<{ repo: string; root: string }> {
  const seen = new Map<string, { repo: string; root: string }>();
  for (const dir of checkoutDirs()) {
    const repo = originOf(dir);
    if (repo && !seen.has(repo.toLowerCase())) seen.set(repo.toLowerCase(), { repo, root: dir });
  }
  return [...seen.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

/** The checked-out branch, from .git/HEAD (no git process: this runs for every repo found). */
export function headBranch(root: string): string | null {
  try {
    return readFileSync(join(root, ".git", "HEAD"), "utf8").match(/^ref: refs\/heads\/(.+)$/m)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** origin's default branch as the checkout knows it, else main/master. */
export async function defaultBase(root: string): Promise<string> {
  const head = await $`git symbolic-ref --short refs/remotes/origin/HEAD`.cwd(root).quiet().nothrow();
  if (head.exitCode === 0) return head.stdout.toString().trim().replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    if ((await $`git rev-parse --verify --quiet refs/heads/${b}`.cwd(root).quiet().nothrow()).exitCode === 0) return b;
  }
  return "main";
}

const latestSelfReview = (repo: string, where: string, arg: string | number) => {
  const [owner, name] = repo.split("/");
  return db
    .query(
      `SELECT v.id, v.phase, v.run_number AS runNumber,
              (SELECT COUNT(*) FROM findings f WHERE f.review_id = v.id) AS findingsTotal,
              (SELECT COUNT(*) FROM findings f WHERE f.review_id = v.id AND f.decision IS NULL) AS findingsUndecided,
              (SELECT COUNT(*) FROM findings f WHERE f.review_id = v.id AND f.resolved_run IS NULL AND COALESCE(f.decision, '') != 'dismissed') AS findingsOpen,
              v.opened_pr_number AS openedPrNumber
       FROM reviews v JOIN repos r ON r.id = v.repo_id
       WHERE r.owner = ? AND r.name = ? AND v.mode = 'self' AND ${where} ORDER BY v.id DESC LIMIT 1`,
    )
    .get(owner!, name!, arg) as SelfBranch["review"];
};

/** Your recent branches in the checkout plus your open PRs, each with its latest self-review. */
export async function selfSources(repo: string): Promise<SelfSources> {
  const prs = await myOpenPrs(repo).catch(() => []);
  const root = findCheckout(repo);
  const base = root ? await defaultBase(root) : "main";
  const out: SelfSources = { repo, localPath: root, defaultBase: base, bases: [base], branches: [], prs: [] };
  if (root) {
    const current = await currentBranch(root);
    const me = (await $`git config user.email`.cwd(root).quiet().nothrow()).stdout.toString().trim().toLowerCase();
    const refs = await $`git for-each-ref refs/heads --sort=-committerdate --count=40 --format=${"%(refname:short)\t%(committerdate:iso-strict)\t%(subject)\t%(upstream:short)\t%(upstream:track)\t%(authoremail)"}`
      .cwd(root)
      .quiet()
      .nothrow();
    const monthAgo = Date.now() - 30 * 86_400_000;
    for (const line of refs.stdout.toString().split("\n").filter(Boolean)) {
      const [name, date, subject, upstream, track, email] = line.split("\t") as [string, string, string, string, string, string];
      if (isBaseBranch(name)) {
        if (!out.bases.includes(name)) out.bases.push(name);
        continue;
      }
      if (Date.parse(date) < monthAgo && name !== current) continue;
      // Yours: your commit on top (the checked-out branch always counts).
      if (me && name !== current && email.replace(/[<>]/g, "").toLowerCase() !== me) continue;
      const ahead = Number((await $`git rev-list --count ${`refs/remotes/origin/${base}`}..${`refs/heads/${name}`}`.cwd(root).quiet().nothrow()).stdout.toString().trim()) || 0;
      if (!ahead && name !== current) continue; // merged or empty
      const pr = prs.find((p) => p.headRefName === name) ?? null;
      out.branches.push({
        name,
        title: pr?.title ?? subject,
        ahead,
        current: name === current,
        dirtyFiles: name === current ? await dirtyCount(root) : 0,
        pushed: Boolean(upstream) && !/ahead/.test(track),
        upstream: upstream || null,
        updatedAt: date,
        pr: pr ? { number: pr.number, isDraft: pr.isDraft, title: pr.title } : null,
        review: latestSelfReview(repo, "v.head_ref = ?", name) ?? null,
      });
      if (out.branches.length >= 8) break;
    }
    for (const b of out.branches) if (!out.bases.includes(b.name)) out.bases.push(b.name);
  }
  out.prs = prs.map((p) => ({ ...p, review: latestSelfReview(repo, "v.pr_number = ?", p.number) ?? null }));
  return out;
}
