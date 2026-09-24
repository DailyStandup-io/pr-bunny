import { describe, expect, test } from "bun:test";
import { groupAreas, heuristicMinutes } from "./areas";
import { buildArgs, describeEvent, subscriptionEnv } from "./claude";
import { parsePrRef } from "./gh";
import { findStack } from "./stack";

describe("parsePrRef", () => {
  test("url, short form, bare number", () => {
    expect(parsePrRef("https://github.com/acme/widgets/pull/1859/files")).toEqual({ owner: "acme", repo: "widgets", number: 1859 });
    expect(parsePrRef("acme/widgets#12")).toEqual({ owner: "acme", repo: "widgets", number: 12 });
    expect(parsePrRef("#7", "a/b")).toEqual({ owner: "a", repo: "b", number: 7 });
  });
  test("bare number without a default repo is an error", () => {
    expect(() => parsePrRef("7")).toThrow(/full URL/);
  });
});

describe("findStack", () => {
  const open = [
    { number: 1, title: "one", headRefName: "a", baseRefName: "main" },
    { number: 2, title: "two", headRefName: "b", baseRefName: "a" },
    { number: 3, title: "three", headRefName: "c", baseRefName: "b" },
    { number: 4, title: "four", headRefName: "d", baseRefName: "c" },
    { number: 5, title: "sibling", headRefName: "e", baseRefName: "c" },
    { number: 9, title: "unrelated", headRefName: "z", baseRefName: "main" },
  ];
  test("walks parents down and children (tree) up", () => {
    const stack = findStack({ number: 3, headRefName: "c", baseRefName: "b" }, open);
    expect(stack.filter((s) => s.relation === "parent").map((s) => [s.number, s.depth])).toEqual([[2, 1], [1, 2]]);
    expect(stack.filter((s) => s.relation === "child").map((s) => s.number).sort()).toEqual([4, 5]);
    expect(stack.some((s) => s.number === 9)).toBe(false);
  });
  test("standalone PR has no stack", () => {
    expect(findStack({ number: 9, headRefName: "z", baseRefName: "main" }, open)).toEqual([]);
  });
});

describe("areas", () => {
  const files = [
    { path: "services/api/src/enroll/enroll.service.ts", additions: 100, deletions: 10 },
    { path: "services/api/src/enroll/enroll.dto.ts", additions: 20, deletions: 5 },
    { path: "services/api/prisma/migrations/1/migration.sql", additions: 12, deletions: 0 },
    { path: "infra/main.tf", additions: 3, deletions: 1 },
    { path: "README.md", additions: 2, deletions: 0 },
  ];
  test("groups by package + meaningful subdir, biggest first", () => {
    expect(groupAreas(files).map((a) => a.path)).toEqual(["services/api/src/enroll", "services/api/prisma", "infra", "(root)"]);
  });
  test("collapses to package level when too fragmented", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `services/api/src/m${i}/x.ts`, additions: 1, deletions: 0 }));
    expect(groupAreas(many).map((a) => a.path)).toEqual(["services/api"]);
  });
  test("heuristic ignores lockfiles and discounts tests", () => {
    const lock = heuristicMinutes([{ path: "bun.lock", additions: 5000, deletions: 5000 }]);
    const tests = heuristicMinutes([{ path: "src/a.test.ts", additions: 500, deletions: 0 }]);
    const code = heuristicMinutes([{ path: "src/a.ts", additions: 500, deletions: 0 }]);
    expect(lock).toBeLessThan(10);
    expect(tests).toBeLessThan(code);
  });
});

describe("claude runner", () => {
  test("strips API credentials so the subscription login is used", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok";
    const env = subscriptionEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBeDefined();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });
  test("builds read-only args", () => {
    const args = buildArgs({ prompt: "x", cwd: "/", model: "opus", tools: ["Read", "Grep"], allowedTools: ["Bash(git diff:*)"], logName: "t" });
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", "Read,Grep"]);
    expect(args).not.toContain("--bare");
    // Never load settings files (PR checkouts could ship hooks).
    expect(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2)).toEqual(["--setting-sources", ""]);
  });
  test("describes tool use, skips subagent chatter", () => {
    const ev = { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }] } };
    expect(describeEvent(ev)).toEqual([{ text: "Reading src/a.ts", tool: "Read" }]);
    expect(describeEvent({ ...ev, parent_tool_use_id: "x" })).toEqual([]);
  });
});

import { parseDiff, snippetFromDiff, validateAnchor } from "./anchors";

