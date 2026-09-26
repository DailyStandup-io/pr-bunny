// Notifications: things worth a nudge (a review request, a finished review, a stack pass, an
// update) are recorded here for the bell and pushed over /ws/notifications. The browser tab turns
// them into desktop alerts (see src/web/notifications.ts), so nothing leaves this machine.
//
// Sources: review phase changes (via live.ts), stacks and updates (watched in the database and
// update state), and GitHub, polled with read-only `gh` calls every couple of minutes.
import type { AppNotification, LiveEvent, NotifyKind, Phase } from "../shared/types";
import { db } from "./db/db";
import { assignedPrs, myPrReviews, prHeads, reviewInbox, reviewRequests, viewer } from "./gh";
import { onEmit, publish } from "./live";
import { lastStoppedRun, latestReviewFor, startReview } from "./reviews";
import { getSettings } from "./settings";
import { updateState } from "./update";

export const NOTIFY_TOPIC = "notifications";

/** Events that come from GitHub; the "From" repo filter applies to these. */
const GITHUB_KINDS = new Set<NotifyKind>(["req", "assign", "stackUpd", "myReview"]);
/** How many bell entries to keep. */
const KEEP = 200;

interface Row {
  id: number;
  kind: NotifyKind;
  title: string;
  body: string;
  summary: string;
  subject: string;
  repo: string | null;
  pr_number: number | null;
  review_id: number | null;
  stack_id: number | null;
  href: string;
  tag: string;
  face: string;
  created_at: string;
  seen_at: string | null;
  read_at: string | null;
}

const toItem = (r: Row): AppNotification => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  summary: r.summary,
  subject: r.subject,
  repo: r.repo,
  pr: r.pr_number,
  tag: r.tag,
  face: r.face,
  createdAt: r.created_at,
  seen: Boolean(r.seen_at),
  read: Boolean(r.read_at),
});

export interface NewNotification {
  kind: NotifyKind;
  title: string;
  body: string;
  summary: string;
  subject?: string;
  repo?: string | null;
  pr?: number | null;
  reviewId?: number | null;
  stackId?: number | null;
  /** Where a click goes: an app path or a github.com URL. */
  href: string;
  tag: string;
  /** A mascot face key (smile, wink, happy, crying, cross, surprised, hearts, wobbly, shades). */
  face: string;
  /** The same key is only ever recorded once. */
  key: string;
}

/** Would this event be recorded with the current settings? */
export function wanted(kind: NotifyKind, repo?: string | null): boolean {
  const s = getSettings().notifications;
  if (!s.events[kind]) return false;
  if (GITHUB_KINDS.has(kind) && s.repoMode === "chosen" && repo) return s.repos.some((r) => r.toLowerCase() === repo.toLowerCase());
  return true;
}

/** Records an event (unless it's turned off or was already recorded) and pushes it to open tabs. */
export function record(n: NewNotification): AppNotification | null {
  if (!wanted(n.kind, n.repo)) return null;
  const row = db
    .query(
      `INSERT INTO notifications (kind, title, body, summary, subject, repo, pr_number, review_id, stack_id, href, tag, face, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    )
    .get(n.kind, n.title, n.body, n.summary, n.subject ?? "", n.repo ?? null, n.pr ?? null, n.reviewId ?? null, n.stackId ?? null, n.href, n.tag, n.face, n.key) as Row | null;
  if (!row) return null;
  db.run(`DELETE FROM notifications WHERE id <= (SELECT id FROM notifications ORDER BY id DESC LIMIT 1 OFFSET ${KEEP})`);
  const item = toItem(row);
  publish(NOTIFY_TOPIC, { type: "notification", item });
  return item;
}

// ---------- the bell ----------

export function feed(limit = 50) {
  const items = (db.query("SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ?").all(Math.min(Math.max(1, limit), KEEP)) as Row[]).map(toItem);
  const { n } = db.query("SELECT COUNT(*) AS n FROM notifications WHERE seen_at IS NULL").get() as { n: number };
  return { items, unseen: n };
}

const sync = () => publish(NOTIFY_TOPIC, { type: "sync" });

/** The bell was opened: everything in it has been seen (the badge clears). */
export function markSeen() {
  db.run("UPDATE notifications SET seen_at = datetime('now') WHERE seen_at IS NULL");
  sync();
}

/** "Mark all read". */
export function markAllRead() {
  db.run("UPDATE notifications SET read_at = datetime('now'), seen_at = COALESCE(seen_at, datetime('now')) WHERE read_at IS NULL");
  sync();
}

/**
 * A click on a notification (in the bell or on the desktop): marks it read and says where to go.
 * A review request or assignment opens the PR's review, starting the scan if it hasn't run yet.
 */
export async function openNotification(id: number): Promise<{ path: string; reviewId?: number; tab?: "findings" }> {
  const row = db.query("SELECT * FROM notifications WHERE id = ?").get(id) as Row | null;
  if (!row) throw new Error("Notification not found");
  db.run("UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')), seen_at = COALESCE(seen_at, datetime('now')) WHERE id = ?", [id]);
  sync();
  if ((row.kind === "req" || row.kind === "assign") && row.repo && row.pr_number) {
    const existing = latestReviewFor(row.repo, row.pr_number);
    const reviewId = existing?.id ?? (await startReview(`${row.repo}#${row.pr_number}`));
    return { path: `/review/${reviewId}`, reviewId };
  }
  if (row.kind === "deep" && row.review_id) return { path: row.href, reviewId: row.review_id, tab: "findings" };
  return { path: row.href };
}

