// The inbox: PRs waiting on you, the repo switcher, and per-repo open PRs. All read-only `gh` calls.
import type { Inbox, InboxEntry, InboxPr, RepoOption } from "../shared/types";
import { db } from "./db/db";
import { openPrCounts, repoOpenPrs, reviewInbox, reviewRequests, searchOpenPrs, viewer } from "./gh";
import { lastRepo, latestReviewFor } from "./reviews";

/** GitHub answers are cached briefly so switching repos and reopening the inbox feel instant. */
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

const withReview = (p: InboxPr): InboxEntry => ({ ...p, review: latestReviewFor(p.repo, p.number) });

/** Repos you've reviewed in, most recent first, with when you last did. */
function reviewedRepos(): Array<{ name: string; at: string }> {
  return db
    .query(
      `SELECT r.owner || '/' || r.name AS name, MAX(COALESCE(v.submitted_at, v.started_at)) AS at
       FROM reviews v JOIN repos r ON r.id = v.repo_id GROUP BY r.id ORDER BY at DESC LIMIT 20`,
    )
    .all() as Array<{ name: string; at: string }>;
}

/** Repos added (or confirmed) in setup. */
function addedRepos(): Array<{ name: string; at: string }> {
  return db.query("SELECT owner || '/' || name AS name, added_at AS at FROM repos WHERE added_at IS NOT NULL").all() as Array<{ name: string; at: string }>;
}

/** SQLite's datetime('now') is UTC without a zone; GitHub's timestamps are ISO. Compare as ISO. */
const iso = (t: string) => (t.includes("T") ? t : `${t.replace(" ", "T")}Z`);

export async function getInbox(): Promise<Inbox> {
  const assignedPrs = await cached("assigned", reviewInbox);
  const me = await viewer().catch(() => "");
  const requests = await cached(`requests:${assignedPrs.map((p) => `${p.repo}#${p.number}`).join(",")}`, () => reviewRequests(assignedPrs, me)).catch(
    () => ({}) as Record<string, { by: string; at: string }>,
  );
  const assigned = assignedPrs.map((p) => {
    const r = requests[`${p.repo}#${p.number}`];
    return { ...withReview(p), requestedBy: r?.by ?? null, requestedAt: r?.at ?? null };
  });

  const byRepo = new Map<string, RepoOption["activity"]>();
  for (const r of reviewedRepos()) byRepo.set(r.name, { kind: "reviewed", at: iso(r.at) });
  for (const p of assignedPrs) {
    const prev = byRepo.get(p.repo);
    if (!prev || p.updatedAt > prev.at) byRepo.set(p.repo, { kind: "requested", at: p.updatedAt });
  }
  // Repos added in setup show up even before any review, ordered by when they were added.
  for (const r of addedRepos()) if (!byRepo.has(r.name)) byRepo.set(r.name, { kind: "added", at: iso(r.at) });
  const names = [...byRepo.keys()];
  const counts = await cached(`counts:${names.sort().join(",")}`, () => openPrCounts(names)).catch(() => ({}) as Record<string, number>);
  const repos = [...byRepo.entries()]
    .map(([name, activity]) => ({ name, activity, openCount: counts[name] ?? null }))
    .sort((a, b) => b.activity.at.localeCompare(a.activity.at));

  const latest = db.query("SELECT id FROM reviews ORDER BY id DESC LIMIT 1").get() as { id: number } | null;
  return { assigned, repos, lastRepo: lastRepo() ?? repos[0]?.name ?? null, latestReviewId: latest?.id ?? null };
}

export async function repoPrs(repo: string): Promise<InboxEntry[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Expected owner/name");
  return (await cached(`repo:${repo}`, () => repoOpenPrs(repo))).map(withReview);
}

/** Open PRs matching `q` across every repo in the switcher. */
export async function searchPrs(q: string): Promise<InboxEntry[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  const repos = (await getInbox()).repos.map((r) => r.name);
  return (await cached(`search:${query}`, () => searchOpenPrs(query, repos))).map(withReview);
}
