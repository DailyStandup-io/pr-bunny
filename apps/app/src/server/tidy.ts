// Stop and tidy up: stopping a running overview or deep review (and resuming it), removing
// reviews from the lists (with undo), hiding PRs from the inbox, and the housekeeping prefs.
// Everything here is local state. Nothing is written to GitHub.
import type { HiddenItem, HousekeepingPrefs, Phase } from "../shared/types";
import { db } from "./db/db";
import { continueDeepReview, startDeepReview } from "./deep";
import { getRow, retryRecon, setPhase } from "./reviews";
import { abortRun } from "./runs";
import { getSettings } from "./settings";

const RUNNING: Phase[] = ["recon_running", "reviewing", "read"];

/** Sent when resuming a deep review you stopped, in the same agent session. */
export const RESUME_PROMPT =
  "You were stopped part-way through this review. Pick up where you left off without redoing work you've already done, then return your final answer through the StructuredOutput tool with every required field filled in.";

// ---------- stop / resume ----------

const hasFindings = (id: number) => ((db.query("SELECT COUNT(*) AS n FROM findings WHERE review_id = ?").get(id) as { n: number }).n > 0);

/**
 * Stops the review's running step. The agent gets SIGTERM, then SIGKILL after a few seconds (see
 * killOnAbort); the run then settles the phase itself, so this returns `stopping: true`. With
 * `force`, or when nothing is running in this process, the phase is settled right away.
 */
export function stopReview(id: number, opts: { force?: boolean } = {}): { stopping: boolean } {
  const row = getRow(id);
  if (!row) throw new Error("Not found");
  if (!RUNNING.includes(row.phase)) return { stopping: false };
  const aborted = abortRun(id);
  if (aborted && !opts.force) return { stopping: true };
  db.run("UPDATE claude_runs SET status = 'error', error = 'Stopped' WHERE review_id = ? AND status = 'running'", [id]);
  // A self-review re-run goes back to its earlier findings; anything else is "stopped".
  setPhase(id, row.mode === "self" && row.recon_json && hasFindings(id) ? "walkthrough" : "cancelled");
  return { stopping: false };
}

/** The last deep review run's agent session, if it got far enough to have one. */
function lastReviewSession(id: number): string | null {
  const run = db.query("SELECT session_id AS sessionId FROM claude_runs WHERE review_id = ? AND kind = 'review' ORDER BY id DESC LIMIT 1").get(id) as {
    sessionId: string | null;
  } | null;
  return run?.sessionId ?? null;
}

/** What Resume would do for a stopped review: pick up the agent session, or start the step again. */
export function canResume(id: number): boolean {
  const row = getRow(id);
  return Boolean(row?.recon_json && lastReviewSession(id));
}

/**
 * Resume: a stopped deep review continues in its agent session where it stopped. A stopped
 * overview kept nothing, so it (and a deep review with no session yet) starts again.
 */
export async function resumeReview(id: number): Promise<{ resumed: boolean }> {
  const row = getRow(id);
  if (!row) throw new Error("Not found");
  if (row.phase !== "cancelled") throw new Error("This review isn't stopped.");
  if (!row.recon_json) {
    await retryRecon(id);
    return { resumed: false };
  }
  const session = lastReviewSession(id);
  if (session) continueDeepReview(id, session, getSettings().reviewMaxTurns, RESUME_PROMPT);
  else startDeepReview(id);
  return { resumed: Boolean(session) };
}

/** Start again: the step that was stopped runs from scratch. The overview is kept if it finished. */
export async function restartReview(id: number) {
  const row = getRow(id);
  if (!row) throw new Error("Not found");
  if (row.phase !== "cancelled") throw new Error("This review isn't stopped.");
  if (!row.recon_json) await retryRecon(id);
  else startDeepReview(id);
}

// ---------- remove (clear) reviews ----------

/**
 * Removes reviews from the lists. A running one is stopped first (it stays "Stopped" if you undo).
 * Findings and history are kept, so Undo (restoreReviews) brings it back as it was.
 */