// ---------- reviews (phase changes) ----------

const ref = (repo: string, pr: number, headRef: string) => (pr > 0 ? `${repo} #${pr}` : `${repo} · ${headRef}`);
const short = (pr: number) => (pr > 0 ? `#${pr}` : "your branch");

interface ReviewInfo {
  id: number;
  pr: number;
  title: string;
  mode: "peer" | "self";
  error: string | null;
  repo: string;
  headRef: string;
}

function reviewInfo(id: number): ReviewInfo | null {
  return db
    .query(
      `SELECT v.id, v.pr_number AS pr, v.title, v.mode, v.error, v.head_ref AS headRef, r.owner || '/' || r.name AS repo
       FROM reviews v JOIN repos r ON r.id = v.repo_id WHERE v.id = ?`,
    )
    .get(id) as ReviewInfo | null;
}

/** Layers of a stack that's running Review all go straight from the scan to the deep review. */
const inRunningStack = (reviewId: number) =>
  Boolean(db.query("SELECT 1 FROM stack_layers l JOIN stacks s ON s.id = l.stack_id WHERE l.review_id = ? AND s.run_state = 'running'").get(reviewId));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The last phase notified per review, so a repeated phase event doesn't notify twice. */
const lastPhase = new Map<number, Phase>();

export function onPhase(reviewId: number, phase: Phase) {
  if (phase !== "recon_ready" && phase !== "walkthrough" && phase !== "failed") {
    lastPhase.delete(reviewId);
    return;
  }
  if (lastPhase.get(reviewId) === phase) return;
  lastPhase.set(reviewId, phase);
  const r = reviewInfo(reviewId);
  if (!r) return;
  const where = ref(r.repo, r.pr, r.headRef);
  const base = { subject: r.title, repo: r.repo, pr: r.pr > 0 ? r.pr : null, reviewId: r.id, href: `/review/${r.id}`, tag: r.pr > 0 ? `pr:${r.repo}#${r.pr}` : `review:${r.id}` };
  const stamp = Date.now();

  if (phase === "recon_ready") {
    if (inRunningStack(r.id)) return;
    record({ ...base, kind: "overview", title: `Overview ready · ${short(r.pr)}`, body: `${r.title}. ${where}`, summary: "Overview is ready to read", face: "smile", key: `overview:${r.id}:${stamp}` });
    return;
  }

  if (phase === "walkthrough") {
    const counts = db
      .query("SELECT severity, COUNT(*) AS n FROM findings WHERE review_id = ? AND superseded_by IS NULL GROUP BY severity")
      .all(r.id) as Array<{ severity: string; n: number }>;
    const total = counts.reduce((a, c) => a + c.n, 0);
    const high = counts.filter((c) => c.severity === "high" || c.severity === "critical").reduce((a, c) => a + c.n, 0);
    const found = total ? `${plural(total, "finding")}${high ? `, ${high} high` : ""}` : "No findings";
    record({
      ...base,
      kind: "deep",
      title: `${r.mode === "self" ? "Self-review" : "Deep review"} ready · ${short(r.pr)}`,
      body: `${found}. ${r.title}.`,
      summary: `Deep review finished · ${total ? plural(total, "finding") : "no findings"}`,
      face: high ? "surprised" : "shades",
      key: `deep:${r.id}:${stamp}`,
    });
    return;
  }

  const stop = lastStoppedRun(r.id);
  const why = stop ? `Ran out of turns${stop.maxTurns ? ` at ${stop.maxTurns}` : ""}. Run it again or raise the limit.` : (r.error ?? "Something went wrong.").split("\n")[0]!.slice(0, 160);
  record({
    ...base,
    kind: "failed",
    title: `Review stopped · ${where}`,
    body: why,
    summary: stop ? "Review ran out of turns" : "Review failed",
    face: "crying",
    key: `failed:${r.id}:${stamp}`,
  });
}

