// A self-review's PR: finding it for the branch, reading its state, and the merge / mark-ready
// writes, against a fake `gh` on PATH that logs every call.
import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = mkdtempSync(join(tmpdir(), "pr-bunny-gh-"));
const LOG = join(bin, "calls.log");
const STATE = join(bin, "state"); // OPEN | MERGED
const AUTHOR = join(bin, "author");
writeFileSync(
  join(bin, "gh"),
  `#!/bin/sh
echo "$*" >> "${LOG}"
state="$(cat "${STATE}")"
case "$*" in
  "api user") echo '{"login":"me"}' ;;
  "pr list"*) echo '[{"number":9,"state":"OPEN","mergedAt":null,"closedAt":null}]' ;;
  "pr view"*)
    merged=null; [ "$state" = MERGED ] && merged='"2026-09-26T11:00:00Z"'
    cat <<JSON
{"number":9,"url":"https://github.com/acme/widgets/pull/9","title":"Counts","author":{"login":"$(cat "${AUTHOR}")"},"state":"$state","isDraft":false,
 "reviewDecision":"REVIEW_REQUIRED","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN",
 "statusCheckRollup":[{"__typename":"CheckRun","name":"test","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":"https://ci/1","startedAt":"2026-09-26T10:00:00Z","completedAt":"2026-09-26T10:03:12Z"}],
 "latestReviews":[{"author":{"login":"jkim"},"state":"COMMENTED"}],"reviewRequests":[{"login":"lwen"},{"slug":"platform","organization":{"login":"acme"}}],
 "baseRefName":"main","headRefName":"feat/x","headRefOid":"${"b".repeat(40)}","commits":[{},{},{}],"createdAt":"2026-09-26T09:00:00Z",
 "mergedAt":$merged,"mergedBy":{"login":"me"},"mergeCommit":{"oid":"${"c".repeat(40)}"},"closedAt":null,"isCrossRepository":false}
JSON
    ;;
  "api repos/acme/widgets") echo '{"allow_merge_commit":false,"allow_squash_merge":true,"allow_rebase_merge":true}' ;;
  "api repos/acme/widgets/compare/"*) echo '{"ahead_by":2,"behind_by":0}' ;;
  "api repos/acme/widgets/branches/"*) exit 1 ;;
  "pr merge"*) echo MERGED > "${STATE}" ;;
  "pr ready"*) ;;
  "api -X DELETE"*) ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const { db } = await import("./db/db");
const { selfPr, mergePr, markReady } = await import("./prstate");

const calls = () => readFileSync(LOG, "utf8").trim().split("\n");
let id = 0;
beforeEach(() => {
  writeFileSync(LOG, "");
  writeFileSync(STATE, "OPEN");
  writeFileSync(AUTHOR, "me");
  db.run("INSERT OR IGNORE INTO repos (owner, name) VALUES ('acme', 'widgets')");
  id = (
    db
      .query(
        `INSERT INTO reviews (repo_id, pr_number, title, author, url, head_sha, branch_sha, head_ref, base_ref, phase, mode)
         SELECT id, 0, 'Counts', 'me', '', ?, ?, 'feat/x', 'main', 'walkthrough', 'self' FROM repos WHERE owner = 'acme' AND name = 'widgets' RETURNING id`,
      )
      .get("a".repeat(40), "a".repeat(40)) as { id: number }
  ).id;
});

describe("selfPr", () => {
  test("finds the open PR for the branch, links it, and reads its state", async () => {
    const pr = (await selfPr(id))!;
    expect(pr).toMatchObject({ number: 9, state: "open", author: "me", viewer: "me", commits: 3, newCommits: 2, methods: ["squash", "rebase"] });
    expect(pr.checks).toEqual([{ name: "test", state: "pass", url: "https://ci/1", took: "3m 12s" }]);
    expect(pr.reviews).toEqual([
      { h: "jkim", st: "commented" },
      { h: "lwen", st: "requested" },
      { h: "@acme/platform", st: "requested" },
    ]);
    const row = db.query("SELECT opened_pr_number AS n, pr_snap_json AS snap FROM reviews WHERE id = ?").get(id) as { n: number; snap: string };
    expect(row.n).toBe(9);
    expect(JSON.parse(row.snap)).toMatchObject({ number: 9, state: "open", checksLine: "1 of 1 check passed" });
    expect(calls().some((c) => /^pr (merge|ready|edit|create)/.test(c))).toBe(false);
  });
});

describe("mergePr", () => {
  test("merges the commit shown, outside any checkout, then deletes the branch", async () => {
    await selfPr(id);
    const after = await mergePr(id, { method: "squash", deleteBranch: true, headSha: "b".repeat(40) });
    expect(after).toMatchObject({ state: "merged", mergeCommit: "c".repeat(40), branchDeleted: true });
    expect(calls()).toContain(`pr merge 9 -R acme/widgets --squash --match-head-commit ${"b".repeat(40)}`);
    expect(calls()).toContain("api -X DELETE repos/acme/widgets/git/refs/heads/feat/x");
    expect(JSON.parse((db.query("SELECT pr_snap_json AS s FROM reviews WHERE id = ?").get(id) as { s: string }).s).state).toBe("merged");
  });

  test("refuses when new commits were pushed since the page loaded", async () => {
    await selfPr(id);
    await expect(mergePr(id, { method: "squash", deleteBranch: false, headSha: "d".repeat(40) })).rejects.toThrow(/New commits were pushed/);
    expect(calls().some((c) => c.startsWith("pr merge"))).toBe(false);
  });

  test("refuses a method the repo doesn't allow, and someone else's PR", async () => {
    await selfPr(id);
    await expect(mergePr(id, { method: "merge", deleteBranch: false, headSha: "b".repeat(40) })).rejects.toThrow(/doesn't allow/);
    writeFileSync(AUTHOR, "jkim");
    await expect(mergePr(id, { method: "squash", deleteBranch: false, headSha: "b".repeat(40) })).rejects.toThrow(/leaves merging it to them/);
    await expect(markReady(id)).rejects.toThrow(/leaves merging it to them/);
    expect(calls().some((c) => c.startsWith("pr merge") || c.startsWith("pr ready"))).toBe(false);
  });
});
