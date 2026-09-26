// Self-review: check your own branch or PR before anyone else sees it. Findings stay local; the
// only GitHub write is "Open PR" (gh pr create / add reviewers), and only from an explicit click.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SuggestedReviewer } from "../shared/types";
import { db } from "./db/db";
import { ensureWorktree } from "./deep";
import { commitLog, currentBranch, diffWithStats, prepareSelfWorktree } from "./git";
import { addReviewers, createPr, parsePrRef, prForBranch, prView, recentCommitters, remoteBranchSha, viewer, type PrRef, type PrView } from "./gh";
import { checkoutInfo, defaultBase, rememberCheckout } from "./local";
import { emit } from "./live";
import { adoptIntoStacks, getRow, insertReview, localPrView, runRecon, setPhase, startOnce } from "./reviews";

export interface StartSelf {
  /** A path inside your checkout (the CLI sends its cwd). */
  localPath?: string;
  /** owner/name, for a PR, or to find the checkout. */
  repo?: string;
  branch?: string;
  base?: string;
  /** Include uncommitted and untracked files (only possible for the checked-out branch). */
  includeDirty?: boolean;
  /** Review your PR instead of a local branch. */
  pr?: number;
}

const safeRef = (s: string) => /^[\w./-]+$/.test(s) && !s.includes("..") && !s.startsWith("-");

/** Latest non-failed self-review for the same branch or PR, which `rp review` reopens. */
function existingSelf(repo: string, where: string, arg: string | number): number | null {
  const [owner, name] = repo.split("/");
  const row = db
    .query(
      `SELECT v.id FROM reviews v JOIN repos r ON r.id = v.repo_id
       WHERE r.owner = ? AND r.name = ? AND v.mode = 'self' AND v.phase != 'failed' AND v.cleared_at IS NULL AND ${where} ORDER BY v.id DESC LIMIT 1`,
    )
    .get(owner!, name!, arg) as { id: number } | null;
  return row?.id ?? null;
}

/**
 * Self-review of your own PR: reopens the latest non-failed one, else starts one. Callers hold the
 * PR's start guard (`startOnce`); the reuse check is repeated after `prView`, right before inserting.
 */
export async function startSelfPr(ref: PrRef, known?: PrView): Promise<{ id: number; reused: boolean }> {
  const repo = `${ref.owner}/${ref.repo}`;
  const reused = existingSelf(repo, "v.pr_number = ?", ref.number);
  if (reused) return { id: reused, reused: true };
  const pr = known ?? (await prView(ref));
  const again = existingSelf(repo, "v.pr_number = ?", ref.number);
  if (again) return { id: again, reused: true };
  const id = insertReview(ref, pr, "recon_running");
  db.run("UPDATE reviews SET mode = 'self' WHERE id = ?", [id]);
  runRecon(id, ref, pr).catch((e) => setPhase(id, "failed", e instanceof Error ? e.message : String(e)));
  return { id, reused: false };
}

