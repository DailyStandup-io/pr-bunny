// The brain of the fake `claude` and `codex` (src/mock/bin): works out which step PR Bunny is
// running (overview, deep review, re-review, self-review, re-run, across the stack, Q&A) from the
// JSON schema and the prompt, picks the scripted output for that PR from the fixtures, and plans a
// believable trail of tool calls to stream before it. Sessions are saved so --resume works.
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRANCHES,
  findBranch,
  findPr,
  PRS,
  prHeadFiles,
  reconOutput,
  reviewOutput,
  stackOf,
  stackOutput,
  STACKS,
  targetChange,
  targetLabel,
  targetRepo,
  type FixtureStack,
  type Target,
} from "./fixtures";
import { lines } from "./diff";
import { mockStateDir } from "./git";
import type { ReconScript, ReviewScript, ScriptFinding, TrailStep } from "./types";

export type Stage = "recon" | "review" | "rereview" | "self-review" | "self-rerun" | "stack" | "qa" | "pr-qa" | "text";

export interface Session {
  id: string;
  stage: Stage;
  repo: string | null;
  pr: number | null;
  branch: string | null;
  /** Finding Q&A: the finding's title. */
  finding: string | null;
  /** Steps already streamed; a resumed run continues from here. */
  step: number;
  done: boolean;
}

export type Step =
  | { kind: "tool"; tool: "Read" | "Grep" | "Glob" | "Bash"; input: Record<string, unknown>; result: string }
  | { kind: "text"; text: string };

export interface Plan {
  steps: Step[];
  output: unknown;
  /** The run's final text (Claude's `result`). */
  text: string;
  /** Total time at speed 1, spread over the steps. */
  durationMs: number;
  costUsd: number;
  usage: { input: number; cacheRead: number; output: number };
}

// ---------- sessions ----------

