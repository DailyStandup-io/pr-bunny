// One active review per PR: concurrent starts (a click, the CLI, the stack runner's tick) share one
// review, and a stack running Review all owns the PR's review. `gh` is mocked; the overview never
// gets past fetching the diff, so each started review stays "recon_running" (in flight).
import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { PrView } from "./gh";

const real = await import("./gh");
let prViewCalls = 0;
let diffsToServe = 0;
const ME = "me";
mock.module("./gh", () => ({
  ...real,
  // A little latency so near-simultaneous starts overlap, as they do against the real gh.
  prView: async (ref: { owner: string; repo: string; number: number }): Promise<PrView> => {
    prViewCalls++;
    await Bun.sleep(20);
    return {
      number: ref.number,
      title: `PR ${ref.number}`,
      body: "",
      url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      author: ref.number >= 20 ? ME : "someone",
      isDraft: false,
      state: "OPEN",
      headRefName: `b${ref.number}`,
      headRefOid: `sha${ref.number}`,
      baseRefName: "main",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      labels: [],
      files: [{ path: "a.ts", additions: 1, deletions: 0 }],
    };
  },
  viewer: async () => ME,
  // Never resolves, so the review stays in flight; a re-review test can serve a few diffs first.
  prDiff: () => (diffsToServe > 0 ? (diffsToServe--, Promise.resolve("")) : new Promise<string>(() => {})),
  listOpenPrs: async () => [],
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

const REPO = "acme/widgets";
/** A finished review of an older commit of the PR, to re-review. */
const finishedReview = (pr: number) =>
  (db
    .query(
      `INSERT INTO reviews (repo_id, pr_number, title, author, url, head_sha, head_ref, base_ref, phase)
       SELECT id, ?, 'PR', 'someone', '', 'old', 'b', 'main', 'walkthrough' FROM repos WHERE owner = 'acme' AND name = 'widgets' RETURNING id`,
    )
    .get(pr) as { id: number }).id;
const reviewsOf = (pr: number) =>
  db.query("SELECT v.id, v.mode, v.phase FROM reviews v JOIN repos r ON r.id = v.repo_id WHERE r.owner = 'acme' AND r.name = 'widgets' AND v.pr_number = ?").all(pr) as Array<{
    id: number;
    mode: string;
    phase: string;
  }>;
const layerReview = (stackId: number, pr: number) =>
  (db.query("SELECT review_id FROM stack_layers WHERE stack_id = ? AND pr_number = ?").get(stackId, pr) as { review_id: number | null }).review_id;

let stackId = 0;
beforeAll(() => {
  const { id: repoId } = db.query("INSERT INTO repos (owner, name) VALUES ('acme', 'widgets') ON CONFLICT (owner, name) DO UPDATE SET owner = owner RETURNING id").get() as { id: number };
  stackId = (db.query("INSERT INTO stacks (repo_id, root_pr, base_ref, title, run_state) VALUES (?, 10, 'main', 'Stack', 'running') RETURNING id").get(repoId) as { id: number }).id;
  for (const [pr, depth, parent] of [[10, 1, null], [11, 2, 10], [12, 3, 11]] as const)
    db.run(
      "INSERT INTO stack_layers (stack_id, pr_number, depth, parent_pr, title, author, head_ref, base_ref, head_sha) VALUES (?, ?, ?, ?, ?, 'someone', ?, ?, ?)",
      [stackId, pr, depth, parent, `PR ${pr}`, `b${pr}`, parent ? `b${parent}` : "main", `sha${pr}`],
    );
});

describe("one review per PR", () => {
  test("concurrent starts of the same PR share one review", async () => {
    const before = prViewCalls;
    const ids = await Promise.all([startReview(`${REPO}#1`), startReview(`${REPO}#1`), startReview(`https://github.com/ACME/Widgets/pull/1`)]);
    expect(new Set(ids).size).toBe(1);
    expect(reviewsOf(1)).toHaveLength(1);
    expect(prViewCalls - before).toBe(1);
  });

  test("`fresh` returns the running review instead of starting a second", async () => {
    const [first] = reviewsOf(1);
    expect(first!.phase).toBe("recon_running");
    expect(await startReview(`${REPO}#1`, undefined, { fresh: true })).toBe(first!.id);
    setPhase(first!.id, "reviewing");
    expect(await startReview(`${REPO}#1`, undefined, { fresh: true })).toBe(first!.id);
    expect(reviewsOf(1)).toHaveLength(1);
  });

  test("a finished review is replaced by `fresh`, a failed one by any start", async () => {
    const [first] = reviewsOf(1);
    setPhase(first!.id, "walkthrough");
    expect(await startReview(`${REPO}#1`)).toBe(first!.id); // same commit, not fresh: reopen it
    const second = await startReview(`${REPO}#1`, undefined, { fresh: true });
    expect(second).not.toBe(first!.id);
    setPhase(second, "failed");
    const third = await startReview(`${REPO}#1`);
    expect([first!.id, second]).not.toContain(third);
  });

  test("your own PR: the self-review delegation shares the same guard", async () => {
    const [a, b, c] = await Promise.all([startReview(`${REPO}#20`), startSelfReview({ repo: REPO, pr: 20 }), startReview(`${REPO}#20`, undefined, { fresh: true })]);
    expect(b.id).toBe(a);
    expect(c).toBe(a);
    expect(reviewsOf(20)).toEqual([{ id: a, mode: "self", phase: "recon_running" }]);
  });
});

describe("a stack running Review all owns its PRs' reviews", () => {
  test("a standalone start and the stack's start of a layer share one review, and the layer adopts it", async () => {
    const [mine, layer] = await Promise.all([startReview(`${REPO}#11`), startLayer(stackId, 11)]);
    expect(layer).toBe(mine);
    expect(reviewsOf(11)).toHaveLength(1);
    expect(layerReview(stackId, 11)).toBe(mine);
  });

  test("a standalone start of a waiting layer becomes the layer's review", async () => {
    expect(layerReview(stackId, 10)).toBeNull();
    const id = await startReview(`${REPO}#10`);
    expect(layerReview(stackId, 10)).toBe(id);
    // The stack then starting the layer (as its tick would) gets the same review back.
    expect(await startLayer(stackId, 10)).toBe(id);
    expect(reviewsOf(10)).toHaveLength(1);
  });

  test("restarting a failed layer while your own review of it runs adopts yours", async () => {
    const failed = await startReview(`${REPO}#12`);
    setPhase(failed, "failed");
    const yours = await startReview(`${REPO}#12`);
    expect(yours).not.toBe(failed);
    // A stale link to the failed review (e.g. a tick that read the layer before yours started).
    db.run("UPDATE stack_layers SET review_id = ? WHERE stack_id = ? AND pr_number = 12", [failed, stackId]);
    expect(await startLayer(stackId, 12)).toBe(yours);
    expect(layerReview(stackId, 12)).toBe(yours);
    expect(reviewsOf(12).filter((r) => r.phase === "recon_running")).toHaveLength(1);
  });
});

describe("re-review: one at a time per PR", () => {
  test("concurrent re-reviews of the same PR give one new review", async () => {
    const prev = finishedReview(5);
    diffsToServe = 3; // enough for all three, were the guard missing
    const ids = await Promise.all([startRereview(prev), startRereview(prev), startRereview(prev)]);
    diffsToServe = 0;
    expect(new Set(ids).size).toBe(1);
    expect(reviewsOf(5).filter((r) => r.id !== prev)).toEqual([{ id: ids[0]!, mode: "peer", phase: "read" }]);
    // Once it's running, another re-review returns it.
    expect(await startRereview(prev)).toBe(ids[0]!);
    expect(reviewsOf(5)).toHaveLength(2);
  });

  test("a re-review racing a start of the same PR gives one review", async () => {
    const prev = finishedReview(6);
    diffsToServe = 2;
    const [a, b] = await Promise.all([startRereview(prev), startReview(`${REPO}#6`)]);
    diffsToServe = 0;
    expect(b).toBe(a);
    expect(reviewsOf(6).filter((r) => r.id !== prev)).toHaveLength(1);

    // The other way round.
    const prev7 = finishedReview(7);
    diffsToServe = 2;
    const [c, d] = await Promise.all([startReview(`${REPO}#7`), startRereview(prev7)]);
    diffsToServe = 0;
    expect(d).toBe(c);
    expect(reviewsOf(7).filter((r) => r.id !== prev7)).toHaveLength(1);
  });

  test("a re-review of a stack layer becomes the layer's review", async () => {
    const prev = finishedReview(12);
    db.run("UPDATE reviews SET phase = 'failed' WHERE pr_number = 12 AND phase = 'recon_running'");
    diffsToServe = 1;
    const id = await startRereview(prev);
    diffsToServe = 0;
    expect(layerReview(stackId, 12)).toBe(id);
  });
});
