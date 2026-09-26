// One active review per PR: concurrent starts (a click, the CLI, the stack runner's tick) share one
// review, and a stack running Review all owns the PR's review. `gh` is answered from the mock
// fixtures (src/mock); the overview never gets past fetching the diff, so each started review stays
// "recon_running" (in flight).
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { findPr, STACKS, type FixturePr } from "../mock/fixtures";
import { fixtureGh } from "../mock/ghStub";

const real = await import("./gh");
const fixtures = fixtureGh();
let prViewCalls = 0;
let diffsToServe = 0;
mock.module("./gh", () => ({
  ...real,
  ...fixtures,
  // A little latency so near-simultaneous starts overlap, as they do against the real gh.
  prView: async (ref: Parameters<typeof fixtures.prView>[0]) => {
    prViewCalls++;
    await Bun.sleep(20);
    return fixtures.prView(ref);
  },
  // Never resolves, so the review stays in flight; a re-review test can serve a few diffs first.
  prDiff: (ref: Parameters<typeof fixtures.prDiff>[0]) => (diffsToServe > 0 ? (diffsToServe--, fixtures.prDiff(ref)) : new Promise<string>(() => {})),
}));
// A re-review goes straight to the deep review: don't run it, so the new review stays "read" (in flight).
const realDeep = await import("./deep");
mock.module("./deep", () => ({ ...realDeep, startDeepReview: () => {} }));
// Never run a real agent (e.g. a recon that got a served diff).
const realAgents = await import("./agents");
mock.module("./agents", () => ({ ...realAgents, runAgent: async () => { throw new Error("No agent in tests"); } }));

const { db } = await import("./db/db");
const { startReview, setPhase } = await import("./reviews");
const { startSelfReview } = await import("./self");
const { startLayer } = await import("./stacks");
const { startRereview } = await import("./actions");
const { makeReview, makeStack } = await import("../mock/factories");

const pr = (repo: string, n: number) => findPr(`quokka-labs/${repo}`, n)!;
const ref = (p: FixturePr) => `${p.repo}#${p.number}`;
// Someone else's PR, and one of the viewer's own (a self-review).
const PEER = pr("api", 231);
const MINE = pr("api", 240);
// The checkout-v2 stack: #1482 → #1483 → #1484 → #1485.
const [L1, L2, L3] = [pr("checkout", 1482), pr("checkout", 1483), pr("checkout", 1484)];
// PRs to re-review.
const [RR1, RR2, RR3] = [pr("mobile", 88), pr("checkout", 1490), pr("api", 236)];

/** A finished review of an older commit of the PR, to re-review. */
const finishedReview = (p: FixturePr) => makeReview({ pr: p, phase: "walkthrough", headSha: "old", findings: false, runs: [] });
const reviewsOf = (p: FixturePr) =>
  db
    .query("SELECT v.id, v.mode, v.phase FROM reviews v JOIN repos r ON r.id = v.repo_id WHERE r.owner || '/' || r.name = ? AND v.pr_number = ?")
    .all(p.repo, p.number) as Array<{ id: number; mode: string; phase: string }>;
const layerReview = (stackId: number, p: FixturePr) =>
  (db.query("SELECT review_id FROM stack_layers WHERE stack_id = ? AND pr_number = ?").get(stackId, p.number) as { review_id: number | null }).review_id;

let stackId = 0;
beforeAll(() => {
  stackId = makeStack({ stack: STACKS.find((s) => s.name === "checkout-v2")!, runState: "running" });
});

describe("one review per PR", () => {
  test("concurrent starts of the same PR share one review", async () => {
    const before = prViewCalls;
    const ids = await Promise.all([startReview(ref(PEER)), startReview(ref(PEER)), startReview(`https://github.com/Quokka-Labs/API/pull/${PEER.number}`)]);
    expect(new Set(ids).size).toBe(1);
    expect(reviewsOf(PEER)).toHaveLength(1);
    expect(prViewCalls - before).toBe(1);
  });

  test("`fresh` returns the running review instead of starting a second", async () => {
    const [first] = reviewsOf(PEER);
    expect(first!.phase).toBe("recon_running");
    expect(await startReview(ref(PEER), undefined, { fresh: true })).toBe(first!.id);
    setPhase(first!.id, "reviewing");
    expect(await startReview(ref(PEER), undefined, { fresh: true })).toBe(first!.id);
    expect(reviewsOf(PEER)).toHaveLength(1);
  });

  test("a finished review is replaced by `fresh`, a failed one by any start", async () => {
    const [first] = reviewsOf(PEER);
    setPhase(first!.id, "walkthrough");
    expect(await startReview(ref(PEER))).toBe(first!.id); // same commit, not fresh: reopen it
    const second = await startReview(ref(PEER), undefined, { fresh: true });
    expect(second).not.toBe(first!.id);
    setPhase(second, "failed");
    const third = await startReview(ref(PEER));
    expect([first!.id, second]).not.toContain(third);
  });

  test("your own PR: the self-review delegation shares the same guard", async () => {
    const [a, b, c] = await Promise.all([startReview(ref(MINE)), startSelfReview({ repo: MINE.repo, pr: MINE.number }), startReview(ref(MINE), undefined, { fresh: true })]);
    expect(b.id).toBe(a);
    expect(c).toBe(a);
    expect(reviewsOf(MINE)).toEqual([{ id: a, mode: "self", phase: "recon_running" }]);
  });
});

