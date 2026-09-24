// The login service: launchd user agents that keep PR Bunny running (and, if HTTPS is on, Caddy
// serving https://prbunny.localhost in front of it). `bunny service install|uninstall|restart|status`.
import { $ } from "bun";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { COMPILED } from "../build-info";
import { APP_LABEL, CADDY_LABEL, DATA_DIR, DOMAIN, LOG_DIR, PORT, publicUrl, serviceConfig } from "../server/config";
import caddyfile from "../../Caddyfile" with { type: "text" };

const ROOT = resolve(import.meta.dir, "..", ".."); // the repo, when running from source
const HOME = homedir();
const AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const UID = process.getuid!();

export { APP_LABEL, CADDY_LABEL };
const LABELS = [APP_LABEL, CADDY_LABEL];
/** Agents from before the renames (review-desk, review.pr); install and uninstall remove them. */
export const LEGACY_LABELS = ["pr.review.app", "pr.review.caddy", "com.review-desk.app", "com.review-desk.caddy"];

// launchd starts agents with a bare PATH; the app shells out to gh, git, claude and codex.
export const PATH = [
  join(HOME, ".local", "bin"),
  join(HOME, ".bun", "bin"),
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");

interface Agent {
  label: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  log: string;
}

function agents(): Agent[] {
  const env = { PATH, HOME, PORT: String(PORT), PR_BUNNY_HOME: DATA_DIR, PR_BUNNY_DOMAIN: DOMAIN };
  const bun = Bun.which("bun", { PATH }) ?? process.execPath;
  const list: Agent[] = [
    {
      label: APP_LABEL,
      // The compiled binary is the whole app; from source, run the server with bun.
      args: COMPILED ? [process.execPath, "serve"] : [bun, join(ROOT, "src", "server", "index.ts")],
      cwd: COMPILED ? DATA_DIR : ROOT,
      env: { ...env, NODE_ENV: "production" },
      log: join(LOG_DIR, "app.log"),
    },
  ];
  if (!serviceConfig().https) return list;
  const caddy = Bun.which("caddy", { PATH });
  if (!caddy) {
    console.warn("⚠ HTTPS is on but caddy isn't installed; skipping the proxy. `brew install caddy`, then `bunny setup`.");
    return list;
  }
  list.push({
    label: CADDY_LABEL,
    args: [caddy, "run", "--config", join(DATA_DIR, "Caddyfile"), "--adapter", "caddyfile"],
    cwd: DATA_DIR,
    env,
    log: join(LOG_DIR, "caddy.log"),
  });
  return list;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plist(a: Agent): string {
  const args = a.args.map((x) => `    <string>${xml(x)}</string>`).join("\n");
  const env = Object.entries(a.env)
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${a.label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${xml(a.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(a.log)}</string>
  <key>StandardErrorPath</key><string>${xml(a.log)}</string>
</dict>
</plist>
`;
}

const plistPath = (label: string) => join(AGENTS_DIR, `${label}.plist`);

async function bootout(label: string) {
  await $`launchctl bootout gui/${UID}/${label}`.quiet().nothrow();
}

async function removeAgents(labels: string[]) {
  for (const label of labels) {
    await bootout(label);
    if (existsSync(plistPath(label))) {
      unlinkSync(plistPath(label));
      console.log(`✓ removed ${label}`);
    }
  }
}

export async function install() {
  mkdirSync(AGENTS_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  // Agents from older installs hold port 4477 and 443; they have to go first.
  await removeAgents(LEGACY_LABELS);
  const list = agents();
  // HTTPS turned off (or Caddy missing): don't leave an old proxy agent running.
  if (!list.some((a) => a.label === CADDY_LABEL)) await removeAgents([CADDY_LABEL]);
  // The Caddyfile ships inside bunny; write it where the Caddy agent reads it.
  await Bun.write(join(DATA_DIR, "Caddyfile"), caddyfile);
  for (const a of list) {
    await bootout(a.label);
    await Bun.write(plistPath(a.label), plist(a));
    const res = await $`launchctl bootstrap gui/${UID} ${plistPath(a.label)}`.quiet().nothrow();
    if (res.exitCode !== 0) throw new Error(`launchctl bootstrap ${a.label} failed: ${res.stderr.toString().trim()}`);
    console.log(`✓ ${a.label} installed and started (logs: ${a.log})`);
  }
  console.log(`\nOpen ${publicUrl()}`);
}

export async function uninstall() {
  await removeAgents([...LABELS, ...LEGACY_LABELS]);
}

export async function restart() {
  for (const label of LABELS) {
    if (!existsSync(plistPath(label))) continue;
    await $`launchctl kickstart -k gui/${UID}/${label}`.quiet().nothrow();
    console.log(`↻ ${label}`);
  }
}

export async function status() {
  for (const label of LABELS) {
    const res = await $`launchctl print gui/${UID}/${label}`.quiet().nothrow();
    if (res.exitCode !== 0) {
      console.log(`${label}: not installed`);
      continue;
    }
    const out = res.stdout.toString();
    const state = out.match(/state = (\w+)/)?.[1] ?? "?";
    const pid = out.match(/pid = (\d+)/)?.[1];
    const exit = out.match(/last exit code = (.+)/)?.[1];
    console.log(`${label}: ${state}${pid ? ` (pid ${pid})` : ""}${exit ? ` · last exit ${exit}` : ""}`);
  }
}