/** Starts (or reopens) a self-review and kicks off its overview in the background. */
export async function startSelfReview(input: StartSelf): Promise<{ id: number; reused: boolean }> {
  if (input.pr) {
    const repo = input.repo ?? (input.localPath ? (await checkoutInfo(input.localPath)).repo : null);
    if (!repo) throw new Error("Which repo? Pass `repo` or run it from inside a checkout.");
    const ref = parsePrRef(`${repo}#${input.pr}`);
    // Shares startReview's one-start-per-PR guard, so a concurrent start of the same PR joins this one.
    let reused = true;
    const id = await startOnce(ref, async () => {
      const r = await startSelfPr(ref);
      reused = r.reused;
      return adoptIntoStacks(ref, r.id);
    });
    return { id, reused };
  }

  if (!input.localPath) throw new Error("No checkout to review. Run `rp review` inside one, or pick a branch.");
  const { repo, root } = await checkoutInfo(input.localPath);
  rememberCheckout(repo, root);
  const name = input.branch ?? (await currentBranch(root));
  if (!name) throw new Error("You're on a detached HEAD. Check out a branch, or name one.");
  const base = input.base ?? (await defaultBase(root));
  if (!safeRef(name) || !safeRef(base)) throw new Error("That branch name isn't one git would accept.");
  if (name === base) throw new Error(`You're on ${base}. Check out the branch you want reviewed.`);

  const [owner, repoName] = repo.split("/") as [string, string];
  const me = await viewer().catch(() => "you");
  // Checked after the last await, so two starts of the same branch can't both insert.
  const reused = existingSelf(repo, "v.head_ref = ? AND v.pr_number = 0", name);
  if (reused) return { id: reused, reused: true };
  // Insert first so the snapshot has a review id for its worktree path.
  const placeholder = {
    number: 0, title: name, body: "", url: `https://github.com/${repo}/compare/${base}...${name}`, author: me, isDraft: false, state: "OPEN",
    headRefName: name, headRefOid: "", baseRefName: base, additions: 0, deletions: 0, changedFiles: 0, labels: [], files: [],
  };
  const id = insertReview({ owner, repo: repoName, number: 0 }, placeholder, "recon_running");
  db.run("UPDATE reviews SET mode = 'self', local_path = ?, include_dirty = ? WHERE id = ?", [root, input.includeDirty === false ? 0 : 1, id]);

  (async () => {
    const progress = (text: string) => emit({ type: "progress", reviewId: id, runKind: "recon", text, at: Date.now() });
    const snap = await prepareSelfWorktree(
      { reviewId: id, owner, repo: repoName, localPath: root, branch: name, base, includeDirty: input.includeDirty !== false },
      progress,
    );
    const { diff, files } = await diffWithStats(snap.path, snap.mergeBase);
    if (!files.length) throw new Error(`${name} has no changes against ${base}.`);
    const commits = await commitLog(snap.path, snap.mergeBase, snap.branchSha).catch(() => []);
    // Title: the only commit's subject, else the branch name.
    const title = commits.length === 1 ? commits[0]!.replace(/^\w+ /, "") : name;
    db.run(
      `UPDATE reviews SET title = ?, head_sha = ?, merge_base = ?, worktree_path = ?, files_json = ?, dirty_files = ?,
              additions = ?, deletions = ?, changed_files = ? WHERE id = ?`,
      [title, snap.headSha, snap.mergeBase, snap.path, JSON.stringify(files), snap.dirtyFiles,
       files.reduce((n, f) => n + f.additions, 0), files.reduce((n, f) => n + f.deletions, 0), files.length, id],
    );
    const row = getRow(id)!;
    const body = [...commits.map((c) => `- ${c}`), snap.dirtyFiles ? `- (plus ${snap.dirtyFiles} uncommitted file(s))` : ""].filter(Boolean).join("\n");
    await runRecon(id, { owner, repo: repoName, number: 0 }, localPrView(row, body), { diff });
  })().catch((e) => setPhase(id, "failed", e instanceof Error ? e.message : String(e)));
  return { id, reused: false };
}

/** The self-review `rp review --rerun` should re-run: the latest one for this checkout's branch. */
export async function findSelfReview(localPath: string, branch?: string): Promise<number> {
  const { repo, root } = await checkoutInfo(localPath);
  const name = branch ?? (await currentBranch(root));
  const id = name ? existingSelf(repo, "v.head_ref = ? AND v.pr_number = 0", name) : null;
  if (!id) throw new Error(`No self-review of ${name ?? "this branch"} yet. Run \`rp review\` first.`);
  return id;
}

// ---------- suggested reviewers ----------

/** CODEOWNERS glob → regex, per GitHub's rules (close enough for suggestions). */
export function ownerPattern(p: string): RegExp {
  const anchored = p.startsWith("/");
  let body = p.replace(/^\//, "").replace(/\/$/, "/**");
  body = body
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
    .join(".*");
  const hasSlash = p.replace(/\/$/, "").includes("/");
  // A plain name or directory also owns everything under it; `docs/*` only owns direct children.
  const descend = !/\*[^/]*$/.test(p) || p.endsWith("**");
  return new RegExp(`${anchored || hasSlash ? "^" : "(^|/)"}${body}${descend ? "(/.*)?" : ""}$`);
}

function codeowners(worktree: string): Array<{ pattern: string; re: RegExp; owners: string[] }> {
  for (const rel of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    const path = join(worktree, rel);
    if (!existsSync(path)) continue;
    return readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim())
      .filter(Boolean)
      .map((l) => {
        const [pattern, ...owners] = l.split(/\s+/);
        return { pattern: pattern!, re: ownerPattern(pattern!), owners: owners.filter((o) => o.startsWith("@")) };
      })
      .filter((r) => r.owners.length);
  }
  return [];
}

