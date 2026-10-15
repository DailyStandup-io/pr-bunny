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
const { approveFix, declineFix, ensureFix, getFix, loadRequests, standingRequests, startFix, writeTools } = await import("./fix");
const { prepareFixWorktree, stagedChanges, unsupportedChanges } = await import("./git");
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

  test("a dismissed or approving review lifts the request; a comment doesn't", () => {
    const r = (author: string, state: string, at: string, id = Math.random()) => ({ id, author, state, body: "", submittedAt: at, url: "" });
    const ids = (xs: Array<{ author: string; submittedAt: string }>) => xs.map((x) => `${x.author}@${x.submittedAt}`);
    expect(ids(standingRequests([r("ana", "CHANGES_REQUESTED", "1"), r("ana", "COMMENTED", "2")], "me"))).toEqual(["ana@1"]);
    expect(standingRequests([r("ana", "CHANGES_REQUESTED", "1"), r("ana", "APPROVED", "2")], "me")).toEqual([]);
    // Requested twice, the second dismissed: GitHub no longer counts either.
    expect(standingRequests([r("ana", "CHANGES_REQUESTED", "1"), r("ana", "CHANGES_REQUESTED", "2"), r("ana", "DISMISSED", "3")], "me")).toEqual([]);
    expect(standingRequests([r("ME", "CHANGES_REQUESTED", "1")], "me")).toEqual([]);
  });

  test("the agent gets no shell, and edits only inside its checkout", () => {
    const t = writeTools("/wt/fix-1");
    expect(t.tools).not.toContain("Bash");
    expect(t.allowedTools.every((a) => a.startsWith("Read(//wt/fix-1/") || a.startsWith("Edit(//wt/fix-1/") || a.startsWith("Write(//wt/fix-1/"))).toBe(true);
  });

  test("changes the diff page can't show faithfully are refused", () => {
    expect(unsupportedChanges("diff --git a/x b/x\nold mode 100644\nnew mode 100755\n")).toMatch(/mode/);
    expect(unsupportedChanges("diff --git a/l b/l\nnew file mode 120000\n")).toMatch(/symlink/);
    expect(unsupportedChanges("diff --git a/s b/s\nnew file mode 160000\n")).toMatch(/submodule/);
    expect(unsupportedChanges("", ["logo.png"])).toMatch(/binary file \(logo.png\)/);
    expect(unsupportedChanges("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n")).toBeNull();
  });

  test("a checkout whose .git was rewritten during the fix isn't read", async () => {
    const wt = await prepareFixWorktree({ fixId: 999, owner: "quokka-labs", repo: "checkout", prNumber: 1495, headSha: shas[`${REPO}#1495`]! }, () => {});
    await Bun.write(join(wt.path, "src/lib/money.ts"), "changed\n");
    expect((await stagedChanges(wt.path, wt.gitDir)).files.map((f) => f.path)).toEqual(["src/lib/money.ts"]);
    // An agent pointing .git at a folder it controls (whose config could run commands) is caught.
    await Bun.write(join(wt.path, ".git"), "gitdir: ./evil\n");
    await expect(stagedChanges(wt.path, wt.gitDir)).rejects.toThrow(/\.git was changed/);
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

    await expect(approveFix(fixId, { commitMessage: "x", headSha: "0".repeat(40), diffHash: fix.diffHash })).rejects.toThrow(/out of date/);
    // A different diff than the one the page showed (e.g. re-run in another tab) is refused.
    await expect(approveFix(fixId, { commitMessage: "x", headSha: fix.headSha, diffHash: "0".repeat(64) })).rejects.toThrow(/out of date/);
    // Two clicks at once: one pushes, the other is refused.
    const [pushed, second] = await Promise.allSettled([
      approveFix(fixId, { commitMessage: "Key money formatters by locale\n\nSigned-off-by: Tom <tom@example.com>", headSha: fix.headSha, diffHash: fix.diffHash }),
      approveFix(fixId, { commitMessage: "other", headSha: fix.headSha, diffHash: fix.diffHash }),
    ]).then((r) => [r[0].status === "fulfilled" ? r[0].value : null, r[1]] as const);
    expect(second.status).toBe("rejected");
    if (!pushed) throw new Error("the first approve failed");
    expect(pushed.state).toBe("pushed");
    const origin = originPath(mockStateDir(), REPO);
    const tip = (await $`git rev-parse refs/heads/robin/intl-money`.cwd(origin).quiet()).stdout.toString().trim();
    expect(tip).toBe(pushed.pushed_sha!);
    const msg = (await $`git log -1 --format=%B ${tip}`.cwd(origin).quiet()).stdout.toString().trim();
    // Your message as typed: a sign-off you wrote stays.
    expect(msg).toBe("Key money formatters by locale\n\nSigned-off-by: Tom <tom@example.com>");
    const parent = (await $`git rev-parse ${tip}^`.cwd(origin).quiet()).stdout.toString().trim();
    expect(parent).toBe(fix.headSha);
    const file = (await $`git show ${`${tip}:src/lib/money.ts`}`.cwd(origin).quiet()).stdout.toString();
    expect(file).not.toContain("console.log");
    // Put the branch back for the next test.
    await $`git update-ref refs/heads/robin/intl-money ${fix.headSha}`.cwd(origin).quiet();
  }, 60_000);

  test("refuses PRs from a fork (the push would land on the base repo)", async () => {
    fresh();
    process.env.PR_BUNNY_MOCK_FORK_PRS = `${REPO}#1495`;
    try {
      await expect(ensureFix(ref)).rejects.toThrow(/comes from a fork/);
    } finally {
      delete process.env.PR_BUNNY_MOCK_FORK_PRS;
    }
  });

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