export function clearReviews(ids: number[]): { cleared: number[] } {
  const cleared: number[] = [];
  for (const id of new Set(ids.filter(Number.isInteger))) {
    const row = getRow(id);
    if (!row) continue;
    if (RUNNING.includes(row.phase)) stopReview(id, { force: true });
    db.run("UPDATE reviews SET cleared_at = datetime('now') WHERE id = ? AND cleared_at IS NULL", [id]);
    cleared.push(id);
  }
  return { cleared };
}

export function restoreReviews(ids: number[]): { restored: number[] } {
  const list = [...new Set(ids.filter(Number.isInteger))];
  for (const id of list) db.run("UPDATE reviews SET cleared_at = NULL WHERE id = ?", [id]);
  return { restored: list };
}

// ---------- hidden from the inbox ----------

const KEY = /^(pr|review|branch):.{1,300}$/;

export function listHidden(): HiddenItem[] {
  return db
    .query("SELECT key, mode, stamp, title, meta, hidden_at AS hiddenAt FROM inbox_hidden ORDER BY hidden_at DESC, key")
    .all() as HiddenItem[];
}

export function hideItems(items: Array<Partial<HiddenItem>>): HiddenItem[] {
  const upsert = db.prepare(
    `INSERT INTO inbox_hidden (key, mode, stamp, title, meta) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET mode = excluded.mode, stamp = excluded.stamp, title = excluded.title, meta = excluded.meta, hidden_at = datetime('now')`,
  );
  db.transaction(() => {
    for (const it of items) {
      if (typeof it.key !== "string" || !KEY.test(it.key)) throw new Error(`Can't hide ${String(it.key)}`);
      if (it.mode !== "change" && it.mode !== "good") throw new Error("Hide mode must be change or good");
      upsert.run(it.key, it.mode, typeof it.stamp === "string" ? it.stamp : null, String(it.title ?? it.key).slice(0, 300), typeof it.meta === "string" ? it.meta.slice(0, 300) : null);
    }
  })();
  return listHidden();
}

export function unhideItems(keys: string[]): HiddenItem[] {
  const del = db.prepare("DELETE FROM inbox_hidden WHERE key = ?");
  db.transaction(() => {
    for (const k of keys) if (typeof k === "string") del.run(k);
  })();
  return listHidden();
}

// ---------- housekeeping prefs + auto-clear ----------

const PREF_DEFAULTS: HousekeepingPrefs = { clearFinishedDays: 0, keepFailed: true };

export function getHousekeeping(): HousekeepingPrefs {
  const rows = db.query("SELECT key, value FROM housekeeping").all() as Array<{ key: string; value: string }>;
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])) as Partial<HousekeepingPrefs>;
  return { ...PREF_DEFAULTS, ...stored };
}

export function saveHousekeeping(patch: Partial<HousekeepingPrefs>): HousekeepingPrefs {
  const next = { ...getHousekeeping() };
  if (patch.clearFinishedDays !== undefined) {
    const n = Number(patch.clearFinishedDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) throw new Error("Clear finished reviews: a whole number of days between 0 and 365");
    next.clearFinishedDays = n;
  }
  if (patch.keepFailed !== undefined) next.keepFailed = Boolean(patch.keepFailed);
  const upsert = db.prepare("INSERT INTO housekeeping (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  db.transaction(() => {
    for (const [k, v] of Object.entries(next)) upsert.run(k, JSON.stringify(v));
  })();
  return next;
}

/**
 * Clears posted and stopped peer reviews (and failed ones, unless Keep failed is on) with no
 * activity for the configured days. Runs with the hourly checkout cleanup. Returns how many.
 */
export function autoClearReviews(): number {
  const { clearFinishedDays, keepFailed } = getHousekeeping();
  if (!clearFinishedDays) return 0;
  const phases = keepFailed ? "('submitted', 'cancelled')" : "('submitted', 'cancelled', 'failed')";
  const res = db.run(
    `UPDATE reviews SET cleared_at = datetime('now')
     WHERE cleared_at IS NULL AND mode = 'peer' AND phase IN ${phases}
       AND MAX(started_at, COALESCE(submitted_at, ''), COALESCE((SELECT MAX(started_at) FROM claude_runs c WHERE c.review_id = reviews.id), ''))
           < datetime('now', ?)`,
    [`-${clearFinishedDays} days`],
  );
  return res.changes;
}
