// Runs headless Claude Code (`claude -p`) on the user's subscription login.
// Never use the API / Agent SDK here — see CLAUDE.md.
import { join } from "node:path";
import { LOG_DIR } from "./config";

export interface ClaudeOptions {
  prompt: string;
  cwd: string;
  model: string;
  /** Built-in tools Claude may see at all. `[]` disables tools entirely. */
  tools: string[];
  /** Permission rules for tools that would otherwise prompt, e.g. `Bash(git diff:*)`. */
  allowedTools?: string[];
  jsonSchema?: object;
  appendSystemPrompt?: string;
  resume?: string;
  /** With `resume`: branch into a new session instead of appending to the original. */
  forkSession?: boolean;
  /**
   * `dontAsk` denies every tool call not matched by `allowedTools` — combined with path-scoped
   * `Read(//abs/dir/**)` rules this keeps Claude inside the PR checkout.
   */
  permissionMode?: "dontAsk";
  maxTurns?: number;
  /** CLI `--effort`; omitted = the model's default. */
  effort?: string;
  signal?: AbortSignal;
  logName: string;
  onProgress?: (p: { text: string; tool?: string }) => void;
}

export interface ClaudeResult<T = unknown> {
  sessionId: string | null;
  structured: T | null;
  text: string;
  isError: boolean;
  error: string | null;
  /** Stopped because it used every turn in `maxTurns`; `sessionId` can be resumed to finish. */
  hitTurnLimit: boolean;
  costUsd: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Tool calls blocked by the permission rules (worth watching: too many means rules are too tight). */
  denials: Array<{ tool: string; input: unknown }>;
  logPath: string;
}

/** Copy of the environment with API credentials removed, so the CLI falls back to OAuth. */
export function subscriptionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN" || k === "CLAUDE_CODE_USE_BEDROCK" || k === "CLAUDE_CODE_USE_VERTEX") continue;
    env[k] = v;
  }
  return env;
}

/** How long a stopped agent gets to exit after SIGTERM before it's killed outright. */
export const KILL_GRACE_MS = 5_000;

/**
 * Stops `proc` when `signal` aborts: SIGTERM first, then SIGKILL if it's still running after
 * KILL_GRACE_MS. Returns a cleanup to call once the process has exited.
 */
export function killOnAbort(proc: { kill: (sig?: number | NodeJS.Signals) => void; exitCode: number | null; signalCode?: string | null }, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    proc.kill("SIGTERM");
    timer = setTimeout(() => {
      if (proc.exitCode === null && !proc.signalCode) proc.kill("SIGKILL");
    }, KILL_GRACE_MS);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
  };
}

export function buildArgs(o: ClaudeOptions): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", o.model,
    "--strict-mcp-config",
    // Load no settings files: a PR checkout's .claude/settings.json could otherwise run hooks on
    // this machine, and user-level allow rules would widen the read-only tool set.
    "--setting-sources", "",
    "--tools", o.tools.length ? o.tools.join(",") : "",
  ];
  if (o.allowedTools?.length) args.push("--allowedTools", ...o.allowedTools);
  if (o.jsonSchema) args.push("--json-schema", JSON.stringify(o.jsonSchema));
  if (o.appendSystemPrompt) args.push("--append-system-prompt", o.appendSystemPrompt);
  if (o.resume) args.push("--resume", o.resume);
  if (o.resume && o.forkSession) args.push("--fork-session");
  if (o.permissionMode) args.push("--permission-mode", o.permissionMode);
  if (o.maxTurns) args.push("--max-turns", String(o.maxTurns));
  if (o.effort && o.effort !== "default") args.push("--effort", o.effort);
  return args;
}

export async function runClaude<T = unknown>(o: ClaudeOptions): Promise<ClaudeResult<T>> {
  const logPath = join(LOG_DIR, `${o.logName}.jsonl`);
  const log = Bun.file(logPath).writer();

  const result: ClaudeResult<T> = {
    sessionId: null, structured: null, text: "", isError: false, error: null, hitTurnLimit: false,
    costUsd: null, durationMs: null, inputTokens: null, outputTokens: null, denials: [], logPath,
  };
  // Stopped before it started (e.g. while the checkout was being prepared): don't spawn at all.
  if (o.signal?.aborted) {
    await log.end();
    return { ...result, isError: true, error: "Cancelled" };
  }

  const proc = Bun.spawn(["claude", ...buildArgs(o)], {
    cwd: o.cwd,
    env: subscriptionEnv(),
    stdin: new Blob([o.prompt]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stopKilling = killOnAbort(proc, o.signal);
  let sawResult = false;

  const handle = (line: string) => {
    if (!line.trim()) return;
    log.write(line + "\n");
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.session_id && !result.sessionId) result.sessionId = ev.session_id;
    for (const p of describeEvent(ev)) o.onProgress?.(p);
    if (ev.type === "result") {
      sawResult = true;
      if (ev.session_id) result.sessionId = ev.session_id;
      result.structured = (ev.structured_output ?? null) as T | null;
      result.text = typeof ev.result === "string" ? ev.result : "";
      result.isError = Boolean(ev.is_error) || ev.subtype !== "success";
      if (result.isError) result.error = ev.result || ev.subtype || "Claude run failed";
      result.hitTurnLimit = ev.subtype === "error_max_turns";
      result.costUsd = ev.total_cost_usd ?? null;
      result.durationMs = ev.duration_ms ?? null;
      const u = ev.usage ?? {};
      result.inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      result.outputTokens = u.output_tokens ?? null;
      result.denials = (ev.permission_denials ?? []).map((d: any) => ({ tool: d.tool_name, input: d.tool_input }));
    }
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

  if (o.signal?.aborted) {
    result.isError = true;
    result.error = "Cancelled";
  } else if (!sawResult) {
    result.isError = true;
    result.error = stderr || `claude exited with code ${exitCode} and no result`;
  }
  if (!result.isError && o.jsonSchema && result.structured == null) {
    result.isError = true;
    result.error = "Claude finished without returning structured output";
  }
  return result;
}

/** Turns stream-json events into short human-readable progress lines. */
export function describeEvent(ev: any): Array<{ text: string; tool?: string }> {
  if (ev.type !== "assistant" || ev.parent_tool_use_id) return [];
  const out: Array<{ text: string; tool?: string }> = [];
  for (const block of ev.message?.content ?? []) {
    if (block.type === "tool_use") {
      if (block.name === "StructuredOutput") out.push({ text: "Writing up results", tool: block.name });
      else out.push({ text: describeTool(block.name, block.input ?? {}), tool: block.name });
    } else if (block.type === "text" && block.text?.trim()) {
      const first = block.text.trim().split("\n")[0]!;
      out.push({ text: first.length > 160 ? first.slice(0, 157) + "…" : first });
    }
  }
  return out;
}

function describeTool(name: string, input: Record<string, any>): string {
  switch (name) {
    case "Read": return `Reading ${input.file_path ?? "a file"}`;
    case "Grep": return `Searching for ${JSON.stringify(input.pattern ?? "")}${input.path ? ` in ${input.path}` : ""}`;
    case "Glob": return `Listing ${input.pattern ?? "files"}`;
    case "Bash": return `Running ${String(input.command ?? "").slice(0, 120)}`;
    case "Task":
    case "Agent": return `Delegating: ${input.description ?? "subtask"}`;
    default: return `Using ${name}`;
  }
}
