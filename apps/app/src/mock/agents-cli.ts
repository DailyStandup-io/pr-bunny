// Command lines of the fake `claude` and `codex` (src/mock/bin). Both parse exactly the arguments
// PR Bunny passes (buildArgs in src/server/claude.ts, buildCodexArgs in src/server/codex.ts) and
// stream events in the real formats (`stream-json` / `exec --json`), paced by PR_BUNNY_MOCK_SPEED.
import { readFileSync, realpathSync } from "node:fs";
import { plan, resolveJob, saveSession, stepDelay, type Plan, type Session, type Step } from "./agent";
import { VIEWER } from "./world/people";

const write = (ev: unknown) => process.stdout.write(`${JSON.stringify(ev)}\n`);

/** Exit promptly on Stop: PR Bunny SIGTERMs the agent and expects it gone well within 5 s. */
function exitOnSignals(onExit?: () => void) {
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.on(sig, () => {
      onExit?.();
      process.exit(sig === "SIGTERM" ? 143 : 130);
    });
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readStdin(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

// ---------- claude ----------

const CLAUDE_VERSION = "2.1.112 (Claude Code)";

export async function claudeMain(args: string[]): Promise<number> {
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(CLAUDE_VERSION);
    return 0;
  }
  if (args[0] === "auth" && args[1] === "status") {
    const status = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: VIEWER.email, orgName: "Quokka Labs", subscriptionType: "max" };
    console.log(args.includes("--json") ? JSON.stringify(status, null, 2) : `Logged in as ${VIEWER.email} (Claude Max)`);
    return 0;
  }
  if (!args.includes("-p") && !args.includes("--print")) {
    process.stderr.write(`mock claude: unsupported: claude ${args.join(" ")}\n`);
    return 1;
  }
  if (argValue(args, "--output-format") !== "stream-json") {
    process.stderr.write("mock claude: only --output-format stream-json is supported (it's what PR Bunny uses)\n");
    return 1;
  }

  const prompt = await readStdin();
  const schemaText = argValue(args, "--json-schema");
  const schema = schemaText ? JSON.parse(schemaText) : null;
  const maxTurns = Number(argValue(args, "--max-turns") ?? 0) || Infinity;
  const model = argValue(args, "--model") ?? "sonnet";
  // The checkout as PR Bunny names it (its Read(//<checkout>/**) rule), not process.cwd(), which
  // resolves symlinks (/var → /private/var) and wouldn't match the prefix the app strips from progress lines.
  const readRule = args.find((a) => /^Read\(\/\/.+\/\*\*\)$/.test(a));
  const cwd = readRule ? readRule.slice(6, -4) : (process.env.PWD && realpathSync(process.env.PWD) === realpathSync(process.cwd()) ? process.env.PWD : process.cwd());
  const { session, stage, target } = resolveJob({
    prompt,
    schema,
    cwd,
    resume: argValue(args, "--resume") ?? null,
    fork: args.includes("--fork-session"),
  });
  const p = plan(stage, target, cwd, prompt, schema, session);
  let current: Session = session;
  exitOnSignals(() => saveSession(current));
  saveSession(session);

  const modelId = model === "opus" ? "claude-opus-4-5" : model === "haiku" ? "claude-haiku-4-5" : model === "sonnet" ? "claude-sonnet-4-5" : model;
  const tools = args.includes("--tools") ? (argValue(args, "--tools") || "").split(",").filter(Boolean) : [];
  write({ type: "system", subtype: "init", cwd, session_id: session.id, tools: [...tools, ...(schema ? ["StructuredOutput"] : [])], mcp_servers: [], model: modelId, permissionMode: argValue(args, "--permission-mode") ?? "default", apiKeySource: "none", output_style: "default" });

  const assistant = (content: unknown[]) =>
    write({ type: "assistant", message: { id: `msg_mock_${current.step}`, type: "message", role: "assistant", model: modelId, content, stop_reason: null, usage: { input_tokens: 6, output_tokens: 40 } }, parent_tool_use_id: null, session_id: session.id });
  const started = Date.now();
  let turns = 0;
  const key = `${session.id}:${stage}`;

  for (let i = session.step; i < p.steps.length; i++) {
    await Bun.sleep(stepDelay(p, i, key));
    const step = p.steps[i]!;
    if (step.kind === "tool") {
      if (turns + 1 > maxTurns) return finishClaude(p, current, started, turns, true);
      turns++;
      const id = `toolu_mock_${i}_${session.id.slice(0, 8)}`;
      assistant([{ type: "tool_use", id, name: step.tool, input: step.input }]);
      write({ type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: step.result }] }, parent_tool_use_id: null, session_id: session.id });
    } else {
      assistant([{ type: "text", text: step.text }]);
    }
    current = { ...current, step: i + 1 };
    saveSession(current);
  }
  await Bun.sleep(stepDelay(p, p.steps.length, key));
  if (schema) {
    if (turns + 1 > maxTurns) return finishClaude(p, current, started, turns, true);
    turns++;
    assistant([{ type: "tool_use", id: `toolu_mock_out_${session.id.slice(0, 8)}`, name: "StructuredOutput", input: p.output }]);
  }
  return finishClaude(p, current, started, turns, false);
}

