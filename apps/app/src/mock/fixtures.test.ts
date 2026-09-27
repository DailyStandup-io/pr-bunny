// The mock world holds together: every fixture edit applies, every scripted finding lands inside
// its PR's diff, the fake agents' output matches the app's real JSON schemas for every PR and step
// (prompts built with the app's own prompt builders), the fake CLIs answer the way the app expects,
// and the lived-in scenario seeds a clean database.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../shared/types";

// Fake tool state (origins, sessions, write log) in a throwaway folder; agents run instantly.
process.env.PR_BUNNY_MOCK_STATE = mkdtempSync(join(tmpdir(), "pr-bunny-mock-"));
process.env.PR_BUNNY_MOCK_SPEED = "0";

const { parseDiff, validateAnchor } = await import("../server/anchors");
const { groupAreas, heuristicMinutes } = await import("../server/areas");
const { strictSchema } = await import("../server/codex");
const { buildArgs } = await import("../server/claude");
const { openDb } = await import("../server/db/db");
const { RECON_SCHEMA, RECON_SELF_SCHEMA, reconPrompt } = await import("../server/prompts/recon");
const { REVIEW_SCHEMA, SELF_REVIEW_SCHEMA, reviewPrompt, selfReviewPrompt } = await import("../server/prompts/review");
const { STACK_SCHEMA, stackPrompt } = await import("../server/prompts/stack");
const { PR_QA_SCHEMA, QA_SCHEMA, prQaPrompt, qaPrompt } = await import("../server/prompts/qa");
const { outputFor, stageOf, targetOf } = await import("./agent");
const { fillNulls } = await import("./agents-cli");
const F = await import("./fixtures");
const { runGh, readWrites } = await import("./gh");
const { seedLivedIn } = await import("./scenario");
const { avatarSvg, initials } = await import("../server/avatar");

// ---------- a small JSON Schema check (the subset the app's schemas use) ----------

