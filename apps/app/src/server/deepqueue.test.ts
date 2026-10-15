// "I've read it" (or `bunny review --deep`) while the overview is still running only sets read_at;
// the deep review must start once the overview is in. Several reviews do this at once, so none
// waits on another.
import { afterAll, expect, mock, test } from "bun:test";
import { findPr } from "../mock/fixtures";

const started: number[] = [];
const realDeep = { ...(await import("./deep")) };
mock.module("./deep", () => ({ ...realDeep, startDeepReview: (id: number) => void started.push(id) }));
// An overview that succeeds after a moment, so several are in flight together.
const realAgents = { ...(await import("./agents")) };
mock.module("./agents", () => ({
  ...realAgents,
  runAgent: async () => {
    await Bun.sleep(20);
    return {
      sessionId: "s", structured: { summary: "ok", areas: [] }, text: "", isError: false, error: null, hitTurnLimit: false,
      costUsd: null, durationMs: null, inputTokens: null, outputTokens: null, denials: [], logPath: "",
    };
  },
}));
afterAll(() => {
  mock.module("./deep", () => realDeep);
  mock.module("./agents", () => realAgents);
});

const { db } = await import("./db/db");
const { getRow, localPrView, markRead, runRecon } = await import("./reviews");
const { makeReview } = await import("../mock/factories");

const scan = (id: number) => {
  const row = getRow(id)!;
  return runRecon(id, { owner: row.owner, repo: row.repo, number: row.pr_number }, localPrView(row, ""), { diff: "" });
};
const fresh = (n: number) => makeReview({ pr: findPr("quokka-labs/checkout", n)!, phase: "recon_running", runs: [], readMinutesAgo: null });

test("reviews read during their overview all start the deep review once it's in", async () => {
  const ids = [fresh(1482), fresh(1483), fresh(1484)];
  ids.forEach(markRead);
  await Promise.all(ids.map(scan));
  expect(started.sort()).toEqual([...ids].sort());
  for (const id of ids) expect(getRow(id)!.phase).toBe("recon_ready"); // startDeepReview is mocked
});

test("an unread review stops at the overview", async () => {
  started.length = 0;
  const id = fresh(1485);
  await scan(id);
  expect(started).toEqual([]);
  expect((db.query("SELECT phase FROM reviews WHERE id = ?").get(id) as { phase: string }).phase).toBe("recon_ready");
});