describe("anchors", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ function x() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 return a;
 }
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-too
`;
  const files = parseDiff(diff);
  test("parses paths, including deleted files", () => {
    expect([...files.keys()].sort()).toEqual(["old.ts", "src/a.ts"]);
  });
  test("accepts added and context lines on RIGHT, rejects lines outside hunks", () => {
    expect(validateAnchor(files, { path: "src/a.ts", line: 11, startLine: null, side: "RIGHT" }).anchorable).toBe(true);
    expect(validateAnchor(files, { path: "src/a.ts", line: 10, startLine: null, side: "RIGHT" }).anchorable).toBe(true);
    expect(validateAnchor(files, { path: "src/a.ts", line: 40, startLine: null, side: "RIGHT" }).anchorable).toBe(false);
    expect(validateAnchor(files, { path: "nope.ts", line: 1, startLine: null, side: "RIGHT" }).anchorable).toBe(false);
  });
  test("corrects the side for deleted lines and drops out-of-hunk range starts", () => {
    expect(validateAnchor(files, { path: "old.ts", line: 2, startLine: 1, side: "RIGHT" })).toEqual({ path: "old.ts", line: 2, startLine: 1, side: "LEFT", anchorable: true });
    expect(validateAnchor(files, { path: "src/a.ts", line: 12, startLine: 2, side: "RIGHT" }).startLine).toBeNull();
  });
  test("snippet marks the target lines", () => {
    const snip = snippetFromDiff(files, { path: "src/a.ts", line: 12, startLine: 11, side: "RIGHT" })!;
    expect(snip.filter((l) => l.target).map((l) => l.newNo)).toEqual([11, 12]);
    expect(snip.some((l) => l.kind === "del")).toBe(true);
  });
});

import { isStale } from "./cleanup";

describe("worktree cleanup", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  test("posted reviews are released immediately; running ones never", () => {
    expect(isStale({ phase: "submitted", lastActivity: "2026-09-23 11:59:00", running: false }, now, 72)).toBe(true);
    expect(isStale({ phase: "submitted", lastActivity: "2026-09-01 00:00:00", running: true }, now, 72)).toBe(false);
  });
  test("abandoned after the TTL of inactivity (SQLite UTC timestamps)", () => {
    expect(isStale({ phase: "walkthrough", lastActivity: "2026-09-20 11:00:00", running: false }, now, 72)).toBe(true);
    expect(isStale({ phase: "walkthrough", lastActivity: "2026-09-20 13:00:00", running: false }, now, 72)).toBe(false);
    expect(isStale({ phase: "failed", lastActivity: "2026-09-23 10:00:00", running: false }, now, 72)).toBe(false);
  });
});

import { getSettings, resetSettings, updateSettings } from "./settings";
import { turnLimitMessage } from "./reviews";

describe("turn limits", () => {
  test("a max-turns result is flagged and the message is human", () => {
    expect(turnLimitMessage("recon", 4)).toBe(
      "Claude used all 4 of its turns before finishing the overview. Continue to give it more turns from where it stopped, or retry to start over.",
    );
    expect(turnLimitMessage("review", null)).toContain("all of its turns before finishing the deep review");
  });
});

describe("settings", () => {
  test("saves valid changes and rejects bad input", () => {
    resetSettings();
    expect(updateSettings({ models: { recon: "haiku" } as any }).models.recon).toBe("haiku");
    expect(getSettings().models.review).toBe("opus"); // untouched stages keep defaults
    expect(() => updateSettings({ models: { review: "opus; rm -rf /" } as any })).toThrow(/Invalid model/);
    expect(() => updateSettings({ effort: { qa: "turbo" } as any })).toThrow(/Invalid effort/);
    expect(() => updateSettings({ worktreeTtlHours: 0 })).toThrow(/between/);
    expect(resetSettings().models.recon).toBe("sonnet");
  });
  test("overview turn limit defaults to 10 and is range-checked", () => {
    resetSettings();
    expect(getSettings().reconMaxTurns).toBe(10);
    expect(updateSettings({ reconMaxTurns: 14 }).reconMaxTurns).toBe(14);
    expect(() => updateSettings({ reconMaxTurns: 1 })).toThrow(/between 2 and 100/);
    resetSettings();
  });
  test("effort maps to --effort, default omits it", () => {
    const base = { prompt: "x", cwd: "/", model: "opus", tools: [], logName: "t" };
    expect(buildArgs({ ...base, effort: "high" })).toContain("--effort");
    expect(buildArgs({ ...base, effort: "default" })).not.toContain("--effort");
  });
});

import { parseGithubRemote } from "./local";
import { ownerPattern } from "./self";

describe("self-review helpers", () => {
  test("GitHub remotes in every common form", () => {
    expect(parseGithubRemote("git@github.com:acme/platform.git")).toBe("acme/platform");
    expect(parseGithubRemote("https://github.com/acme/platform")).toBe("acme/platform");
    expect(parseGithubRemote("https://github.com/o/r.git/")).toBe("o/r");
    expect(parseGithubRemote("ssh://git@github.com/o/my.repo.git")).toBe("o/my.repo");
    expect(parseGithubRemote("git@gitlab.com:o/r.git")).toBeNull();
  });
  test("CODEOWNERS patterns match like GitHub's", () => {
    expect(ownerPattern("*.js").test("src/app/index.js")).toBe(true);
    expect(ownerPattern("/db/migrate/").test("db/migrate/2026_x.ts")).toBe(true);
    expect(ownerPattern("/db/migrate/").test("other/db/migrate/x.ts")).toBe(false);
    expect(ownerPattern("docs/*").test("docs/a.md")).toBe(true);
    expect(ownerPattern("docs/*").test("docs/deep/a.md")).toBe(false);
    expect(ownerPattern("apps/**/api").test("apps/web/v2/api/x.ts")).toBe(true);
    expect(ownerPattern("jobs").test("src/jobs/queue.ts")).toBe(true);
  });
});

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { buildCodexArgs, runCodex, strictSchema } from "./codex";

describe("codex", () => {
  const base = { prompt: "x", cwd: "/w", model: "gpt-5-codex", tools: ["Read"], logName: "t" };
  test("exec flags: read-only, no AGENTS.md, no MCP, schema, resume only for codex sessions", () => {
    const args = buildCodexArgs({ ...base, effort: "high" }, "/tmp/s.json", "/w");
    expect(args.slice(0, 7)).toEqual(["exec", "--json", "--skip-git-repo-check", "-C", "/w", "-s", "read-only"]);
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain("project_doc_max_bytes=0");
    expect(args).toContain("mcp_servers={}");
    expect(args.join(" ")).toContain("--output-schema /tmp/s.json");
    expect(args.at(-1)).toBe("-");
    expect(buildCodexArgs({ ...base, model: "default" }, null, "/w")).not.toContain("-m");
    expect(buildCodexArgs({ ...base, resume: "codex:abc" }, null, "/w").join(" ")).toContain("resume abc -");
    expect(buildCodexArgs({ ...base, resume: "claude-session" }, null, "/w")).not.toContain("resume");
  });
  test("strict schema: every property required, optional ones nullable, no min/max", () => {
    const s: any = strictSchema({
      type: "object",
      required: ["a"],
      properties: { a: { type: "integer", minimum: 1 }, b: { type: "array", items: { type: "string" } } },
    });
    expect(s.required).toEqual(["a", "b"]);
    expect(s.properties.a.minimum).toBeUndefined();
    expect(s.properties.b.type).toEqual(["array", "null"]);
    expect(s.additionalProperties).toBe(false);
  });
  test("parses a codex --json event stream into a structured result", async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "fake-codex-"));
    const events = [
      { type: "thread.started", thread_id: "th_123" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "1", type: "command_execution", command: "bash -lc 'git diff --stat'" } },
      { type: "item.completed", item: { id: "2", type: "reasoning", text: "**Checking the retry path**" } },
      { type: "item.completed", item: { id: "3", type: "agent_message", text: '```json\n{"answer":"ok"}\n```' } },
      { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 7 } },
    ];
    writeFileSync(pathJoin(dir, "codex"), `#!/bin/sh\ncat > /dev/null\ncat <<'EOF'\n${events.map((e) => JSON.stringify(e)).join("\n")}\nEOF\n`);
    chmodSync(pathJoin(dir, "codex"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    const progress: string[] = [];
    try {
      const res = await runCodex<{ answer: string }>({ ...base, cwd: dir, jsonSchema: { type: "object", properties: { answer: { type: "string" } } }, onProgress: (p) => progress.push(p.text) });
      expect(res.isError).toBe(false);
      expect(res.structured).toEqual({ answer: "ok" });
      expect(res.sessionId).toBe("codex:th_123");
      expect(res.inputTokens).toBe(120);
      expect(res.outputTokens).toBe(7);
      expect(progress).toContain("Checking the retry path");
      expect(progress.some((p) => p.startsWith("Running"))).toBe(true);
    } finally {
      process.env.PATH = oldPath;
    }
  });
  test("a failed turn is an error, not a result", async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "fake-codex-"));
    writeFileSync(pathJoin(dir, "codex"), `#!/bin/sh\ncat > /dev/null\necho '{"type":"turn.failed","error":{"message":"usage limit reached"}}'\nexit 1\n`);
    chmodSync(pathJoin(dir, "codex"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    try {
      const res = await runCodex({ ...base, cwd: dir });
      expect(res.isError).toBe(true);
      expect(res.error).toBe("usage limit reached");
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
