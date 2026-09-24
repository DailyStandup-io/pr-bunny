// `bunny setup`: one-shot, idempotent setup for PR Bunny on macOS. Safe to re-run: each step checks first.
//   bunny setup              interactive: asks before installing or using sudo
//   bunny setup --yes        don't ask (sudo will still prompt for your password)
//   bunny setup --check      report what's done and what's missing; change nothing
//   bunny setup --https      also serve at https://prbunny.localhost (Caddy + sudo once); --no-https turns it off
//
// Set PR_BUNNY_DOMAIN to use a hostname other than prbunny.localhost.
import { $ } from "bun";
import { COMPILED } from "../build-info";
import { CLI_LINK, CLI_NAME, CLI_TARGET, cliInfo, linkCli, removeLegacyLinks } from "../server/cli";
import { DATA_DIR, DOMAIN, PORT, publicUrl, saveServiceConfig, serviceConfig } from "../server/config";
import { APP_LABEL, CADDY_LABEL, LEGACY_LABELS, PATH, install as installService } from "./service";

const ADMIN = "localhost:2020"; // matches the Caddyfile's admin address
const CA_NAME = "Caddy Local Authority";
const c = { dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", bold: "\x1b[1m", reset: "\x1b[0m" };

export async function setup(argv: string[]) {
  const args = new Set(argv);
  const CHECK = args.has("--check");
  const YES = args.has("--yes") || args.has("-y");
  // The user's own PATH, for "is bunny on your PATH"; the rest runs with launchd's PATH.
  const userPath = process.env.PATH ?? "";
  process.env.PATH = PATH;

  const ok = (m: string) => console.log(`${c.green}✓${c.reset} ${m}`);
  const todo = (m: string) => console.log(`${c.yellow}○${c.reset} ${m}`);
  const bad = (m: string) => console.log(`${c.red}✗${c.reset} ${m}`);
  const step = (m: string) => console.log(`\n${c.bold}${m}${c.reset}`);
  let missing = 0;

  async function confirm(q: string, yes = true): Promise<boolean> {
    if (YES) return yes;
    process.stdout.write(`  ${q} ${yes ? "[Y/n]" : "[y/N]"} `);
    for await (const line of console) return line.trim() ? /^y/i.test(line.trim()) : yes;
    return false;
  }

  /** Runs a command attached to the terminal (so sudo can prompt). */
  async function interactive(cmd: string[]): Promise<boolean> {
    console.log(`  ${c.dim}$ ${cmd.join(" ")}${c.reset}`);
    const p = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] });
    return (await p.exited) === 0;
  }

  const has = (bin: string) => Bun.which(bin) != null;
  const quiet = async (s: ReturnType<typeof $>) => (await s.quiet().nothrow()).exitCode === 0;

  /** A step: `done()` checks state, `fix()` makes it so. In --check mode only `done()` runs. */
  async function ensure(label: string, done: () => Promise<boolean>, fix?: () => Promise<boolean>, hint?: string) {
    if (await done()) return ok(label);
    if (CHECK || !fix) {
      missing++;
      return todo(`${label}${hint ? `  ${c.dim}→ ${hint}${c.reset}` : ""}`);
    }
    if ((await fix()) && (await done())) return ok(label);
    missing++;
    bad(`${label}${hint ? `  ${c.dim}→ ${hint}${c.reset}` : ""}`);
  }

  // -------------------------------------------------------------------------

  step("Prerequisites");
  if (process.platform !== "darwin") {
    bad("PR Bunny's service setup is macOS-only (launchd + Keychain).");
    process.exit(1);
  }
  const brewHint = has("brew") ? undefined : "needs Homebrew: https://brew.sh";
  await ensure("git", async () => has("git"), undefined, "xcode-select --install");
  await ensure(
    "GitHub CLI (gh)",
    async () => has("gh"),
    async () => has("brew") && (await confirm("Install gh with Homebrew?")) && interactive(["brew", "install", "gh"]),
    brewHint ?? "brew install gh",
  );
  await ensure(
    "gh is logged in",
    async () => has("gh") && quiet($`gh auth status`),
    async () => has("gh") && (await confirm("Run `gh auth login` now?")) && interactive(["gh", "auth", "login"]),
    "gh auth login",
  );
  await ensure(
    "a coding agent: Claude Code (claude) or Codex (codex)",
    async () => has("claude") || has("codex"),
    undefined,
    "curl -fsSL https://claude.ai/install.sh | bash, or brew install codex",
  );
  if (process.env.ANTHROPIC_API_KEY) {
    console.log(`  ${c.yellow}note${c.reset} ANTHROPIC_API_KEY is set in this shell. PR Bunny strips it so runs use your subscription login.`);
  }
  console.log(`  ${c.dim}Sign-in is checked in the app's setup page: \`claude\` then /login, or \`codex login\`.${c.reset}`);

  if (!COMPILED) {
    step("Dependencies");
    await ensure("node_modules installed", async () => Bun.file("node_modules/.bin/tsc").exists(), async () => interactive(["bun", "install"]));
  }

  // HTTPS is optional: http://127.0.0.1:4477 works with no Caddy and no sudo.
  step("Address");
  let https = serviceConfig().https;
  if (args.has("--https")) https = true;
  else if (args.has("--no-https")) https = false;
  else if (!CHECK) {
    console.log(`  ${c.dim}PR Bunny runs at http://127.0.0.1:${PORT}. Optionally it can also be https://${DOMAIN},${c.reset}`);
    console.log(`  ${c.dim}which installs Caddy and needs sudo once (a hosts entry and a trusted local certificate).${c.reset}`);
    https = await confirm(`Serve at https://${DOMAIN}?`, https);
  }
  if (!CHECK) saveServiceConfig({ https });
  ok(https ? `https://${DOMAIN}` : `http://127.0.0.1:${PORT} (run \`bunny setup --https\` for https://${DOMAIN})`);

  const brewCaddyActive = async () => {
    const out = (await $`brew services info caddy --json`.quiet().nothrow()).stdout.toString();
    try {
      const [info] = JSON.parse(out);
      return Boolean(info?.running || info?.loaded);
    } catch {
      return false;
    }
  };
  if (https) {
    step(`HTTPS: ${DOMAIN}`);
    await ensure(
      "Caddy",
      async () => has("caddy"),
      async () => has("brew") && (await confirm("Install Caddy with Homebrew?")) && interactive(["brew", "install", "caddy"]),
      brewHint ?? "brew install caddy",
    );
    const hostsHas = async () => (await Bun.file("/etc/hosts").text()).split("\n").some((l) => l.trim().split(/\s+/).includes(DOMAIN) && !l.trim().startsWith("#"));
    await ensure(
      `/etc/hosts maps ${DOMAIN} to 127.0.0.1`,
      hostsHas,
      async () =>
        (await confirm(`Add "127.0.0.1 ${DOMAIN}" to /etc/hosts? (sudo)`)) &&
        interactive(["sudo", "sh", "-c", `printf '\\n127.0.0.1 ${DOMAIN}\\n' >> /etc/hosts`]),
      `echo "127.0.0.1 ${DOMAIN}" | sudo tee -a /etc/hosts`,
    );
    await ensure(
      "Homebrew's own Caddy service is off (it would fight over port 443)",
      async () => !has("caddy") || !(await brewCaddyActive()),
      async () => (await confirm("Stop `brew services` caddy?")) && interactive(["brew", "services", "stop", "caddy"]),
      "brew services stop caddy",
    );
  }

  step("Login service");
  const agentRunning = async (label: string) =>
    /state = running/.test((await $`launchctl print gui/${process.getuid!()}/${label}`.quiet().nothrow()).stdout.toString());
  const portHolder = async () => (await $`lsof -tiTCP:${PORT} -sTCP:LISTEN`.quiet().nothrow()).stdout.toString().trim();
  const wantCaddy = https && has("caddy");
  await ensure(
    wantCaddy ? "app + Caddy launchd agents running" : "app launchd agent running",
    async () => (await agentRunning(APP_LABEL)) && wantCaddy === (await agentRunning(CADDY_LABEL)),
    async () => {
      const pid = await portHolder();
      if (pid && !(await agentRunning(APP_LABEL)) && !(await Promise.all(LEGACY_LABELS.map(agentRunning))).some(Boolean)) {
        console.log(`  ${c.yellow}note${c.reset} port ${PORT} is held by pid ${pid} (a dev server?). Stop it, or the app agent can't start.`);
      }
      if (!(await confirm("Install and start the login service?"))) return false;
      await installService();
      await Bun.sleep(3000);
      return true;
    },
    "bunny service install",
  );

  step("Terminal command");
  removeLegacyLinks(CHECK);
  const cliOnPath = () => Bun.which(CLI_NAME, { PATH: userPath }) != null;
  await ensure(
    `\`${CLI_NAME}\` command (${CLI_NAME} review, from any checkout)`,
    async () => cliInfo().linked,
    async () => {
      const { conflict } = cliInfo();
      if (!(await confirm(`Link ${CLI_LINK.replace(process.env.HOME ?? "", "~")} → ${CLI_TARGET.replace(process.env.HOME ?? "", "~")}?`))) return false;
      if (conflict && !(await confirm(`Something else is there (${conflict}). Replace it?`, false))) return false;
      linkCli({ replace: true });
      return true;
    },
    `ln -s ${CLI_TARGET} ${CLI_LINK}`,
  );
  if (cliInfo().linked && !cliOnPath()) {
    console.log(`  ${c.yellow}note${c.reset} ${CLI_LINK.replace(/\/[^/]+$/, "")} isn't on your PATH. Add it in ~/.zshrc: export PATH="$HOME/.local/bin:$PATH"`);
  }

  if (https) {
    step("Certificate");
    const caTrusted = async () => quiet($`security find-certificate -c ${CA_NAME} /Library/Keychains/System.keychain`);
    await ensure(
      "Caddy's local CA is trusted by macOS",
      caTrusted,
      async () => {
        if (!has("caddy")) return false;
        // Caddy creates its CA on first run of a `tls internal` site; wait for its admin API.
        for (let i = 0; i < 20 && !(await quiet($`curl -sf http://${ADMIN}/pki/ca/local`)); i++) await Bun.sleep(500);
        return (await confirm("Trust Caddy's local CA? (sudo, adds it to the System keychain)")) && interactive(["sudo", "caddy", "trust", "--address", ADMIN]);
      },
      `sudo caddy trust --address ${ADMIN}`,
    );
  }

  step("Health check");
  const url = publicUrl();
  await ensure(
    `${url} responds${https ? " with a trusted certificate" : ""}`,
    async () => {
      for (let i = 0; i < (CHECK ? 1 : 10); i++) {
        if (await quiet($`curl -sf --max-time 3 -o /dev/null ${url}/api/health`)) return true;
        if (!CHECK) await Bun.sleep(1000);
      }
      return false;
    },
    undefined,
    `see ${DATA_DIR.replace(process.env.HOME ?? "", "~")}/logs/app.log${https ? " and caddy.log" : ""}`,
  );

  if (missing) {
    console.log(`\n${c.yellow}${missing} step(s) outstanding.${CHECK ? " Run `bunny setup` to fix them." : ""}${c.reset}`);
    process.exit(1);
  }
  // The rest (agent, repos, review skills) happens in the browser, on first launch.
  const onboarded = await fetch(`http://127.0.0.1:${PORT}/api/setup`).then((r) => r.json()).then((s: any) => Boolean(s.completedAt), () => true);
  const open = onboarded ? url : `${url}/setup`;
  console.log(`\n${c.green}All set →${c.reset} ${c.bold}${open}${c.reset}${onboarded ? "" : `  ${c.dim}(finish setup in the browser)${c.reset}`}`);
  if (!CHECK && !YES) Bun.spawn(["open", open], { stdout: "ignore", stderr: "ignore" });
}