function validate(value: unknown, schema: any, path = "$"): string[] {
  const errors: string[] = [];
  const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  const actual = typeOf(value);
  if (types.length && !types.includes(actual) && !(actual === "integer" && types.includes("number"))) return [`${path}: ${actual} is not ${types.join("|")}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
  if (actual === "object" && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in obj)) errors.push(`${path}.${k}: required`);
    for (const [k, v] of Object.entries(obj)) {
      if (schema.properties[k]) errors.push(...validate(v, schema.properties[k], `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: not allowed`);
    }
  }
  if (actual === "array" && schema.items) (value as unknown[]).forEach((v, i) => errors.push(...validate(v, schema.items, `${path}[${i}]`)));
  return errors;
}

/** Valid for Claude's schema, and (with nulls filled in) for the strict form Codex gets. */
function expectValid(output: unknown, schema: object, what: string) {
  expect({ what, errors: validate(output, schema) }).toEqual({ what, errors: [] });
  const strict = strictSchema(schema);
  expect({ what: `${what} (codex)`, errors: validate(fillNulls(output, strict), strict) }).toEqual({ what: `${what} (codex)`, errors: [] });
}

// ---------- prompts, built with the app's own builders ----------

const view = (pr: (typeof F.PRS)[number]) => {
  const v = F.prViewJson(pr, Date.now());
  return { ...v, author: v.author.login, labels: v.labels.map((l) => l.name) };
};
const reviewInput = (pr: (typeof F.PRS)[number]) => {
  const ch = F.prChange(pr);
  return {
    repo: pr.repo,
    pr: { number: pr.number, title: pr.title, body: pr.body, author: pr.author, headRef: pr.branch, baseRef: pr.base, headSha: "abc123" },
    mergeBase: "def456",
    recon: null,
    files: ch.files,
    stack: [],
    stackContext: "",
    lenses: "",
    lensesSource: "",
    dismissals: [],
    diff: ch.diff,
    diffTruncated: false,
  };
};
const mine = (pr: (typeof F.PRS)[number]) => pr.author === F.VIEWER.login;
const run = (schema: object, prompt: string, cwd = "/tmp") => outputFor(stageOf(schema, prompt), targetOf(prompt, cwd), prompt, schema, null).output as any;

describe("the fixture world", () => {
  test("every edit applies and every PR has a diff", () => {
    F.checkWorld();
    for (const pr of F.PRS) expect({ pr: pr.number, files: F.prChange(pr).files.length > 0 }).toEqual({ pr: pr.number, files: true });
    expect(F.PRS.length).toBeGreaterThanOrEqual(15);
  });

  test("covers every state the UI shows", () => {
    const open = F.PRS.filter((p) => p.state === "OPEN");
    expect(open.some((p) => p.requestedBy && !mine(p))).toBe(true);
    expect(open.some((p) => p.assigned)).toBe(true);
    expect(open.some((p) => mine(p))).toBe(true);
    expect(open.some((p) => p.draft)).toBe(true);
    expect(F.PRS.some((p) => p.state === "MERGED")).toBe(true);
    expect(F.PRS.some((p) => p.state === "CLOSED")).toBe(true);
    expect(F.PRS.some((p) => p.commits.length > 1 && p.rereview)).toBe(true);
    expect(Math.max(...F.STACKS.map((s) => F.stackPrs(s).length))).toBe(4);
    const severities = new Set(F.PRS.flatMap((p) => p.review?.findings ?? []).map((f) => f.severity));
    expect([...severities].sort()).toEqual(["critical", "high", "low", "medium"]);
  });

  test("scripted findings and stack placements land inside their PR's diff", () => {
    for (const pr of F.PRS) {
      for (const [script, upTo] of [[pr.review, pr.rereview ? 1 : undefined], [pr.rereview, undefined]] as const) {
        if (!script) continue;
        const change = F.prChange(pr, upTo);
        const diff = parseDiff(change.diff);
        const out = F.reviewOutput({ kind: "pr", pr }, script, { upTo, self: mine(pr) });
        for (const f of out.findings) {
          // A finding may point at code outside the diff (it goes in the review body) only if its file isn't changed at all.
          if (!f.path || !change.files.some((c) => c.path === f.path)) continue;
          expect({ pr: pr.number, title: f.title, anchorable: validateAnchor(diff, f).anchorable }).toEqual({ pr: pr.number, title: f.title, anchorable: true });
        }
      }
    }
    for (const s of F.STACKS)
      for (const f of F.stackOutput(s).findings)
        for (const p of f.placements) {
          const diff = parseDiff(F.prChange(F.findPr(s.repo, p.pr)!).diff);
          expect({ title: f.title, pr: p.pr, anchorable: validateAnchor(diff, { path: p.path, line: p.line, startLine: null, side: "RIGHT" }).anchorable }).toEqual({ title: f.title, pr: p.pr, anchorable: true });
        }
  });

  test("overviews name every area the app groups the PR into", () => {
    for (const pr of F.PRS.filter((p) => p.recon)) {
      const areas = groupAreas(F.prChange(pr).files).map((a) => a.path);
      expect({ pr: pr.number, missing: areas.filter((a) => !pr.recon!.areas[a]) }).toEqual({ pr: pr.number, missing: [] });
    }
  });
});

describe("fake agent output matches the app's schemas", () => {
  test("overview, for every PR (self-reviews get reviewer questions)", () => {
    for (const pr of F.PRS) {
      const ch = F.prChange(pr);
      const prompt = reconPrompt({ repo: pr.repo, pr: view(pr), areas: groupAreas(ch.files), heuristicMinutes: heuristicMinutes(ch.files), stack: [], diff: ch.diff, diffTruncated: false });
      const schema = mine(pr) ? RECON_SELF_SCHEMA : RECON_SCHEMA;
      const out = run(schema, prompt);
      expectValid(out, schema, `recon ${pr.repo}#${pr.number}`);
      expect(out.areas.map((a: any) => a.path)).toEqual(groupAreas(ch.files).map((a) => a.path));
      if (pr.recon) expect(out.headline).toBe(pr.recon.headline);
    }
  });

  test("deep review and self-review, for every PR and branch", () => {
    for (const pr of F.PRS) {
      const self = mine(pr);
      const input = reviewInput(pr);
      const prompt = self ? selfReviewPrompt({ ...input, commits: ["abc1234 wip"], dirtyFiles: 0 }) : reviewPrompt(input);
      const schema = self ? SELF_REVIEW_SCHEMA : REVIEW_SCHEMA;
      const out = run(schema, prompt);
      expectValid(out, schema, `review ${pr.repo}#${pr.number}`);
      if (pr.review && !pr.rereview) expect(out.findings.length).toBe(pr.review.findings.length);
    }
    for (const b of F.BRANCHES) {
      const ch = F.branchChange(b);
      const prompt = selfReviewPrompt({ ...reviewInput(F.PRS[0]!), repo: b.repo, pr: { number: 0, title: b.branch, body: "", author: F.VIEWER.login, headRef: b.branch, baseRef: b.base, headSha: "abc" }, files: ch.files, diff: ch.diff, commits: [], dirtyFiles: 0 });
      const out = run(SELF_REVIEW_SCHEMA, prompt);
      expectValid(out, SELF_REVIEW_SCHEMA, `self-review ${b.branch}`);
      expect(out.findings.length).toBe(b.review!.findings.length);
    }
  });

  test("re-review reports on each prior finding; a self-review re-run too", () => {
    const pr = F.findPr("quokka-labs/api", 238)!;
    const prior = pr.review!.findings.map((f, i) => ({ id: 100 + i, severity: f.severity, title: f.title, path: f.at?.path ?? null, line: 7, decision: "accepted", comment: f.comment }));
    const out = run(REVIEW_SCHEMA, reviewPrompt({ ...reviewInput(pr), rereview: { fromSha: "aaaa", delta: "", prior } }));
    expectValid(out, REVIEW_SCHEMA, "re-review #238");
    expect(out.priorStatus).toEqual([
      { findingId: 100, status: "addressed", note: expect.any(String) },
      { findingId: 101, status: "still_present", note: expect.any(String) },
    ]);
    const mineP = F.findPr("quokka-labs/checkout", 1495)!;
    const rerun = { run: 2, prior: mineP.review!.findings.map((f, i) => ({ id: 200 + i, severity: f.severity, title: f.title, path: f.at?.path ?? null, line: 3, decision: i === 0 ? "accepted" : null, prompt: f.prompt ?? null })), settled: [] };
    const out2 = run(SELF_REVIEW_SCHEMA, selfReviewPrompt({ ...reviewInput(mineP), commits: [], dirtyFiles: 0, rerun }));
    expectValid(out2, SELF_REVIEW_SCHEMA, "self re-run #1495");
    expect(out2.priorStatus[0].status).toBe("addressed");
    expect(out2.priorStatus[1].status).toBe("still_present");
  });

  test("across the stack, with per-layer findings it replaces", () => {
    for (const stack of F.STACKS) {
      let id = 500;
      const layers = F.stackPrs(stack).map((pr) => ({
        pr: pr.number, title: pr.title, author: pr.author, headRef: pr.branch, baseRef: pr.base, parentPr: null, summary: null,
        findings: (pr.review?.findings ?? []).map((f) => ({ id: id++, severity: f.severity, title: f.title, path: f.at?.path ?? null, line: 1, why: f.why })),
        diff: F.prChange(pr).diff, diffTruncated: false,
      }));
      const out = run(STACK_SCHEMA, stackPrompt({ repo: stack.repo, baseRef: "main", layers }));
      expectValid(out, STACK_SCHEMA, `stack ${stack.name}`);
      expect(out.findings.length).toBe(stack.cross.findings.length);
      expect(out.findings.flatMap((f: any) => f.replaces).length).toBe(stack.cross.findings.flatMap((f) => f.replaces).length);
    }
  });

  test("finding Q&A and PR Q&A", () => {
    const pr = F.findPr("quokka-labs/checkout", 1490)!;
    const f = F.reviewOutput({ kind: "pr", pr }, pr.review!).findings[0]!;
    const finding = { ...f, id: 1, position: 0, anchorable: true, decision: null, dismissReason: null, posted: false, snippet: [], messages: [], agentPrompt: null, resolvedRun: null, stillOpenRun: null, stillNote: null, stackFindingId: null, soft: false } as Finding;
    const qa = run(QA_SCHEMA, qaPrompt(finding, "Is this real?", true));
    expectValid(qa, QA_SCHEMA, "finding Q&A");
    expect(qa.answer).toBe(pr.review!.findings[0]!.qa!.answer);
    const prQa = run(PR_QA_SCHEMA, prQaPrompt({ repo: pr.repo, number: pr.number, title: pr.title, author: pr.author, headRef: pr.branch, baseRef: pr.base, mergeBase: null, headline: null, summary: null }, "What's risky here?", true));
    expectValid(prQa, PR_QA_SCHEMA, "PR Q&A");
  });
});

