import { describe, expect, test } from "bun:test";
import type { SelfPr } from "./types";
import { parseSnapshot, pillOf, prSummary, snapshotOf } from "./pr";

const PR: SelfPr = {
  number: 9,
  url: "https://github.com/acme/widgets/pull/9",
  title: "Counts",
  author: "me",
  viewer: "me",
  state: "open",
  draft: false,
  decision: null,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  protection: null,
  checks: [
    { name: "test", state: "pass", url: null, took: "1m 2s" },
    { name: "lint", state: "pass", url: null, took: "9s" },
  ],
  reviews: [],
  base: "main",
  head: "feat/x",
  headSha: "a".repeat(40),
  commits: 3,
  createdAt: "2026-09-26T10:00:00Z",
  newCommits: 0,
  crossRepo: false,
  mergedBy: null,
  mergedAt: null,
  mergeCommit: null,
  branchDeleted: null,
  closedAt: null,
  methods: ["merge", "squash", "rebase"],
  fetchedAt: "2026-09-26T10:05:00Z",
};
const pr = (patch: Partial<SelfPr>): SelfPr => ({ ...PR, ...patch });

describe("prSummary", () => {
  test("clean and passing can merge", () => {
    const s = prSummary(PR);
    expect(s.canMerge).toBe(true);
    expect(s.blocked).toBeNull();
    expect(s.checksLine).toBe("2 of 2 checks passed");
    expect(s.status).toBe("in review");
  });

  test("blockers in order: draft, conflicts, failed, running, unknown, protection", () => {
    const failing = [{ name: "test", state: "fail" as const, url: null, took: "3m 1s" }];
    const running = [{ name: "build", state: "running" as const, url: null, took: null }];
    expect(prSummary(pr({ draft: true, mergeable: "CONFLICTING", checks: failing })).blocked?.key).toBe("draft");
    expect(prSummary(pr({ mergeable: "CONFLICTING", checks: failing })).blocked?.key).toBe("conflicts");
    expect(prSummary(pr({ mergeStateStatus: "DIRTY" })).blocked?.title).toBe("Conflicts with main");
    expect(prSummary(pr({ checks: [...failing, ...running] })).blocked?.key).toBe("failed");
    expect(prSummary(pr({ checks: running })).blocked).toMatchObject({ key: "running", title: "Waiting for 1 check", sub: "build. This updates on its own." });
    expect(prSummary(pr({ mergeable: "UNKNOWN" })).blocked?.key).toBe("checking");
    expect(prSummary(pr({ protection: "Needs an approving review" })).blocked).toMatchObject({ key: "protected", sub: "Needs an approving review on main." });
    for (const p of [pr({ draft: true }), pr({ checks: running }), pr({ protection: "x" })]) expect(prSummary(p).canMerge).toBe(false);
  });

  test("the review decision alone doesn't block", () => {
    expect(prSummary(pr({ decision: "REVIEW_REQUIRED" })).canMerge).toBe(true);
    expect(prSummary(pr({ decision: "CHANGES_REQUESTED" })).status).toBe("changes requested");
  });

  test("failed check links go to the check, or the PR's checks page", () => {
    const s = prSummary(pr({ checks: [{ name: "test", state: "fail", url: "https://ci/1", took: null }, { name: "e2e", state: "fail", url: null, took: null }] }));
    expect(s.checksLine).toBe("2 of 2 checks failed");
    expect(s.blocked?.links?.map((l) => l.url)).toEqual(["https://ci/1", `${PR.url}/checks`]);
    expect(s.ind[0]).toBe("cancel");
  });

  test("merged and closed never block and can't merge", () => {
    expect(prSummary(pr({ state: "merged", draft: true })).blocked).toBeNull();
    expect(prSummary(pr({ state: "merged" })).canMerge).toBe(false);
    expect(prSummary(pr({ state: "closed" })).status).toBe("closed");
  });
});

describe("list pill", () => {
  test("in review with an indicator, then done once merged", () => {
    const open = parseSnapshot(JSON.stringify(snapshotOf(pr({ decision: "APPROVED" }))))!;
    expect(pillOf(open)).toMatchObject({ status: "In review · #9", ind: ["check_circle", "var(--add)", "Approved · 2 of 2 checks passed"] });
    expect(pillOf(snapshotOf(pr({ state: "merged", mergedAt: "2026-09-26T11:00:00Z" }))).status).toBe("Done · merged");
    expect(pillOf(snapshotOf(pr({ state: "closed" }))).status).toBe("Closed");
    expect(parseSnapshot("not json")).toBeNull();
  });
});