const sessionDir = () => {
  const dir = join(mockStateDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
};
const safeId = (id: string) => id.replace(/[^\w.-]/g, "_");

export function loadSession(id: string): Session | null {
  const file = join(sessionDir(), `${safeId(id)}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Session) : null;
}

export function saveSession(s: Session) {
  writeFileSync(join(sessionDir(), `${safeId(s.id)}.json`), JSON.stringify(s, null, 2));
}

export const newSessionId = () => randomUUID();

// ---------- what's being asked ----------

const props = (schema: any): Record<string, any> => (schema && typeof schema === "object" ? (schema.properties ?? {}) : {});

/** The step, from the JSON schema's shape (plus the prompt for re-reviews and re-runs). */
export function stageOf(schema: unknown, prompt: string): Stage {
  const p = props(schema);
  if ("headline" in p) return "recon";
  if ("verdict" in p) {
    const self = "prompt" in props(p.findings?.items);
    if (self) return /This is RE-RUN \d+ of the self-review/.test(prompt) ? "self-rerun" : "self-review";
    return prompt.includes("## This is a RE-REVIEW") ? "rereview" : "review";
  }
  if ("placements" in props(p.findings?.items)) return "stack";
  if ("recommendation" in p) return "qa";
  if ("answer" in p) return "pr-qa";
  return "text";
}

/** The PR or branch a prompt is about, from the lines the app's prompt builders always write. */
export function targetOf(prompt: string, cwd: string): Target | null {
  const repo = prompt.match(/^Repository: ([\w.-]+\/[\w.-]+)$/m)?.[1] ?? prompt.match(/^PR: ([\w.-]+\/[\w.-]+)#\d+/m)?.[1] ?? repoFromCwd(cwd);
  const num = Number(prompt.match(/^PR #(\d+):/m)?.[1] ?? prompt.match(/^PR: [\w.-]+\/[\w.-]+#(\d+)/m)?.[1] ?? 0);
  if (repo && num) {
    const pr = findPr(repo, num);
    return pr ? { kind: "pr", pr } : null;
  }
  const branch = prompt.match(/^Branch: (\S+) → (\S+)$/m)?.[1];
  if (repo && branch) {
    const pr = PRS.find((p) => p.repo === repo && p.branch === branch);
    if (pr) return { kind: "pr", pr };
    const b = findBranch(repo, branch);
    return b ? { kind: "branch", branch: b } : null;
  }
  return fromReviewDb(cwd);
}

/** Checkouts live at <data>/worktrees/<owner>/<repo>/review-<id>. */
function repoFromCwd(cwd: string): string | null {
  const m = cwd.match(/worktrees\/([\w.-]+)\/([\w.-]+)\/review-\d+/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Last resort (a resumed run whose session file is gone): ask PR Bunny's database which PR the checkout is for. */
function fromReviewDb(cwd: string): Target | null {
  const m = cwd.match(/worktrees\/([\w.-]+)\/([\w.-]+)\/review-(\d+)/);
  const home = process.env.PR_BUNNY_HOME;
  if (!m || !home || !existsSync(join(home, "pr-bunny.db"))) return null;
  try {
    const db = new Database(join(home, "pr-bunny.db"), { readonly: true });
    const row = db.query("SELECT pr_number AS pr, head_ref AS branch FROM reviews WHERE id = ?").get(Number(m[3])) as { pr: number; branch: string } | null;
    db.close();
    if (!row) return null;
    const repo = `${m[1]}/${m[2]}`;
    const pr = row.pr ? findPr(repo, row.pr) : null;
    if (pr) return { kind: "pr", pr };
    const b = findBranch(repo, row.branch);
    return b ? { kind: "branch", branch: b } : null;
  } catch {
    return null;
  }
}

export function stackFromPrompt(prompt: string): FixtureStack | null {
  const repo = prompt.match(/^Stack in ([\w.-]+\/[\w.-]+), based on/m)?.[1];
  if (!repo) return null;
  const prs = [...prompt.matchAll(/^## Layer \d+: #(\d+) /gm)].map((m) => Number(m[1]));
  return stackOf(repo, prs);
}

// ---------- scripted output ----------

const scriptFor = (t: Target): { recon?: ReconScript; review?: ReviewScript } => (t.kind === "pr" ? t.pr : t.branch);
const firstSentence = (s: string) => s.split(/(?<=\.)\s/)[0] ?? s;

function genericRecon(prompt: string): ReconScript {
  const title = prompt.match(/^PR #\d+: (.+)$/m)?.[1] ?? prompt.match(/^Change \(no PR yet\): (.+)$/m)?.[1] ?? "This change";
  const minutes = Number(prompt.match(/^(\d+) minutes \(line-count based\)/m)?.[1] ?? 8);
  return {
    headline: title.length > 88 ? `${title.slice(0, 85)}…` : title,
    summary: `${title}. The diff is small and self-contained; the areas below show where it lands.`,
    intent: "Described in the PR title; the description doesn't add more.",
    areas: {},
    risks: [],
    minutes: [minutes, Math.max(2, Math.round(minutes / 2))],
    estReasoning: "Close to the line-count heuristic: nothing unusually subtle in the diff.",
    focus: ["The main code path in the largest file", "Tests for the new behaviour"],
  };
}

const genericReview = (): ReviewScript => ({
  findings: [],
  verdict: "approve",
  summary: "Read the whole change and the code around it; nothing to flag. Thanks!",
  coverage: "Read every changed file in full and searched for callers of anything that changed.",
});

/** Titles of prior findings as the app lists them in re-review / re-run prompts, keyed by id. */
function priorFindings(prompt: string): Array<{ id: number; title: string; decision: string }> {
  return [...prompt.matchAll(/^- id (\d+) \[\w+\] (.+) \((?:[^()]*)\) — (?:reviewer|author's) decision: (\w+)/gm)].map((m) => ({
    id: Number(m[1]),
    title: m[2]!,
    decision: m[3]!,
  }));
}

function allScriptFindings(): Array<{ f: ScriptFinding; repo: string }> {
  const out: Array<{ f: ScriptFinding; repo: string }> = [];
  for (const p of PRS) for (const s of [p.review, p.rereview]) for (const f of s?.findings ?? []) out.push({ f, repo: p.repo });
  for (const b of BRANCHES) for (const f of b.review?.findings ?? []) out.push({ f, repo: b.repo });
  return out;
}

/** Builds the structured output for a stage. `null` target = a PR outside the fixtures: a generic answer. */
export function outputFor(stage: Stage, t: Target | null, prompt: string, schema: unknown, session: Session | null): { output: unknown; text: string } {
  const scripted = t ? scriptFor(t) : {};
  switch (stage) {
    case "recon": {
      const areas = [...(prompt.split("## Areas touched")[1]?.split("\n## ")[0] ?? "").matchAll(/^- (.+?) — \d+ files?/gm)].map((m) => m[1]!);
      const self = "reviewerQuestions" in props(schema);
      const script = scripted.recon ?? genericRecon(prompt);
      const out = reconOutput(script, areas, self);
      return { output: out, text: out.headline };
    }
    case "review":
    case "self-review": {
      const self = stage === "self-review";
      if (!t || !scripted.review) return { output: genericReview(), text: genericReview().summary };
      // A PR that moved on since its scripted review: what's still open, plus what the new commits bring.
      if (t.kind === "pr" && t.pr.rereview && !self) {
        const rr = t.pr.rereview;
        const still = t.pr.review!.findings.filter((f) => rr.prior[f.title]?.[0] !== "addressed");
        const out = reviewOutput(t, { ...rr, findings: [...still, ...rr.findings] });
        return { output: out, text: out.summary };
      }
      const out = reviewOutput(t, scripted.review, { self });
      return { output: out, text: out.summary };
    }
    case "rereview": {
      const rr = t?.kind === "pr" ? t.pr.rereview : undefined;
      const prior = priorFindings(prompt);
      const base = rr && t ? reviewOutput(t, rr) : { ...genericReview(), findings: [] };
      const priorStatus = prior.map((p) => {
        const hit = rr?.prior[p.title];
        return { findingId: p.id, status: hit?.[0] ?? "unclear", note: hit?.[1] ?? "The new commits don't touch this code, so I couldn't tell." };
      });
      return { output: { ...base, priorStatus }, text: base.summary };
    }
    case "self-rerun": {
      const prior = priorFindings(prompt);
      const known = new Map(allScriptFindings().map(({ f }) => [f.title, f]));
      const priorStatus = prior.map((p) =>
        p.decision === "fix"
          ? { findingId: p.id, status: "addressed", note: "Fixed in your latest changes." }
          : { findingId: p.id, status: "still_present", note: known.get(p.title) ? `Still there: ${firstSentence(known.get(p.title)!.why)}` : "Still present in the current code." },
      );
      const fixed = priorStatus.filter((p) => p.status === "addressed").length;
      return {
        output: {
          findings: [],
          verdict: priorStatus.some((p) => p.status === "still_present") ? "merge_with_followups" : "approve",
          summary: `Re-checked ${prior.length} open finding${prior.length === 1 ? "" : "s"}: ${fixed} fixed, ${prior.length - fixed} still open. No new problems.`,
          coverage: "Re-read every file with an open finding and the diff since the last run.",
          priorStatus,
        },
        text: "Re-run complete.",
      };
    }
    case "stack": {
      const stack = stackFromPrompt(prompt);
      if (!stack) return { output: { findings: [] }, text: "Nothing spans more than one layer." };
      const ids = new Map<string, number>();
      for (const line of prompt.split("\n")) {
        const m = line.match(/^\s*- \[id (\d+)\] \[\w+\] (.*)$/);
        if (!m) continue;
        for (const f of stack.cross.findings) for (const title of f.replaces) if (m[2]!.startsWith(title)) ids.set(title, Number(m[1]));
      }
      const out = stackOutput(stack, ids);
      return { output: out, text: `${out.findings.length} findings span layers.` };
    }
    case "qa": {
      const title = session?.finding ?? prompt.match(/^\[(?:critical|high|medium|low)\] (.+)$/m)?.[1] ?? null;
      const f = title ? allScriptFindings().find((x) => x.f.title === title)?.f : undefined;
      const where = prompt.match(/^Location: (.+)$/m)?.[1];
      const answer =
        f?.qa?.answer ??
        (f
          ? `I re-read ${where && where !== "general" ? `\`${where}\`` : "the code"} and its callers. It holds up. ${firstSentence(f.why)} ${f.fix ? `The fix is small: ${f.fix}` : ""}`.trim()
          : "I re-read the code around this finding and its callers. It holds up as written; I'd post it.");
      return { output: { answer, recommendation: f?.qa?.recommendation ?? "accept", revised: null }, text: answer };
    }
    case "pr-qa": {
      const question = (prompt.split("Reviewer's question:")[1] ?? "").toLowerCase();
      const pr = t?.kind === "pr" ? t.pr : null;
      const canned = pr?.askPr ? (Object.entries(pr.askPr).find(([k]) => k !== "*" && question.includes(k.toLowerCase()))?.[1] ?? pr.askPr["*"]) : undefined;
      const recon = t ? scriptFor(t).recon : undefined;
      const answer =
        canned ??
        (recon
          ? `Short version: ${recon.summary}\n\nThe part worth your attention is ${recon.focus[0]?.replace(/^\w/, (c) => c.toLowerCase()) ?? "the main code path"}. ${recon.risks[0] ? `The overview flagged it as ${recon.risks[0][0]} risk: ${recon.risks[0][1].replace(/^\w/, (c) => c.toLowerCase())}.` : ""}`.trim()
          : "I read the change and the code around it. It does what the title says, and nothing outside the diff depends on the lines it changes.");
      return { output: { answer }, text: answer };
    }
    default:
      return { output: null, text: "Done." };
  }
}

// ---------- the trail ----------

/** Deterministic 0..1 from a string (for durations, costs and jitter). */
export const unit = (s: string) => createHash("sha1").update(s).digest().readUInt32BE(0) / 0xffffffff;

const BASE_MS: Record<Stage, number> = {
  recon: 18_000,
  review: 32_000,
  rereview: 20_000,
  "self-review": 28_000,
  "self-rerun": 20_000,
  stack: 30_000,
  qa: 9_000,
  "pr-qa": 9_000,
  text: 5_000,
};

function readResult(files: Map<string, string> | null, path: string): string {
  const text = files?.get(path);
  if (text === undefined) return "File does not exist.";
  return lines(text)
    .slice(0, 80)
    .map((l, i) => `${String(i + 1).padStart(6)}→${l}`)
    .join("\n");
}

function grepResult(files: Map<string, string> | null, pattern: string, dir = ""): string {
  if (!files) return "No matches found";
  const hits: string[] = [];
  for (const [path, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (dir && !path.startsWith(dir)) continue;
    lines(text).forEach((l, i) => {
      if (l.includes(pattern) && hits.length < 12) hits.push(`${path}:${i + 1}:${l.trim()}`);
    });
  }
  return hits.length ? hits.join("\n") : "No matches found";
}

/** Tool calls and narration to stream before the answer. Paths are absolute inside the checkout, like Claude's. */
export function planSteps(stage: Stage, t: Target | null, cwd: string, prompt: string): Step[] {
  const files = t ? (t.kind === "pr" ? prHeadFiles(t.pr) : null) : null;
  const change = t ? targetChange(t) : null;
  const abs = (p: string) => `${cwd.replace(/\/$/, "")}/${p}`;
  const toStep = (s: TrailStep): Step =>
    "read" in s
      ? { kind: "tool", tool: "Read", input: { file_path: abs(s.read) }, result: readResult(files, s.read) }
      : "grep" in s
        ? { kind: "tool", tool: "Grep", input: { pattern: s.grep, ...(s.in ? { path: abs(s.in) } : {}), output_mode: "content" }, result: grepResult(files, s.grep, s.in) }
        : "glob" in s
          ? { kind: "tool", tool: "Glob", input: { pattern: s.glob }, result: [...(files?.keys() ?? [])].filter((p) => p.endsWith(s.glob.replace(/^\*+/, ""))).join("\n") || "No files found" }
          : "bash" in s
            ? { kind: "tool", tool: "Bash", input: { command: s.bash, description: "Read-only git" }, result: "(output shown to the agent)" }
            : { kind: "text", text: s.say };

  switch (stage) {
    case "recon": {
      const areas = [...prompt.matchAll(/^- (.+?) — (\d+) files?, \+(\d+) −(\d+)$/gm)].map((m) => m[1]!);
      const stack = prompt.match(/^## Stack\n([\s\S]*?)\n\n/m)?.[1]?.trim();
      return [
        { kind: "text", text: `Reading the description and the diff${change ? ` (${change.files.length} file${change.files.length === 1 ? "" : "s"}, +${change.additions} −${change.deletions})` : ""}.` },
        { kind: "text", text: `Naming the areas: ${areas.join(", ") || "one area"}.` },
        ...(stack && !stack.startsWith("(not part") ? [{ kind: "text" as const, text: "It's part of a stack, so noting what the neighbours cover." }] : []),
        { kind: "text", text: "Weighing the heuristic estimate against what's actually subtle here." },
      ];
    }
    case "review":
    case "self-review":
    case "rereview": {
      const script = t ? (stage === "rereview" && t.kind === "pr" ? t.pr.rereview : scriptFor(t).review) : undefined;
      if (script?.trail) return [...script.trail.map(toStep), { kind: "text", text: "Double-checking each finding against the code before writing up." }];
      const auto: TrailStep[] = [];
      for (const f of change?.files ?? []) auto.push({ read: f.path });
      auto.push({ bash: "git log --oneline -5" });
      for (const f of (script?.findings ?? []).slice(0, 4)) {
        if (f.at) auto.push({ grep: f.at.match.replace(/[()]/g, "").slice(0, 32).trim(), in: f.at.path.split("/").slice(0, -1).join("/") || undefined });
        auto.push({ say: `${f.title}. Checking whether anything handles it elsewhere.` });
      }
      if (!script?.findings.length) auto.push({ say: "Nothing looks wrong so far; checking callers of what changed." }, { grep: "export", in: "src" });
      return [...auto.map(toStep), { kind: "text", text: "Double-checking each finding against the code before writing up." }];
    }
    case "self-rerun":
      return [
        { kind: "text", text: "Re-checking the open findings against your latest changes." },
        ...(change?.files ?? []).slice(0, 3).map((f) => toStep({ read: f.path })),
        { kind: "text", text: "Looking for anything new the fixes introduced." },
      ];
    case "stack": {
      const stack = stackFromPrompt(prompt);
      const top = stack ? [...PRS].filter((p) => p.repo === stack.repo).find((p) => p.number === Math.max(...[...prompt.matchAll(/^## Layer \d+: #(\d+) /gm)].map((m) => Number(m[1])))) : undefined;
      const topFiles = top ? prHeadFiles(top) : null;
      const steps = (stack?.cross.trail ?? [{ say: "Reading the layers together." }]).map((s) =>
        "read" in s ? ({ kind: "tool", tool: "Read", input: { file_path: abs(s.read) }, result: readResult(topFiles, s.read) } as Step) : toStep(s),
      );
      return [...steps, { kind: "text", text: "Checking which per-layer findings these cover." }];
    }
    case "qa":
    case "pr-qa": {
      const where = prompt.match(/^Location: ([^:\s]+)/m)?.[1];
      const first = where && where !== "general" ? where : change?.files[0]?.path;
      return [
        ...(first ? [toStep({ read: first })] : []),
        { kind: "text", text: stage === "qa" ? "Checking the finding against the code again." : "Tracing that through the change." },
      ];
    }
    default:
      return [{ kind: "text", text: "Thinking." }];
  }
}

export function plan(stage: Stage, t: Target | null, cwd: string, prompt: string, schema: unknown, session: Session | null): Plan {
  const { output, text } = outputFor(stage, t, prompt, schema, session);
  const key = `${stage}:${t ? targetLabel(t) : prompt.slice(0, 200)}`;
  const r = unit(key);
  const size = t ? targetChange(t).additions + targetChange(t).deletions : 40;
  const cost: Record<Stage, [number, number]> = {
    recon: [0.03, 0.06],
    review: [0.55, 1.3],
    rereview: [0.25, 0.4],
    "self-review": [0.45, 0.9],
    "self-rerun": [0.2, 0.35],
    stack: [0.9, 0.8],
    qa: [0.07, 0.12],
    "pr-qa": [0.08, 0.14],
    text: [0.01, 0.01],
  };
  const [lo, span] = cost[stage];
  return {
    steps: planSteps(stage, t, cwd, prompt),
    output,
    text,
    durationMs: Math.round(BASE_MS[stage] * (0.85 + 0.3 * r)),
    costUsd: Math.round((lo + span * r) * 10000) / 10000,
    usage: { input: 1800 + size * 40 + Math.round(r * 900), cacheRead: 21000 + Math.round(r * 30000) + size * 120, output: 900 + Math.round(r * 2400) },
  };
}

/** PR Bunny's mock speed: 1 = realistic (~20–40 s per run), 5 = five times faster, 0 = instant. */
export function speed(): number {
  const raw = process.env.PR_BUNNY_MOCK_SPEED;
  const n = raw === undefined || raw === "" ? 1 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/** How long to wait before step `i` of `n` (deterministic jitter), at the current speed. */
export function stepDelay(p: Plan, i: number, key: string): number {
  const s = speed();
  if (s === 0) return 0;
  const n = p.steps.length + 2;
  const weight = 0.6 + 0.8 * unit(`${key}:${i}`);
  return Math.round(((p.durationMs / n) * weight) / s);
}

/** Resolves who the run is about: a saved session (resume), else the prompt. */
export function resolveJob(opts: { prompt: string; schema: unknown; cwd: string; resume: string | null; fork: boolean }): {
  session: Session;
  stage: Stage;
  target: Target | null;
  resumed: boolean;
} {
  const prior = opts.resume ? loadSession(opts.resume) : null;
  const promptStage = stageOf(opts.schema, opts.prompt);
  // A resumed run carries on the same step unless the schema says it's a different one (e.g. Q&A forked from a review).
  const continuing = Boolean(prior && !prior.done && prior.stage === promptStage) || Boolean(prior && /pick up where you left off/i.test(opts.prompt) && !prior.done);
  const stage = continuing && prior ? prior.stage : promptStage;
  let target = targetOf(opts.prompt, opts.cwd);
  if (!target && prior?.repo) {
    const pr = prior.pr ? findPr(prior.repo, prior.pr) : null;
    const b = !pr && prior.branch ? findBranch(prior.repo, prior.branch) : null;
    target = pr ? { kind: "pr", pr } : b ? { kind: "branch", branch: b } : null;
  }
  const finding = prior?.finding ?? opts.prompt.match(/^\[(?:critical|high|medium|low)\] (.+)$/m)?.[1] ?? null;
  const keepId = prior && !opts.fork;
  const session: Session = {
    id: keepId ? prior.id : newSessionId(),
    stage,
    repo: target ? targetRepo(target) : (prior?.repo ?? null),
    pr: target?.kind === "pr" ? target.pr.number : (prior?.pr ?? null),
    branch: target?.kind === "branch" ? target.branch.branch : (prior?.branch ?? null),
    finding: stage === "qa" ? finding : null,
    step: continuing && prior ? prior.step : 0,
    done: false,
  };
  return { session, stage, target, resumed: continuing };
}

export { STACKS };