// ---------- stacks and updates (watched) ----------

interface StackState {
  id: number;
  run_state: string;
  cross_state: string | null;
  title: string;
  repo: string;
}
let stackStates: Map<number, StackState> | null = null;

function watchStacks() {
  const rows = db
    .query("SELECT s.id, s.run_state, s.cross_state, s.title, r.owner || '/' || r.name AS repo FROM stacks s JOIN repos r ON r.id = s.repo_id")
    .all() as StackState[];
  const prev = stackStates;
  stackStates = new Map(rows.map((r) => [r.id, r]));
  if (!prev) return; // the first look is the baseline
  const stamp = Date.now();
  for (const s of rows) {
    const was = prev.get(s.id);
    if (!was) continue;
    const base = { subject: s.title, repo: s.repo, stackId: s.id, href: `/stack/${s.id}`, tag: `stack:${s.id}` };
    if (was.run_state === "running" && s.run_state === "idle") {
      const { layers, reviewed } = db
        .query(
          `SELECT COUNT(*) AS layers, SUM(CASE WHEN v.phase IN ('walkthrough', 'submitted') THEN 1 ELSE 0 END) AS reviewed
           FROM stack_layers l LEFT JOIN reviews v ON v.id = l.review_id WHERE l.stack_id = ? AND l.skipped = 0 AND l.gh_state = 'open'`,
        )
        .get(s.id) as { layers: number; reviewed: number | null };
      if (reviewed) {
        const { n } = db
          .query(
            `SELECT COUNT(*) AS n FROM findings f JOIN stack_layers l ON l.review_id = f.review_id
             WHERE l.stack_id = ? AND f.superseded_by IS NULL AND f.stack_finding_id IS NULL`,
          )
          .get(s.id) as { n: number };
        const next = s.cross_state === null || s.cross_state === "running" ? " The across-the-stack pass runs next." : "";
        record({ ...base, kind: "all", title: `Stack reviewed · ${s.title}`, body: `${plural(layers, "PR")}, ${plural(n, "finding")}.${next}`, summary: `Review all finished on ${s.title}`, face: "wink", key: `all:${s.id}:${stamp}` });
      }
    }
    if (was.cross_state === "running" && s.cross_state === "done") {
      const { n } = db.query("SELECT COUNT(*) AS n FROM stack_findings WHERE stack_id = ?").get(s.id) as { n: number };
      record({
        ...base,
        kind: "across",
        title: `Across the stack · ${s.title}`,
        body: n ? `${plural(n, "finding")} ${n === 1 ? "spans" : "span"} more than one PR.` : "Nothing spans more than one PR.",
        summary: "Across-the-stack pass is ready",
        face: n ? "surprised" : "happy",
        key: `across:${s.id}:${stamp}`,
      });
    }
  }
}

function watchUpdate() {
  const u = updateState();
  if (u.status !== "available" || !u.latest) return;
  record({
    kind: "update",
    title: `PR Bunny ${u.latest.version} is ready`,
    body: "Update from Settings. It takes about a minute.",
    summary: `PR Bunny ${u.latest.version} is available`,
    subject: "Update from Settings",
    href: "/settings#about",
    tag: "app:update",
    face: "shades",
    key: `update:${u.latest.version}`,
  });
}

// ---------- GitHub (polled) ----------