describe("a stack running Review all owns its PRs' reviews", () => {
  test("a standalone start and the stack's start of a layer share one review, and the layer adopts it", async () => {
    const [mine, layer] = await Promise.all([startReview(ref(L2)), startLayer(stackId, L2.number)]);
    expect(layer).toBe(mine);
    expect(reviewsOf(L2)).toHaveLength(1);
    expect(layerReview(stackId, L2)).toBe(mine);
  });

  test("a standalone start of a waiting layer becomes the layer's review", async () => {
    expect(layerReview(stackId, L1)).toBeNull();
    const id = await startReview(ref(L1));
    expect(layerReview(stackId, L1)).toBe(id);
    // The stack then starting the layer (as its tick would) gets the same review back.
    expect(await startLayer(stackId, L1.number)).toBe(id);
    expect(reviewsOf(L1)).toHaveLength(1);
  });

  test("restarting a failed layer while your own review of it runs adopts yours", async () => {
    const failed = await startReview(ref(L3));
    setPhase(failed, "failed");
    const yours = await startReview(ref(L3));
    expect(yours).not.toBe(failed);
    // A stale link to the failed review (e.g. a tick that read the layer before yours started).
    db.run("UPDATE stack_layers SET review_id = ? WHERE stack_id = ? AND pr_number = ?", [failed, stackId, L3.number]);
    expect(await startLayer(stackId, L3.number)).toBe(yours);
    expect(layerReview(stackId, L3)).toBe(yours);
    expect(reviewsOf(L3).filter((r) => r.phase === "recon_running")).toHaveLength(1);
  });
});

describe("re-review: one at a time per PR", () => {
  test("concurrent re-reviews of the same PR give one new review", async () => {
    const prev = finishedReview(RR1);
    diffsToServe = 3; // enough for all three, were the guard missing
    const ids = await Promise.all([startRereview(prev), startRereview(prev), startRereview(prev)]);
    diffsToServe = 0;
    expect(new Set(ids).size).toBe(1);
    expect(reviewsOf(RR1).filter((r) => r.id !== prev)).toEqual([{ id: ids[0]!, mode: "peer", phase: "read" }]);
    // Once it's running, another re-review returns it.
    expect(await startRereview(prev)).toBe(ids[0]!);
    expect(reviewsOf(RR1)).toHaveLength(2);
  });

  test("a re-review racing a start of the same PR gives one review", async () => {
    const prev = finishedReview(RR2);
    diffsToServe = 2;
    const [a, b] = await Promise.all([startRereview(prev), startReview(ref(RR2))]);
    diffsToServe = 0;
    expect(b).toBe(a);
    expect(reviewsOf(RR2).filter((r) => r.id !== prev)).toHaveLength(1);

    // The other way round.
    const prev3 = finishedReview(RR3);
    diffsToServe = 2;
    const [c, d] = await Promise.all([startReview(ref(RR3)), startRereview(prev3)]);
    diffsToServe = 0;
    expect(d).toBe(c);
    expect(reviewsOf(RR3).filter((r) => r.id !== prev3)).toHaveLength(1);
  });

  test("a re-review of a stack layer becomes the layer's review", async () => {
    const prev = finishedReview(L3);
    db.run("UPDATE reviews SET phase = 'failed' WHERE id IN (SELECT v.id FROM reviews v JOIN repos r ON r.id = v.repo_id WHERE r.name = 'checkout' AND v.pr_number = ? AND v.phase = 'recon_running')", [L3.number]);
    diffsToServe = 1;
    const id = await startRereview(prev);
    diffsToServe = 0;
    expect(layerReview(stackId, L3)).toBe(id);
  });
});
