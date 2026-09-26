// Runs OpenAI's Codex CLI (`codex exec`) on the user's ChatGPT sign-in, as an alternative to
// Claude Code. Same contract as runClaude: prompt in, progress events out, one structured result.
//
// NOT YET RUN FOR REAL: written from Codex's documented `exec` interface (`--json` event stream,
// `--output-schema`, `exec resume`). If a Codex release changes these, this is the file to fix.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { killOnAbort, type ClaudeOptions, type ClaudeResult } from "./claude";
import { DATA_DIR, LOG_DIR } from "./config";

/** Stored session ids are prefixed so a Claude session is never resumed with Codex, or vice versa. */
export const CODEX_SESSION = "codex:";

/** Environment without API keys, so Codex uses the ChatGPT sign-in (plan billing, like Claude's subscription). */
export function codexEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "OPENAI_API_KEY" || k === "CODEX_API_KEY" || k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN") continue;
    env[k] = v;
  }
  return env;
}

/**
 * OpenAI structured outputs want every property listed as required and no unsupported keywords.
 * Optional properties become nullable instead, which the callers already treat as "absent".
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const s: Record<string, any> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "minimum" || k === "maximum" || k === "minItems" || k === "maxItems") continue;
    s[k] = strictSchema(v);
  }
  if (s.type === "object" && s.properties) {
    const required = new Set<string>(s.required ?? []);
    for (const [k, v] of Object.entries<any>(s.properties)) {
      if (required.has(k)) continue;
      const types = Array.isArray(v.type) ? v.type : [v.type];
      s.properties[k] = { ...v, type: types.includes("null") ? types : [...types, "null"] };
    }
    s.required = Object.keys(s.properties);
    s.additionalProperties = false;
  }
  return s;
}

/** What Codex needs told that Claude gets from its own tools and flags. */
const CODEX_NOTE = `You're running in Codex with a read-only sandbox and no network. Read code with shell commands (cat, sed -n, rg, git diff/log/show/blame); nothing can be written and \`gh\` can't reach GitHub. Wherever these instructions mention a "structured output tool" or StructuredOutput, that means: finish with your answer as a single JSON object matching the provided schema, with nothing before or after it.`;

export function buildCodexArgs(o: ClaudeOptions, schemaFile: string | null, cwd: string): string[] {
  const args = ["exec", "--json", "--skip-git-repo-check", "-C", cwd, "-s", "read-only"];
  if (o.model && o.model !== "default") args.push("-m", o.model);
  if (o.effort && o.effort !== "default") args.push("-c", `model_reasoning_effort="${o.effort}"`);
  // A PR can add AGENTS.md; like Claude's settings files, it must not steer the reviewer.
  args.push("-c", "project_doc_max_bytes=0");
  // No MCP servers: the review gets the checkout and nothing else.
  args.push("-c", "mcp_servers={}");
  if (schemaFile) args.push("--output-schema", schemaFile);
  const resume = o.resume?.startsWith(CODEX_SESSION) ? o.resume.slice(CODEX_SESSION.length) : null;
  if (resume) args.push("resume", resume);
  args.push("-"); // prompt on stdin
  return args;
}

/** Codex's final message should be bare JSON; tolerate a fenced block. */
function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    return start >= 0 && end > start ? JSON.parse(t.slice(start, end + 1)) : null;
  }
}

export async function runCodex<T = unknown>(o: ClaudeOptions): Promise<ClaudeResult<T>> {
  const logPath = join(LOG_DIR, `${o.logName}.jsonl`);
  const log = Bun.file(logPath).writer();
  const result: ClaudeResult<T> = {
    sessionId: null, structured: null, text: "", isError: false, error: null, hitTurnLimit: false,
    costUsd: null, durationMs: null, inputTokens: null, outputTokens: null, denials: [], logPath,
  };
  // Stopped before it started: don't spawn at all.
  if (o.signal?.aborted) {
    await log.end();
    return { ...result, isError: true, error: "Cancelled" };
  }
  const codex = Bun.which("codex", { PATH: codexEnv().PATH });
  if (!codex) {
    await log.end();
    return { ...result, isError: true, error: "Codex isn't installed. Install it (brew install codex), or switch the agent back to Claude Code in Settings." };
  }

  // No-tool steps (the overview) run in an empty folder so there's nothing to read.
  const cwd = o.tools.length ? o.cwd : join(DATA_DIR, "empty");
  mkdirSync(cwd, { recursive: true });
  let schemaFile: string | null = null;
  if (o.jsonSchema) {
    schemaFile = join(LOG_DIR, `${o.logName}.schema.json`);
    await Bun.write(schemaFile, JSON.stringify(strictSchema(o.jsonSchema)));
  }
  const prompt = [o.appendSystemPrompt, CODEX_NOTE, o.prompt].filter(Boolean).join("\n\n---\n\n");
  const started = Date.now();
  const proc = Bun.spawn([codex, ...buildCodexArgs(o, schemaFile, cwd)], {
    cwd,
    env: codexEnv(),
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stopKilling = killOnAbort(proc, o.signal);

  let finalMessage = "";
  let failed: string | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    log.write(line + "\n");
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "thread.started" && ev.thread_id) result.sessionId = `${CODEX_SESSION}${ev.thread_id}`;
    else if (ev.type === "item.started" || ev.type === "item.completed") {
      const item = ev.item ?? {};
      if (item.type === "agent_message" && ev.type === "item.completed") finalMessage = item.text ?? finalMessage;
      else if (item.type === "command_execution" && ev.type === "item.started") {
        const cmd = String(item.command ?? "").replace(/^\/bin\/(ba|z)?sh -lc /, "").replace(/^['"]|['"]$/g, "");
        o.onProgress?.({ text: `Running ${cmd.slice(0, 120)}`, tool: "Shell" });
      } else if (item.type === "web_search" && ev.type === "item.started") o.onProgress?.({ text: `Searching ${item.query ?? ""}`, tool: "Search" });
      else if (item.type === "reasoning" && ev.type === "item.completed" && item.text) {
        const first = String(item.text).trim().split("\n")[0]!.replace(/\*\*/g, "");
        if (first) o.onProgress?.({ text: first.length > 160 ? first.slice(0, 157) + "…" : first });
      }
    } else if (ev.type === "turn.completed") {
      const u = ev.usage ?? {};
      result.inputTokens = (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0);
      result.outputTokens = u.output_tokens ?? null;
    } else if (ev.type === "turn.failed") failed = ev.error?.message ?? "Codex turn failed";
    else if (ev.type === "error") failed = ev.message ?? "Codex error";
  };

  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf);
  const exitCode = await proc.exited;
  stopKilling();
  const stderr = (await new Response(proc.stderr).text()).trim();
  await log.end();

  result.durationMs = Date.now() - started;
  result.text = finalMessage;
  if (o.signal?.aborted) return { ...result, isError: true, error: "Cancelled" };
  if (failed || exitCode !== 0) return { ...result, isError: true, error: failed ?? (stderr.split("\n").at(-1) || `codex exited with code ${exitCode}`) };
  if (o.jsonSchema) {
    try {
      result.structured = parseJson(finalMessage) as T;
    } catch {
      result.structured = null;
    }
    if (result.structured == null) return { ...result, isError: true, error: "Codex finished without returning JSON that matches the schema" };
  }
  return result;
}
