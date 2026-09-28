// The update popup's and What's new's saved state (Settings › About), and which release notes to
// show after an update. The notes are CHANGELOG.md, built into the binary, so they work offline.
import type { UpdatePrefs, WhatsNewState } from "../shared/types";
import { parseChangelog, type ReleaseNotes } from "../shared/changelog";
import { CODENAME, VERSION } from "../build-info";
import { db } from "./db/db";
import { newer } from "./update";
import changelog from "../../../../CHANGELOG.md" with { type: "text" };

export const RELEASE_NOTES: ReleaseNotes[] = parseChangelog(changelog);

const DEFAULTS: UpdatePrefs = { updatePopup: true, whatsNew: true, dismissedUpdate: null, lastSeenVersion: null };
const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

export function getUpdatePrefs(): UpdatePrefs {
  const rows = db.query("SELECT key, value FROM update_prefs").all() as Array<{ key: string; value: string }>;
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])) as Partial<UpdatePrefs>;
  return {
    updatePopup: stored.updatePopup ?? DEFAULTS.updatePopup,
    whatsNew: stored.whatsNew ?? DEFAULTS.whatsNew,
    dismissedUpdate: stored.dismissedUpdate ?? null,
    lastSeenVersion: stored.lastSeenVersion ?? null,
  };
}

/** Validates and saves a partial update. Unknown keys are ignored. */
export function saveUpdatePrefs(patch: Partial<UpdatePrefs>): UpdatePrefs {
  const next = getUpdatePrefs();
  if (patch.updatePopup !== undefined) next.updatePopup = Boolean(patch.updatePopup);
  if (patch.whatsNew !== undefined) next.whatsNew = Boolean(patch.whatsNew);
  for (const k of ["dismissedUpdate", "lastSeenVersion"] as const) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v !== null && (typeof v !== "string" || (!VERSION_RE.test(v) && v !== "dev"))) throw new Error(`${k} must be a version like 1.2.3`);
    next[k] = v;
  }
  const upsert = db.prepare("INSERT INTO update_prefs (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  db.transaction(() => {
    for (const [k, v] of Object.entries(next)) upsert.run(k, JSON.stringify(v));
  })();
  return next;
}

const setupDone = () => Boolean(db.query("SELECT 1 FROM onboarding WHERE id = 1").get());

/**
 * What's new for this browser to show now. Once per version, after updating:
 * - a fresh install doesn't get it (setup marks its own version seen; see markSetupSeen);
 * - an install that finished setup before this existed has no record, so it sees this version's notes;
 * - jumping several versions shows each one, newest first;
 * - with What's new turned off, a new version is marked seen quietly, so turning it back on later
 *   doesn't bring up old notes.
 */
export function whatsNewState(): WhatsNewState {
  let prefs = getUpdatePrefs();
  const versions = unseenVersions(RELEASE_NOTES, VERSION, prefs.lastSeenVersion, setupDone());
  let pending: WhatsNewState["pending"] = null;
  if (versions.length && !prefs.whatsNew) prefs = saveUpdatePrefs({ lastSeenVersion: VERSION });
  else if (versions.length) pending = { from: prefs.lastSeenVersion, versions };
  return { prefs, current: { version: VERSION, name: CODENAME }, notes: RELEASE_NOTES, pending };
}

/** The versions whose notes haven't been seen, newest first (see whatsNewState). */
export function unseenVersions(notes: ReleaseNotes[], version: string, seen: string | null, setupDone: boolean): string[] {
  if (!notes.some((n) => n.version === version) || seen === version) return []; // from source: "dev"
  if (seen === null) return setupDone ? [version] : [];
  if (!newer(version, seen)) return [];
  return notes.filter((n) => !newer(n.version, version) && newer(n.version, seen)).map((n) => n.version);
}

/** Got it, ✕, Esc or the fixes note shown: this version's notes are seen. */
export function markWhatsNewSeen(): WhatsNewState {
  saveUpdatePrefs({ lastSeenVersion: VERSION });
  return whatsNewState();
}

/** Finish setup on a fresh install: the notes for the version you just installed wait in Settings › About. */
export function markSetupSeen() {
  if (getUpdatePrefs().lastSeenVersion === null) saveUpdatePrefs({ lastSeenVersion: VERSION });
}