const seenGet = (key: string) => (db.query("SELECT value FROM notify_seen WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
const seenSet = (key: string, value = "") =>
  db.run("INSERT INTO notify_seen (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = datetime('now')", [key, value]);

/**
 * Runs `fn` for each item that's new (key unseen, or its value changed). The first poll of a
 * category only records what's there, so turning notifications on doesn't replay old news.
 */
function fresh<T>(category: string, items: T[], keyOf: (t: T) => string, valueOf: (t: T) => string, fn: (t: T, before: string | null) => void) {
  const baseline = seenGet(`baseline:${category}`) === null;
  db.transaction(() => {
    for (const t of items) {
      const key = `${category}:${keyOf(t)}`;
      const before = seenGet(key);
      const value = valueOf(t);
      if (before !== value) {
        seenSet(key, value);
        if (!baseline) fn(t, before);
      } else seenSet(key, value); // refreshes `at`, so pruning keeps it
    }
    if (baseline) seenSet(`baseline:${category}`, "1");
  })();
}

const onboarded = () => Boolean(db.query("SELECT 1 FROM onboarding WHERE id = 1").get());

async function pollRequests() {
  const prs = await reviewInbox();
  const me = await viewer().catch(() => "");
  const by = await reviewRequests(prs, me).catch(() => ({}) as Record<string, { by: string; at: string }>);
  fresh(
    "req",
    prs,
    (p) => `${p.repo}#${p.number}`,
    (p) => by[`${p.repo}#${p.number}`]?.at ?? "requested",
    (p) => {
      const who = by[`${p.repo}#${p.number}`]?.by;
      record({
        kind: "req",
        title: `Review requested: ${p.title}`,
        body: `${who ? `@${who} · ` : ""}${p.repo} #${p.number}`,
        summary: who ? `@${who} asked you to review` : "You were asked to review",
        subject: p.title,
        repo: p.repo,
        pr: p.number,
        href: "/",
        tag: `pr:${p.repo}#${p.number}`,
        face: "wink",
        key: `req:${p.repo}#${p.number}:${by[`${p.repo}#${p.number}`]?.at ?? p.updatedAt}`,
      });
    },
  );
}

async function pollAssigned() {
  fresh(
    "assign",
    await assignedPrs(),
    (p) => `${p.repo}#${p.number}`,
    () => "assigned",
    (p) =>
      void record({
        kind: "assign",
        title: `Assigned to you: ${p.title}`,
        body: `@${p.author} · ${p.repo} #${p.number}`,
        summary: "You were assigned a PR",
        subject: p.title,
        repo: p.repo,
        pr: p.number,
        href: "/",
        tag: `pr:${p.repo}#${p.number}`,
        face: "wink",
        key: `assign:${p.repo}#${p.number}:${p.updatedAt}`,
      }),
  );
}

async function pollMyReviews() {
  fresh(
    "myrev",
    await myPrReviews(),
    (r) => r.id,
    (r) => r.state,
    (r) => {
      const [title, summary, face] =
        r.state === "APPROVED"
          ? [`Approved: #${r.number}`, `@${r.author} approved`, "hearts"]
          : r.state === "CHANGES_REQUESTED"
            ? [`Changes requested on #${r.number}`, `@${r.author} requested changes`, "wobbly"]
            : [`New review on #${r.number}`, `@${r.author} reviewed`, "wobbly"];
      const said = r.comments ? `left ${plural(r.comments, "comment")} on` : r.state === "APPROVED" ? "approved" : "reviewed";
      record({
        kind: "myReview",
        title,
        body: `@${r.author} ${said} ${r.title}.`,
        summary,
        subject: r.title,
        repo: r.repo,
        pr: r.number,
        href: r.url,
        tag: `pr:${r.repo}#${r.number}`,
        face,
        key: `myrev:${r.id}:${r.state}`,
      });
    },
  );
}

/** PRs you've reviewed recently, and layers of recent stacks: new commits on them notify. */
async function pollHeads() {
  const reviewed = db
    .query(
      `SELECT r.owner || '/' || r.name AS repo, v.pr_number AS pr, MAX(v.id) AS reviewId FROM reviews v JOIN repos r ON r.id = v.repo_id
       WHERE v.mode = 'peer' AND v.pr_number > 0 AND v.phase IN ('walkthrough', 'submitted') AND v.started_at > datetime('now', '-30 days')
       GROUP BY r.id, v.pr_number ORDER BY reviewId DESC LIMIT 30`,
    )
    .all() as Array<{ repo: string; pr: number; reviewId: number }>;
  const layers = db
    .query(
      `SELECT r.owner || '/' || r.name AS repo, l.pr_number AS pr, s.id AS stackId, s.title AS stackTitle FROM stack_layers l
       JOIN stacks s ON s.id = l.stack_id JOIN repos r ON r.id = s.repo_id
       WHERE l.gh_state = 'open' AND s.updated_at > datetime('now', '-30 days') ORDER BY s.updated_at DESC LIMIT 30`,
    )
    .all() as Array<{ repo: string; pr: number; stackId: number; stackTitle: string }>;
  const key = (p: { repo: string; pr: number }) => `${p.repo}#${p.pr}`;
  const prs = [...new Map([...reviewed, ...layers].map((p) => [key(p), { repo: p.repo, number: p.pr }])).values()];
  if (!prs.length) return;
  const heads = await prHeads(prs);
  const open = prs.filter((p) => heads[`${p.repo}#${p.number}`]?.state === "OPEN");
  fresh(
    "head",
    open,
    (p) => `${p.repo}#${p.number}`,
    (p) => heads[`${p.repo}#${p.number}`]!.sha,
    (p, before) => {
      if (!before) return; // first sighting of this PR
      const k = `${p.repo}#${p.number}`;
      const { sha, title } = heads[k]!;
      const review = reviewed.find((r) => key(r) === k);
      const reviewedSha = review ? (db.query("SELECT head_sha AS sha FROM reviews WHERE id = ?").get(review.reviewId) as { sha: string } | null)?.sha : null;
      const layer = layers.find((l) => key(l) === k);
      if (review && reviewedSha && reviewedSha !== sha && wanted("changed", p.repo)) {
        record({
          kind: "changed",
          title: `Changed since your review · #${p.number}`,
          body: `New commits on ${title}. ${p.repo}`,
          summary: "New commits since your review",
          subject: title,
          repo: p.repo,
          pr: p.number,
          reviewId: review.reviewId,
          href: layer ? `/stack/${layer.stackId}` : `/review/${review.reviewId}`,
          tag: `pr:${k}`,
          face: "surprised",
          key: `changed:${k}:${sha}`,
        });
      } else if (layer) {
        record({
          kind: "stackUpd",
          title: `Stack updated · #${p.number}`,
          body: `${title} has new commits or was rebased. ${layer.stackTitle}`,
          summary: `New commits in ${layer.stackTitle}`,
          subject: title,
          repo: p.repo,
          pr: p.number,
          stackId: layer.stackId,
          href: `/stack/${layer.stackId}`,
          tag: `pr:${k}`,
          face: "surprised",
          key: `stackUpd:${k}:${sha}`,
        });
      }
    },
  );
}

const POLLS: Array<[string, NotifyKind[], () => Promise<void>]> = [
  ["req", ["req"], pollRequests],
  ["assign", ["assign"], pollAssigned],
  ["myrev", ["myReview"], pollMyReviews],
  ["head", ["changed", "stackUpd"], pollHeads],
];

let polling = false;
/** One round of GitHub polling. A category that's turned off isn't polled, and starts over from a baseline when it's back on. */
export async function pollGitHub() {
  if (polling || !onboarded()) return;
  polling = true;
  try {
    const events = getSettings().notifications.events;
    for (const [category, kinds, poll] of POLLS) {
      if (!kinds.some((k) => events[k])) {
        db.run("DELETE FROM notify_seen WHERE key = ?", [`baseline:${category}`]);
        continue;
      }
      await poll().catch((e) => console.warn(`notifications: ${category} poll failed:`, e instanceof Error ? e.message : e));
    }
    db.run("DELETE FROM notify_seen WHERE at < datetime('now', '-90 days')");
  } finally {
    polling = false;
  }
}

// ---------- start ----------

const GITHUB_POLL_MS = 2 * 60_000;

let started = false;
/** Hooks review phase changes and starts the watchers and the GitHub poller. */
export function startNotifier() {
  if (started) return;
  started = true;
  onEmit((ev: LiveEvent) => {
    if (ev.type === "phase") onPhase(ev.reviewId, ev.phase);
  });
  watchStacks();
  setInterval(() => {
    try {
      watchStacks();
    } catch (e) {
      console.warn("notifications: stack watch failed:", e);
    }
  }, 3000).unref?.();
  setInterval(watchUpdate, 60_000).unref?.();
  setTimeout(watchUpdate, 5_000).unref?.();
  setTimeout(() => void pollGitHub(), 20_000).unref?.();
  setInterval(() => void pollGitHub(), GITHUB_POLL_MS).unref?.();
}