function finishClaude(p: Plan, session: Session, started: number, turns: number, hitLimit: boolean): number {
  saveSession({ ...session, done: !hitLimit });
  const scale = hitLimit ? Math.max(0.2, session.step / Math.max(1, p.steps.length)) : 1;
  write({
    type: "result",
    subtype: hitLimit ? "error_max_turns" : "success",
    is_error: hitLimit,
    duration_ms: Math.max(Date.now() - started, 1),
    duration_api_ms: Math.max(Date.now() - started - 50, 1),
    num_turns: turns + 1,
    result: hitLimit ? "" : p.text,
    session_id: session.id,
    total_cost_usd: Math.round(p.costUsd * scale * 10000) / 10000,
    usage: { input_tokens: Math.round(p.usage.input * scale), cache_creation_input_tokens: 0, cache_read_input_tokens: Math.round(p.usage.cacheRead * scale), output_tokens: Math.round(p.usage.output * scale) },
    permission_denials: [],
    ...(hitLimit || p.output == null ? {} : { structured_output: p.output }),
  });
  return 0;
}

// ---------- codex ----------

const CODEX_VERSION = "codex-cli 0.58.0";

/** OpenAI strict schemas list every property as required; fill the ones our output leaves out with null. */
export function fillNulls(value: unknown, schema: any): unknown {
  if (Array.isArray(value)) return value.map((v) => fillNulls(v, schema?.items));
  if (!value || typeof value !== "object" || !schema?.properties) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [k, s] of Object.entries<any>(schema.properties)) out[k] = k in out ? fillNulls(out[k], s) : null;
  return out;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function codexCommand(step: Extract<Step, { kind: "tool" }>, cwd: string): string {
  const rel = (p: unknown) => String(p ?? "").replace(`${cwd.replace(/\/$/, "")}/`, "");
  const cmd =
    step.tool === "Read"
      ? `sed -n '1,200p' ${rel(step.input.file_path)}`
      : step.tool === "Grep"
        ? `rg -n ${shellQuote(String(step.input.pattern))} ${rel(step.input.path) || "."}`
        : step.tool === "Glob"
          ? `rg --files -g ${shellQuote(String(step.input.pattern))}`
          : String(step.input.command);
  return `/bin/zsh -lc ${shellQuote(cmd)}`;
}

export async function codexMain(args: string[]): Promise<number> {
  if (args[0] === "--version" || args[0] === "-V") {
    console.log(CODEX_VERSION);
    return 0;
  }
  if (args[0] === "login" && args[1] === "status") {
    process.stderr.write("Logged in using ChatGPT\n");
    return 0;
  }
  if (args[0] !== "exec" || !args.includes("--json")) {
    process.stderr.write(`mock codex: unsupported: codex ${args.join(" ")}\n`);
    return 1;
  }
  const schemaFile = argValue(args, "--output-schema");
  const schema = schemaFile ? JSON.parse(readFileSync(schemaFile, "utf8")) : null;
  const cwd = argValue(args, "-C") ?? process.cwd();
  const resumeAt = args.indexOf("resume");
  const resume = resumeAt >= 0 ? (args[resumeAt + 1] ?? null) : null;
  const prompt = await readStdin();
  const { session, stage, target } = resolveJob({ prompt, schema, cwd, resume, fork: false });
  const p = plan(stage, target, cwd, prompt, schema, session);
  let current: Session = session;
  exitOnSignals(() => saveSession(current));
  saveSession(session);

  write({ type: "thread.started", thread_id: session.id });
  write({ type: "turn.started" });
  const key = `${session.id}:${stage}`;
  let item = 0;
  for (let i = session.step; i < p.steps.length; i++) {
    await Bun.sleep(stepDelay(p, i, key));
    const step = p.steps[i]!;
    if (step.kind === "tool") {
      const command = codexCommand(step, cwd);
      write({ type: "item.started", item: { id: `item_${item}`, type: "command_execution", command, aggregated_output: "", status: "in_progress" } });
      write({ type: "item.completed", item: { id: `item_${item++}`, type: "command_execution", command, aggregated_output: step.result, exit_code: 0, status: "completed" } });
    } else {
      write({ type: "item.completed", item: { id: `item_${item++}`, type: "reasoning", text: `**${step.text}**` } });
    }
    current = { ...current, step: i + 1 };
    saveSession(current);
  }
  await Bun.sleep(stepDelay(p, p.steps.length, key));
  const text = schema ? JSON.stringify(fillNulls(p.output, schema)) : p.text;
  write({ type: "item.completed", item: { id: `item_${item}`, type: "agent_message", text } });
  write({ type: "turn.completed", usage: { input_tokens: p.usage.input, cached_input_tokens: p.usage.cacheRead, output_tokens: p.usage.output } });
  saveSession({ ...current, done: true });
  return 0;
}
