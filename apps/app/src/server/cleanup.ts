// Removes PR checkouts that are no longer needed: posted reviews right away, abandoned ones after
// the configured idle time (Settings), and orphan directories nothing references. A checkout
// removed too eagerly isn't lost work: asking a question recreates it (see ensureWorktree).
import { $ } from "bun";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Phase } from "../shared/types";
import { REPOS_DIR, WORKTREES_DIR } from "./config";
import { getSettings } from "./settings";
import { db } from "./db/db";
import { removeWorktree } from "./git";

const HOUR = 3_600_000;

/** SQLite `datetime('now')` strings are UTC without a zone marker. */
const parseUtc = (s: string) => new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").getTime();

export function isStale(r: { phase: Phase; lastActivity: string; running: boolean }, now = Date.now(), ttlHours = getSettings().worktreeTtlHours): boolean {
  if (r.running) return false;
  if (r.phase === "submitted") return true;
  return now - parseUtc(r.lastActivity) > ttlHours * HOUR;
}

interface Candidate {
  id: number;
  owner: string;
  repo: string;
  phase: Phase;
  worktree_path: string;
  lastActivity: string;
  running: number;
}

/** Latest of every timestamp that means "someone is still working on this review". */
const CANDIDATES_SQL = `
  SELECT v.id, r.owner, r.name AS repo, v.phase, v.worktree_path,
    MAX(
      v.started_at,
      COALESCE(v.read_at, ''),
      COALESCE(v.submitted_at, ''),
      COALESCE((SELECT MAX(decided_at) FROM findings WHERE review_id = v.id), ''),
      COALESCE((SELECT MAX(m.created_at) FROM finding_messages m JOIN findings f ON f.id = m.finding_id WHERE f.review_id = v.id), ''),
      COALESCE((SELECT MAX(started_at) FROM claude_runs WHERE review_id = v.id), '')
    ) AS lastActivity,
    EXISTS (SELECT 1 FROM claude_runs WHERE review_id = v.id AND status = 'running') AS running
  FROM reviews v JOIN repos r ON r.id = v.repo_id
  WHERE v.worktree_path IS NOT NULL`;

/** Removes one review's checkout and forgets its path. */
export async function releaseWorktree(review: { id: number; owner: string; repo: string; worktree_path: string | null }) {
  if (review.worktree_path) await removeWorktree(review.owner, review.repo, review.worktree_path);
  db.run("UPDATE reviews SET worktree_path = NULL WHERE id = ?", [review.id]);
}

export async function cleanupWorktrees(opts: { isRunning?: (id: number) => boolean } = {}): Promise<{ removed: number; orphans: number }> {
  let removed = 0;
  for (const c of db.query(CANDIDATES_SQL).all() as Candidate[]) {
    const running = Boolean(c.running) || (opts.isRunning?.(c.id) ?? false);
    if (!isStale({ phase: c.phase, lastActivity: c.lastActivity, running })) continue;
    try {
      await releaseWorktree(c);
      removed++;
    } catch (e) {
      console.warn(`cleanup: couldn't remove ${c.worktree_path}:`, e);
    }
  }

  // Directories under worktrees/<owner>/<repo>/ that no review points at (crashes, deleted rows).
  const referenced = new Set(
    (db.query("SELECT worktree_path FROM reviews WHERE worktree_path IS NOT NULL").all() as Array<{ worktree_path: string }>).map((r) => r.worktree_path),
  );
  let orphans = 0;
  for (const owner of safeList(WORKTREES_DIR)) {
    for (const repo of safeList(join(WORKTREES_DIR, owner))) {
      for (const dir of safeList(join(WORKTREES_DIR, owner, repo))) {
        const path = join(WORKTREES_DIR, owner, repo, dir);
        if (!dir.startsWith("review-") || referenced.has(path)) continue;
        const id = Number(dir.slice("review-".length));
        if (opts.isRunning?.(id)) continue;
        await removeWorktree(owner, repo, path).catch(() => {});
        orphans++;
      }
    }
  }

  // Drop git's bookkeeping for any worktree directories deleted out from under it.
  for (const owner of safeList(REPOS_DIR)) {
    for (const repo of safeList(join(REPOS_DIR, owner))) {
      await $`git worktree prune`.cwd(join(REPOS_DIR, owner, repo)).quiet().nothrow();
    }
  }

  if (removed || orphans) console.log(`cleanup: removed ${removed} stale and ${orphans} orphaned checkout(s)`);
  return { removed, orphans };
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}
