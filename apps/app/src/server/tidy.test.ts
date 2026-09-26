// Stop and tidy up: Stop really kills the agent process, a stopped review settles as "cancelled",
// removing a review hides it from the lists until Undo, and inbox hiding / auto-clear are local.
import { describe, expect, test } from "bun:test";
import { killOnAbort } from "./claude";
import { db } from "./db/db";
import { getRow, latestReviewFor, listReviews } from "./reviews";
import { abortRun, claimRun, hasRun, releaseRun } from "./runs";
import { autoClearReviews, clearReviews, hideItems, listHidden, restoreReviews, saveHousekeeping, stopReview, unhideItems } from "./tidy";

const repoId = (db.query("INSERT INTO repos (owner, name) VALUES ('tidy', 'repo') ON CONFLICT (owner, name) DO UPDATE SET owner = owner RETURNING id").get() as { id: number }).id;
let nextPr = 500;
function review(phase: string, opts: { recon?: boolean; startedDaysAgo?: number } = {}): number {
  const pr = nextPr++;
  const { id } = db
    .query(
      `INSERT INTO reviews (repo_id, pr_number, title, author, url, head_sha, head_ref, base_ref, phase, recon_json, started_at)
       VALUES (?, ?, ?, 'someone', '', ?, 'b', 'main', ?, ?, datetime('now', ?)) RETURNING id`,
    )
    .get(repoId, pr, `PR ${pr}`, `sha${pr}`, phase, opts.recon ? "{}" : null, `-${opts.startedDaysAgo ?? 0} days`) as { id: number };
  return id;
}

describe("killOnAbort", () => {
  test("SIGTERM on abort, so the spawned agent actually exits", async () => {
    const proc = Bun.spawn(["sleep", "30"]);
    const ctrl = new AbortController();
    const done = killOnAbort(proc, ctrl.signal);
    ctrl.abort();
    await proc.exited;
    done();
    expect(proc.signalCode).toBe("SIGTERM");
  });
  test("already aborted: killed straight away", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const proc = Bun.spawn(["sleep", "30"]);
    const done = killOnAbort(proc, ctrl.signal);
    await proc.exited;
    done();
    expect(proc.signalCode).toBe("SIGTERM");
  });
});

describe("run registry", () => {
  test("claim, abort, release; a newer claim isn't released by an older run", () => {
    const a = claimRun(9001, "recon");
    expect(hasRun(9001, "recon")).toBe(true);
    expect(abortRun(9001)).toBe(true);
    expect(a.signal.aborted).toBe(true);
    const b = claimRun(9001, "review");
    releaseRun(9001, a);
    expect(hasRun(9001, "review")).toBe(true);
    releaseRun(9001, b);
    expect(hasRun(9001)).toBe(false);
    expect(abortRun(9001)).toBe(false);
  });
});

describe("stopReview", () => {
  test("a running review with nothing in flight here settles as cancelled at once", () => {
    const id = review("reviewing", { recon: true });
    expect(stopReview(id)).toEqual({ stopping: false });
    expect(getRow(id)!.phase).toBe("cancelled");
  });
  test("with a run in flight it aborts and waits; force settles now", () => {
    const id = review("recon_running");
    const ctrl = claimRun(id, "recon");
    expect(stopReview(id)).toEqual({ stopping: true });
    expect(ctrl.signal.aborted).toBe(true);
    expect(getRow(id)!.phase).toBe("recon_running");
    stopReview(id, { force: true });
    expect(getRow(id)!.phase).toBe("cancelled");
    releaseRun(id, ctrl);
  });
  test("finished reviews are left alone", () => {
    const id = review("walkthrough", { recon: true });
    expect(stopReview(id)).toEqual({ stopping: false });
    expect(getRow(id)!.phase).toBe("walkthrough");
  });
});

describe("remove and undo", () => {
  test("cleared reviews leave the lists and the inbox badge; restore brings them back", () => {
    const id = review("failed", { recon: true });
    const pr = getRow(id)!.pr_number;
    clearReviews([id]);
    expect(listReviews().some((r) => r.id === id)).toBe(false);
    expect(latestReviewFor("tidy/repo", pr)).toBeNull();
    restoreReviews([id]);
    expect(listReviews().some((r) => r.id === id)).toBe(true);
    expect(latestReviewFor("tidy/repo", pr)?.id).toBe(id);
  });
  test("removing a running review stops it first", () => {
    const id = review("reviewing", { recon: true });
    clearReviews([id]);
    expect(getRow(id)!.phase).toBe("cancelled");
    restoreReviews([id]);
    expect(listReviews().find((r) => r.id === id)?.phase).toBe("cancelled");
  });
});

describe("hidden from the inbox", () => {
  test("hide, change mode, restore", () => {
    hideItems([{ key: "pr:tidy/repo#1", mode: "change", stamp: "2026-01-01T00:00:00Z", title: "One", meta: "repo#1" }]);
    expect(listHidden().find((h) => h.key === "pr:tidy/repo#1")?.mode).toBe("change");
    hideItems([{ key: "pr:tidy/repo#1", mode: "good", stamp: null, title: "One", meta: "repo#1" }]);
    expect(listHidden().find((h) => h.key === "pr:tidy/repo#1")?.mode).toBe("good");
    unhideItems(["pr:tidy/repo#1"]);
    expect(listHidden().some((h) => h.key === "pr:tidy/repo#1")).toBe(false);
  });
  test("rejects unknown keys and modes", () => {
    expect(() => hideItems([{ key: "nope", mode: "good", title: "x" }])).toThrow();
    expect(() => hideItems([{ key: "pr:a/b#1", mode: "later" as never, title: "x" }])).toThrow();
  });
});

describe("auto-clear", () => {
  test("off by default; clears old posted/stopped, keeps failed unless told", () => {
    const posted = review("submitted", { startedDaysAgo: 10 });
    const stopped = review("cancelled", { startedDaysAgo: 10 });
    const failed = review("failed", { startedDaysAgo: 10 });
    const fresh = review("submitted", { startedDaysAgo: 1 });
    const deciding = review("walkthrough", { startedDaysAgo: 10 });
    const cleared = (id: number) => (db.query("SELECT cleared_at FROM reviews WHERE id = ?").get(id) as { cleared_at: string | null }).cleared_at != null;
    expect(autoClearReviews()).toBe(0);
    saveHousekeeping({ clearFinishedDays: 7, keepFailed: true });
    autoClearReviews();
    expect([posted, stopped, failed, fresh, deciding].map(cleared)).toEqual([true, true, false, false, false]);
    saveHousekeeping({ keepFailed: false });
    autoClearReviews();
    expect(cleared(failed)).toBe(true);
    saveHousekeeping({ clearFinishedDays: 0, keepFailed: true });
  });
});
