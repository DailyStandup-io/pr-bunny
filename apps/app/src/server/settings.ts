// User-editable settings, persisted in SQLite. Env vars (config.ts) supply the defaults.
import type { Effort, ModelOption, Provider, ProviderOptions, Settings, Stage } from "../shared/types";
import { MODELS, WORKTREE_TTL_HOURS } from "./config";
import { db } from "./db/db";

/** Offered in the UI; any other model id the CLI accepts can be typed in as a custom value. */
export const MODEL_OPTIONS: ModelOption[] = [
  { id: "opus", label: "Opus 5.5", note: "Most capable for deep reasoning; the default for reviews" },
  { id: "claude-fable-5-1", label: "Fable 5.1", note: "Newest model family" },
  { id: "sonnet", label: "Sonnet 5", note: "Fast and strong; the default for the overview" },
  { id: "haiku", label: "Haiku 4.5", note: "Fastest and lightest; fine for quick overviews" },
];

const CODEX_MODELS: ModelOption[] = [
  { id: "default", label: "Codex default", note: "Whichever model your Codex config uses" },
  { id: "gpt-5-codex", label: "GPT-5 Codex", note: "Tuned for code; the strongest choice for reviews" },
  { id: "gpt-5", label: "GPT-5", note: "General purpose" },
  { id: "gpt-5-mini", label: "GPT-5 mini", note: "Fast and light; fine for the overview" },
];

const CLAUDE_EFFORTS: Array<{ key: Effort; label: string }> = [
  { key: "default", label: "Model default" },
  { key: "low", label: "Low" },
  { key: "medium", label: "Medium" },
  { key: "high", label: "High" },
  { key: "xhigh", label: "Extra high" },
  { key: "max", label: "Max" },
];
const CODEX_EFFORTS: Array<{ key: Effort; label: string }> = [
  { key: "default", label: "Model default" },
  { key: "minimal", label: "Minimal" },
  { key: "low", label: "Low" },
  { key: "medium", label: "Medium" },
  { key: "high", label: "High" },
];

/** What each agent offers. Switching agent resets models and effort to that agent's defaults. */
export const PROVIDERS: Record<Provider, ProviderOptions> = {
  claude: {
    label: "Claude Code",
    hint: "Which Claude model runs each step. Runs on your Claude subscription through Claude Code. Changes apply to the next run.",
    models: MODEL_OPTIONS,
    efforts: CLAUDE_EFFORTS,
    defaults: { models: { ...MODELS }, effort: { recon: "default", review: "default", qa: "default" } },
  },
  codex: {
    label: "Codex",
    hint: "Which OpenAI model runs each step. Runs on your ChatGPT plan through Codex. Changes apply to the next run.",
    models: CODEX_MODELS,
    efforts: CODEX_EFFORTS,
    defaults: { models: { recon: "default", review: "default", qa: "default" }, effort: { recon: "default", review: "high", qa: "medium" } },
  },
};
const STAGES: Stage[] = ["recon", "review", "qa"];

export const DEFAULTS: Settings = {
  provider: "claude",
  models: { ...PROVIDERS.claude.defaults.models },
  effort: { ...PROVIDERS.claude.defaults.effort },
  worktreeTtlHours: WORKTREE_TTL_HOURS,
  dismissalMemory: true,
  dismissalMemoryLimit: 25,
  stackContextDepth: 2,
  reviewMaxTurns: 250,
  reconMaxTurns: 10,
  stackOrder: "base",
  stackConcurrency: 1,
  stackMaxAll: 8,
  stackIncludeDone: false,
};

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  const stored = Object.fromEntries(
    (db.query("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>).map((r) => [r.key, JSON.parse(r.value)]),
  ) as Partial<Settings>;
  cache = {
    ...DEFAULTS,
    ...stored,
    models: { ...DEFAULTS.models, ...stored.models },
    effort: { ...DEFAULTS.effort, ...stored.effort },
  };
  return cache;
}

const int = (v: unknown, name: string, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number between ${min} and ${max}`);
  return n;
};

/** Validates a partial update against `base` and returns the result, without saving. Unknown keys are ignored. */
export function applySettings(base: Settings, patch: Partial<Settings>): Settings {
  const next = structuredClone(base);
  if (patch.provider !== undefined) {
    if (!(patch.provider in PROVIDERS)) throw new Error(`Unknown agent: ${patch.provider}`);
    if (patch.provider !== next.provider) {
      next.provider = patch.provider;
      next.models = { ...PROVIDERS[patch.provider].defaults.models };
      next.effort = { ...PROVIDERS[patch.provider].defaults.effort };
    }
  }
  if (patch.models) {
    for (const stage of STAGES) {
      const m = patch.models[stage];
      if (m === undefined) continue;
      // Passed to the CLI as an argument (never through a shell), but keep it to model-id characters.
      if (typeof m !== "string" || !/^[\w.\-\[\]]{2,64}$/.test(m)) throw new Error(`Invalid model for ${stage}: ${m}`);
      next.models[stage] = m;
    }
  }
  if (patch.effort) {
    for (const stage of STAGES) {
      const e = patch.effort[stage];
      if (e === undefined) continue;
      if (!PROVIDERS[next.provider].efforts.some((x) => x.key === e)) throw new Error(`Invalid effort for ${stage}: ${e}`);
      next.effort[stage] = e;
    }
  }
  if (patch.worktreeTtlHours !== undefined) next.worktreeTtlHours = int(patch.worktreeTtlHours, "Checkout cleanup", 1, 24 * 90);
  if (patch.dismissalMemory !== undefined) next.dismissalMemory = Boolean(patch.dismissalMemory);
  if (patch.dismissalMemoryLimit !== undefined) next.dismissalMemoryLimit = int(patch.dismissalMemoryLimit, "Dismissal memory size", 1, 200);
  if (patch.stackContextDepth !== undefined) next.stackContextDepth = int(patch.stackContextDepth, "Stack context depth", 0, 10);
  if (patch.reviewMaxTurns !== undefined) next.reviewMaxTurns = int(patch.reviewMaxTurns, "Review turn limit", 20, 1000);
  if (patch.reconMaxTurns !== undefined) next.reconMaxTurns = int(patch.reconMaxTurns, "Overview turn limit", 2, 100);
  if (patch.stackOrder !== undefined) {
    if (patch.stackOrder !== "base" && patch.stackOrder !== "top") throw new Error("Review order must be base or top");
    next.stackOrder = patch.stackOrder;
  }
  if (patch.stackConcurrency !== undefined) next.stackConcurrency = int(patch.stackConcurrency, "PRs at once", 1, 3);
  if (patch.stackMaxAll !== undefined) next.stackMaxAll = int(patch.stackMaxAll, "Review all limit", 2, 30);
  if (patch.stackIncludeDone !== undefined) next.stackIncludeDone = Boolean(patch.stackIncludeDone);
  return next;
}

/** Validates and saves a partial update. Unknown keys are ignored. */
export function updateSettings(patch: Partial<Settings>): Settings {
  const next = applySettings(getSettings(), patch);
  const upsert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  db.transaction(() => {
    for (const [k, v] of Object.entries(next)) upsert.run(k, JSON.stringify(v));
  })();
  cache = next;
  return next;
}

export function resetSettings(): Settings {
  db.run("DELETE FROM settings");
  cache = null;
  return getSettings();
}