describe("the fake CLIs", () => {
  const bin = (tool: string) => join(import.meta.dir, "bin", tool);
  const sh = async (cmd: string[], stdin = "") => {
    const proc = Bun.spawn(cmd, { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  };

  test("claude and codex report installed and signed in on a subscription", async () => {
    expect((await sh([bin("claude"), "--version"])).out).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)/);
    const auth = JSON.parse((await sh([bin("claude"), "auth", "status", "--json"])).out);
    expect(auth).toMatchObject({ loggedIn: true, email: F.VIEWER.email, subscriptionType: "max" });
    const login = await sh([bin("codex"), "login", "status"]);
    expect(login.code).toBe(0);
    expect(`${login.out}${login.err}`).toMatch(/chatgpt/i);
  });

  test("claude streams a run, stops at --max-turns and finishes on --resume", async () => {
    const pr = F.findPr("quokka-labs/api", 231)!;
    const prompt = reviewPrompt(reviewInput(pr));
    const args = buildArgs({ prompt, cwd: "/tmp", model: "opus", tools: ["Read", "Grep", "Glob", "Bash"], jsonSchema: REVIEW_SCHEMA, maxTurns: 2, logName: "t" });
    const events = (await sh([bin("claude"), ...args], prompt)).out.trim().split("\n").map((l) => JSON.parse(l));
    const stopped = events.at(-1);
    expect(stopped).toMatchObject({ type: "result", subtype: "error_max_turns", is_error: true });
    expect(events.some((e) => e.type === "assistant" && e.message.content[0].type === "tool_use")).toBe(true);
    const resume = buildArgs({ prompt: "continue", cwd: "/tmp", model: "opus", tools: ["Read"], jsonSchema: REVIEW_SCHEMA, maxTurns: 250, resume: stopped.session_id, logName: "t" });
    const done = JSON.parse((await sh([bin("claude"), ...resume], "You ran out of turns before finishing. Pick up where you left off.")).out.trim().split("\n").at(-1)!);
    expect(done).toMatchObject({ type: "result", subtype: "success", session_id: stopped.session_id });
    expectValid(done.structured_output, REVIEW_SCHEMA, "resumed review");
    expect(done.structured_output.findings).toHaveLength(pr.review!.findings.length);
  });

  test("gh: reads from the fixtures, logs writes, rejects what it doesn't know", async () => {
    const view = JSON.parse((await runGh(["pr", "view", "1483", "-R", "quokka-labs/checkout", "--json", "number,headRefOid,baseRefName,files"])).stdout);
    expect(view.baseRefName).toBe("checkout-v2/totals");
    expect(view.headRefOid).toMatch(/^[0-9a-f]{40}$/);
    expect((await runGh(["pr", "diff", "1483", "-R", "quokka-labs/checkout"])).stdout).toBe(F.prChange(F.findPr("quokka-labs/checkout", 1483)!).diff);
    const inbox = JSON.parse((await runGh(["search", "prs", "--review-requested=@me", "--state=open", "--limit", "50", "--json", "number,repository"])).stdout);
    expect(inbox.length).toBe(F.PRS.filter((p) => p.state === "OPEN" && p.requestedBy).length);
    const auth = JSON.parse((await runGh(["auth", "status", "--json", "hosts"])).stdout);
    expect(auth.hosts["github.com"][0]).toMatchObject({ state: "success", login: F.VIEWER.login });

    const posted = await runGh(["api", "repos/quokka-labs/api/pulls/231/reviews", "--method", "POST", "--input", "-"], JSON.stringify({ event: "COMMENT", body: "hi", comments: [] }));
    expect(JSON.parse(posted.stdout).html_url).toContain("/pull/231#pullrequestreview-");
    expect(readWrites().at(-1)).toMatchObject({ kind: "review", repo: "quokka-labs/api", pr: 231 });

    const nope = await runGh(["gist", "create"]);
    expect(nope.code).toBe(1);
    expect(nope.stderr).toContain("mock gh: unsupported: gh gist create");
  });

  test("gh repo clone gives a real repo with refs/pull/N/head at the SHAs pr view reports", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pr-bunny-clone-")), "checkout");
    expect((await runGh(["repo", "clone", "quokka-labs/checkout", dir, "--", "--filter=blob:none", "--no-checkout"])).code).toBe(0);
    const head = JSON.parse((await runGh(["pr", "view", "1485", "-R", "quokka-labs/checkout", "--json", "headRefOid"])).stdout).headRefOid;
    const fetched = await sh(["git", "-C", dir, "fetch", "--quiet", "origin", "+refs/pull/1485/head:refs/rp/pr-1485"]);
    expect(fetched.code).toBe(0);
    expect((await sh(["git", "-C", dir, "rev-parse", "refs/rp/pr-1485"])).out.trim()).toBe(head);
    const mergeBase = (await sh(["git", "-C", dir, "merge-base", head, "refs/remotes/origin/main"])).out.trim();
    expect(mergeBase).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("seeding", () => {
  test("the lived-in scenario seeds a clean database with every phase", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "pr-bunny-seed-")), "seed.db"));
    const out = seedLivedIn({ db, home: "/nowhere", now: Date.parse("2026-09-01T12:00:00Z") });
    const phases = (db.query("SELECT DISTINCT phase FROM reviews").all() as Array<{ phase: string }>).map((r) => r.phase).sort();
    expect(phases).toEqual(["cancelled", "failed", "recon_ready", "submitted", "walkthrough"]);
    expect(db.query("SELECT COUNT(*) AS n FROM stacks").get()).toEqual({ n: 2 });
    expect(db.query("SELECT run_state, cross_state FROM stacks ORDER BY id").all()).toEqual([
      { run_state: "running", cross_state: null },
      { run_state: "idle", cross_state: "done" },
    ]);
    // Cross findings are placed on layers and absorb the per-layer findings they cover.
    expect((db.query("SELECT COUNT(*) AS n FROM findings WHERE stack_finding_id IS NOT NULL").get() as { n: number }).n).toBeGreaterThan(0);
    expect((db.query("SELECT COUNT(*) AS n FROM findings WHERE superseded_by IS NOT NULL").get() as { n: number }).n).toBe(3);
    expect(db.query("SELECT COUNT(*) AS n FROM inbox_hidden").get()).toEqual({ n: 2 });
    expect(db.query("SELECT COUNT(*) AS n, SUM(read_at IS NULL) AS unread, SUM(seen_at IS NULL) AS unseen FROM notifications").get()).toEqual({ n: 9, unread: 4, unseen: 2 });
    expect(db.query("SELECT COUNT(*) AS n FROM onboarding").get()).toEqual({ n: 1 });
    // Every stored anchor is either inline-postable or deliberately in the body.
    const bad = db.query("SELECT COUNT(*) AS n FROM findings WHERE anchorable = 1 AND (path IS NULL OR line IS NULL)").get() as { n: number };
    expect(bad.n).toBe(0);
    expect(Object.keys(out.reviews).length).toBeGreaterThan(15);
  });
});

test("demo avatars are generated SVGs with initials", () => {
  expect(initials("amara-fenwick")).toBe("AF");
  expect(initials("quokka-deps[bot]")).toBe("QD");
  const svg = avatarSvg("robin-vale");
  expect(svg).toStartWith("<svg");
  expect(svg).toContain(">RV</text>");
  expect(avatarSvg("robin-vale")).toBe(svg);
});
