// Fixes, end to end against the fake `gh` and `claude` (src/mock/bin) and real git: changes
// requested on your PR notify with Fix / Don't fix, Fix runs the agent in PR Bunny's own checkout,
// and Approve commits the diff and pushes it to the PR branch (a local bare "origin" here).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

process.env.PR_BUNNY_MOCK_STATE = mkdtempSync(join(tmpdir(), "pr-bunny-mock-"));
process.env.PR_BUNNY_MOCK_SPEED = "0";
const PATH = process.env.PATH;
process.env.PATH = `${join(import.meta.dir, "..", "mock", "bin")}:${PATH}`;

const { db } = await import("./db/db");
const { approveFix, declineFix, ensureFix, getFix, loadRequests, startFix } = await import("./fix");
const { feed, fixFromNotification, recordMyReview, skipFromNotification } = await import("./notify");
const { resetSettings, updateSettings } = await import("./settings");
const { ensureOrigins, originPath, mockStateDir } = await import("../mock/git");
const { findPr } = await import("../mock/fixtures");

const REPO = "quokka-labs/checkout";
const ref = { owner: "quokka-labs", repo: "checkout", number: 1495 };
let shas: Record<string, string> = {};

const review = (n: number, state: "CHANGES_REQUESTED" | "APPROVED", id = `rev-${n}-${state}`) => ({
  id,
  repo: REPO,
  number: n,
  title: findPr(REPO, n)!.title,
  url: `https://github.com/${REPO}/pull/${n}`,
  author: "jonah-pike",
  state,
  comments: 2,
  submittedAt: new Date().toISOString(),
});

async function settled(id: number) {
  for (let i = 0; i < 300; i++) {
    const f = getFix(id)!;
    if (f.state !== "running") return f;
    await Bun.sleep(100);
  }
  throw new Error("fix never finished");
}

const fresh = () => db.run("UPDATE fixes SET state = 'declined' WHERE state IN ('new', 'running', 'ready')");

// Other test files run in this process with their own fake gh and a different login.
afterAll(async () => {
  process.env.PATH = PATH;
  (await import("./gh")).forgetViewer();
  delete process.env.PR_BUNNY_MOCK_STATE;
});

beforeAll(async () => {
  resetSettings();
  shas = await ensureOrigins();
});

describe("changes requested on your PR", () => {
  test("notifies with its own kind, and falls back to an ordinary review when that's off", () => {
    const n = recordMyReview(review(1495, "CHANGES_REQUESTED", "a"))!;
    expect(n.kind).toBe("changesReq");
    expect(n.summary).toBe("@jonah-pike requested changes");
    expect(n.fix).toBeNull();
    expect(recordMyReview(review(1495, "APPROVED", "b"))!.kind).toBe("myReview");
    updateSettings({ notifications: { events: { changesReq: false } } as any });
    expect(recordMyReview(review(1495, "CHANGES_REQUESTED", "c"))!.kind).toBe("myReview");
    resetSettings();
  });

  test("loads what each reviewer still asks for, with inline comments", async () => {
    const reqs = await loadRequests(ref);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ author: "jonah-pike", body: expect.stringContaining("Two things") });
    expect(reqs[0]!.comments.map((c) => c.path)).toEqual(["src/lib/money.ts", "src/lib/money.ts"]);
    expect(reqs[0]!.comments.every((c) => typeof c.line === "number")).toBe(true);
  });

  test("Don't fix records the choice and runs nothing", async () => {
    fresh();
    const n = recordMyReview(review(1495, "CHANGES_REQUESTED", "skip"))!;
    const { fixId } = await skipFromNotification(n.id);
    expect(getFix(fixId)!).toMatchObject({ state: "skipped", headRef: "robin/intl-money" });
    expect(getFix(fixId)!.requests).toHaveLength(1);
    const item = feed().items.find((i) => i.id === n.id)!;
    expect(item).toMatchObject({ read: true, fix: { id: fixId, state: "skipped" } });
  });

  test("only your own PRs", async () => {
    await expect(ensureFix({ owner: "quokka-labs", repo: "checkout", number: 1490 })).rejects.toThrow(/only fixes your own PRs/);
  });

  test("Fix runs the agent, shows the diff, and Approve pushes it to the PR branch", async () => {
    fresh();
    const n = recordMyReview(review(1495, "CHANGES_REQUESTED", "fix"))!;
    const { fixId } = await fixFromNotification(n.id);
    const fix = await settled(fixId);
    expect(fix.error).toBeNull();
    expect(fix.state).toBe("ready");
    expect(fix.headSha).toBe(shas[`${REPO}#1495`]!);
    expect(fix.files.map((f) => f.path).sort()).toEqual(["src/lib/money.test.ts", "src/lib/money.ts"]);
    const money = fix.files.find((f) => f.path === "src/lib/money.ts")!;
    expect(money.lines.some((l) => l.kind === "del" && l.text.includes("console.log"))).toBe(true);
    expect(money.lines.some((l) => l.kind === "add" && l.text.includes("const key = `${locale}:${currency}`"))).toBe(true);
    expect(fix.addressed).toHaveLength(2);
    expect(fix.commitMessage).toBe("Key money formatters by locale and drop the debug log");
    // The fix checkout is gone once the diff is saved.
    expect((db.query("SELECT worktree_path AS p FROM fixes WHERE id = ?").get(fixId) as { p: string | null }).p).toBeNull();
    // The bell says it's ready, and the entry shows the fix's state.
    expect(feed().items.some((i) => i.kind === "fixReady" && i.pr === 1495)).toBe(true);
    expect(feed().items.find((i) => i.id === n.id)!.fix).toEqual({ id: fixId, state: "ready" });

    await expect(approveFix(fixId, { commitMessage: "x", headSha: "0".repeat(40) })).rejects.toThrow(/out of date/);
    const pushed = await approveFix(fixId, { commitMessage: "Key money formatters by locale\n\nCo-Authored-By: Bot <bot@example.com>", headSha: fix.headSha });
    expect(pushed.state).toBe("pushed");
    const origin = originPath(mockStateDir(), REPO);
    const tip = (await $`git rev-parse refs/heads/robin/intl-money`.cwd(origin).quiet()).stdout.toString().trim();
    expect(tip).toBe(pushed.pushed_sha!);
    const msg = (await $`git log -1 --format=%B ${tip}`.cwd(origin).quiet()).stdout.toString().trim();
    expect(msg).toBe("Key money formatters by locale");
    const parent = (await $`git rev-parse ${tip}^`.cwd(origin).quiet()).stdout.toString().trim();
    expect(parent).toBe(fix.headSha);
    const file = (await $`git show ${`${tip}:src/lib/money.ts`}`.cwd(origin).quiet()).stdout.toString();
    expect(file).not.toContain("console.log");
    // Put the branch back for the next test.
    await $`git update-ref refs/heads/robin/intl-money ${fix.headSha}`.cwd(origin).quiet();
  }, 60_000);

  test("Decline throws the diff away; the fix can run again", async () => {
    fresh();
    const f = await ensureFix(ref);
    startFix(f.id);
    expect((await settled(f.id)).state).toBe("ready");
    expect(declineFix(f.id).state).toBe("declined");
    expect(() => declineFix(f.id)).toThrow(/waiting for approval/);
    startFix(f.id);
    expect((await settled(f.id)).state).toBe("ready");
  }, 60_000);
});