const reviewerCache = new Map<string, SuggestedReviewer[]>();

/** CODEOWNERS for the touched paths, then people who recently changed the most-changed files. */
export async function suggestReviewers(reviewId: number): Promise<SuggestedReviewer[]> {
  const row = getRow(reviewId);
  if (!row) throw new Error("Not found");
  const key = `${reviewId}:${row.head_sha}`;
  const hit = reviewerCache.get(key);
  if (hit) return hit;
  const me = (await viewer().catch(() => "")).toLowerCase();
  const files: Array<{ path: string; additions: number; deletions: number }> = row.files_json ? JSON.parse(row.files_json) : [];
  const worktree = await ensureWorktree(row);
  const out: SuggestedReviewer[] = [];
  const seen = new Set<string>([me, `@${me}`]);
  const add = (handle: string, why: string) => {
    const k = handle.toLowerCase();
    if (seen.has(k) || seen.has(k.replace(/^@/, "")) || out.length >= 4) return;
    seen.add(k);
    out.push({ handle: handle.startsWith("@") && !handle.includes("/") ? handle.slice(1) : handle, why });
  };

  const rules = codeowners(worktree);
  for (const f of files) {
    const rule = [...rules].reverse().find((r) => r.re.test(f.path)); // last match wins
    for (const o of rule?.owners ?? []) add(o, `CODEOWNERS for \`${rule!.pattern}\``);
  }

  const repo = `${row.owner}/${row.repo}`;
  const top = [...files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions)).slice(0, 4);
  const lists = await Promise.all(top.map((f) => recentCommitters(repo, f.path)));
  const counts = new Map<string, number>();
  lists.flat().forEach((l) => counts.set(l, (counts.get(l) ?? 0) + 1));
  lists.forEach((logins, i) => {
    const who = logins.find((l) => !seen.has(l.toLowerCase()));
    if (!who) return;
    const n = counts.get(who) ?? 0;
    add(who, n > 3 ? `Wrote most of \`${top[i]!.path.split("/").slice(0, -1).join("/") || top[i]!.path}/\`` : `Last changed \`${top[i]!.path}\``);
  });
  reviewerCache.set(key, out);
  return out;
}

// ---------- open the PR ----------

/**
 * "Open PR": creates the PR for a pushed branch (gh pr create --fill) with the chosen reviewers,
 * or adds the reviewers if a PR already exists. Never pushes: the branch must be on GitHub.
 */
export async function openPrFor(reviewId: number, reviewers: string[]): Promise<{ number: number; url: string; created: boolean }> {
  const row = getRow(reviewId);
  if (!row) throw new Error("Not found");
  if (row.mode !== "self") throw new Error("Only self-reviews open PRs.");
  const repo = `${row.owner}/${row.repo}`;
  const handles = reviewers.filter((r) => /^@?[\w.-]+(\/[\w.-]+)?$/.test(r));
  const url = (n: number) => `https://github.com/${repo}/pull/${n}`;

  const existing = row.pr_number || row.opened_pr_number || (await prForBranch(repo, row.head_ref));
  if (existing) {
    await addReviewers(repo, existing, handles);
    db.run("UPDATE reviews SET opened_pr_number = ? WHERE id = ?", [existing, reviewId]);
    emit({ type: "phase", reviewId, phase: row.phase });
    return { number: existing, url: url(existing), created: false };
  }
  const remote = await remoteBranchSha(repo, row.head_ref);
  if (!remote) throw new Error(`Push ${row.head_ref} first. PR Bunny never pushes for you.`);
  if (row.local_path && existsSync(row.local_path)) {
    const local = (await Bun.$`git rev-parse ${`refs/heads/${row.head_ref}`}`.cwd(row.local_path).quiet().nothrow()).stdout.toString().trim();
    if (local && local !== remote) throw new Error(`${row.head_ref} on GitHub is behind your checkout. Push your latest commits first.`);
  }
  const number = await createPr(repo, { head: row.head_ref, base: row.base_ref, reviewers: handles });
  db.run("UPDATE reviews SET opened_pr_number = ? WHERE id = ?", [number, reviewId]);
  emit({ type: "phase", reviewId, phase: row.phase });
  return { number, url: url(number), created: true };
}
