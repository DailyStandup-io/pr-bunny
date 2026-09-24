// Which coding agent runs reviews (Claude Code or Codex), and what's installed and signed in.
import { $ } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentInfo, Provider } from "../shared/types";
import { runClaude, subscriptionEnv, type ClaudeOptions, type ClaudeResult } from "./claude";
import { CODEX_SESSION, codexEnv, runCodex } from "./codex";
import { getSettings } from "./settings";

/**
 * Runs a step with the agent picked in Settings. A session from the other agent can't be resumed,
 * so that becomes a fresh run; Codex can't fork a session either, so a fork starts fresh too.
 */
export function runAgent<T = unknown>(o: ClaudeOptions): Promise<ClaudeResult<T>> {
  const provider = getSettings().provider;
  const isCodexSession = o.resume?.startsWith(CODEX_SESSION) ?? false;
  if (provider === "codex") {
    const resume = isCodexSession && !o.forkSession ? o.resume : undefined;
    return runCodex<T>({ ...o, resume, forkSession: false });
  }
  return runClaude<T>(isCodexSession ? { ...o, resume: undefined, forkSession: false } : o);
}

/** The display name for the agent in use, for progress lines and messages. */
export const agentName = (p: Provider = getSettings().provider) => (p === "codex" ? "Codex" : "Claude");

const PLAN: Record<string, string> = { prolite: "Pro Lite plan", max: "Max plan", pro: "Pro plan", team: "Team plan", enterprise: "Enterprise plan", plus: "Plus plan", free: "Free plan", business: "Business plan", edu: "Edu plan" };
const planName = (p: unknown) => (typeof p === "string" && p ? (PLAN[p.toLowerCase()] ?? `${p[0]!.toUpperCase()}${p.slice(1)} plan`) : null);
const tildify = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

async function claudeInfo(): Promise<AgentInfo> {
  const base: AgentInfo = { key: "claude", label: "Claude Code", installed: false, path: null, version: null, signedIn: false, account: null, plan: null, loginCmd: "claude /login", installCmd: "curl -fsSL https://claude.ai/install.sh | bash" };
  const bin = Bun.which("claude", { PATH: subscriptionEnv().PATH });
  if (!bin) return base;
  const env = subscriptionEnv();
  const [version, auth] = await Promise.all([
    $`${bin} --version`.env(env).quiet().nothrow(),
    $`${bin} auth status --json`.env(env).quiet().nothrow(),
  ]);
  let status: any = {};
  try {
    status = JSON.parse(auth.stdout.toString());
  } catch {}
  return {
    ...base,
    installed: true,
    path: tildify(bin),
    version: version.stdout.toString().trim().split(/\s+/)[0] || null,
    signedIn: Boolean(status.loggedIn),
    account: status.email ?? null,
    plan: planName(status.subscriptionType),
  };
}

/** Email and plan from the Codex sign-in's ID token, decoded locally. Nothing leaves the machine. */
async function codexAccount(): Promise<{ email: string | null; plan: string | null }> {
  try {
    const auth = await Bun.file(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")).json();
    const token: string | undefined = auth?.tokens?.id_token;
    if (!token) return { email: null, plan: null };
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    return { email: payload.email ?? null, plan: planName(payload["https://api.openai.com/auth"]?.chatgpt_plan_type) };
  } catch {
    return { email: null, plan: null };
  }
}

async function codexInfo(): Promise<AgentInfo> {
  const base: AgentInfo = { key: "codex", label: "Codex", installed: false, path: null, version: null, signedIn: false, account: null, plan: null, loginCmd: "codex login", installCmd: "brew install codex" };
  const env = codexEnv();
  const bin = Bun.which("codex", { PATH: env.PATH });
  if (!bin) return base;
  const [version, login, account] = await Promise.all([
    $`${bin} --version`.env(env).quiet().nothrow(),
    $`${bin} login status`.env(env).quiet().nothrow(),
    codexAccount(),
  ]);
  const said = `${login.stdout.toString()} ${login.stderr.toString()}`;
  // Only a ChatGPT sign-in counts: an API key would bill per token, which this tool avoids.
  const signedIn = login.exitCode === 0 && /chatgpt/i.test(said);
  return {
    ...base,
    installed: true,
    path: tildify(bin),
    version: version.stdout.toString().trim().match(/\d+\.\d+\.\d+\S*/)?.[0] ?? null,
    signedIn,
    account: account.email,
    plan: account.plan,
  };
}

export async function detectAgents(): Promise<AgentInfo[]> {
  return Promise.all([claudeInfo(), codexInfo()]);
}
