// `bunny setup`: one-shot, idempotent setup for PR Bunny on macOS. Safe to re-run: each step checks first.
//   bunny setup              interactive: asks before installing or using sudo
//   bunny setup --yes        don't ask (sudo will still prompt for your password)
//   bunny setup --check      report what's done and what's missing; change nothing
//   bunny setup --https      also serve at https://prbunny.localhost (Caddy + sudo once); --no-https turns it off
//
// Set PR_BUNNY_DOMAIN to use a hostname other than prbunny.localhost.
import { $ } from "bun";
import { COMPILED, CODENAME, VERSION } from "../build-info";
import { CLI_LINK, CLI_NAME, CLI_TARGET, cliInfo, linkCli, removeLegacyLinks } from "../server/cli";
import { DATA_DIR, DOMAIN, PORT, publicUrl, saveServiceConfig, serviceConfig } from "../server/config";
import { APP_LABEL, CADDY_LABEL, LEGACY_LABELS, PATH, install as installService } from "./service";
import { ask as askTty, c, detail, header, icons, interactive, line, note, section, spinner, sudoUpfront, task } from "./ui";

const ADMIN = "localhost:2020"; // matches the Caddyfile's admin address
const CA_NAME = "Caddy Local Authority";
/** Homebrew installs without first updating itself: that can sit silently for minutes and looks frozen. */
const BREW_ENV = { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1" };
const tilde = (p: string) => p.replace(process.env.HOME ?? "", "~");

export async function setup(argv: string[]) {
  const args = new Set(argv);
  const CHECK = args.has("--check");
  const YES = args.has("--yes") || args.has("-y");
  // The user's own PATH, for "is bunny on your PATH"; the rest runs with launchd's PATH.
  const userPath = process.env.PATH ?? "";
  process.env.PATH = PATH;
  let missing = 0;

  const ask = (q: string, yes = true) => (YES ? yes : askTty(q, yes));
  const has = (bin: string) => Bun.which(bin) != null;
  const quiet = async (s: ReturnType<typeof $>) => (await s.quiet().nothrow()).exitCode === 0;
  const brew = (label: string, ...pkg: string[]) => task(label, ["brew", "install", ...pkg], BREW_ENV);

  /**
   * A step: `done()` checks state (under a spinner), `fix()` makes it so, then it's checked again.
   * In --check mode only `done()` runs.
   */
  async function ensure(label: string, done: () => Promise<boolean>, fix?: () => Promise<boolean>, hint?: string) {
    const spin = spinner(label);
    if (await done()) return spin.ok();
    if (CHECK || !fix) {
      missing++;
      return spin.todo(label, hint);
    }
    spin.stop(); // the fix may ask questions or run its own spinner
    const fixed = await fix();
    const again = spinner(label);
    if (fixed && (await done())) return again.ok();
    missing++;
    again.fail(label, hint);
  }

  // -------------------------------------------------------------------------

  header("PR Bunny setup", COMPILED ? `${VERSION} “${CODENAME}”` : "from source");
  if (CHECK) detail("Checking only: nothing will be changed.");

  section("Prerequisites");
  if (process.platform !== "darwin") {
    line(icons.bad, "PR Bunny's service setup is macOS-only (launchd + Keychain).");
    process.exit(1);
  }
  const brewHint = has("brew") ? undefined : "needs Homebrew: https://brew.sh";
  await ensure("git", async () => has("git"), undefined, "xcode-select --install");
  await ensure(
    "GitHub CLI (gh)",
    async () => has("gh"),
    async () => has("brew") && ask("Install the GitHub CLI with Homebrew?") && brew("Installing gh", "gh"),
    brewHint ?? "brew install gh",
  );
  await ensure(
    "gh is logged in",
    async () => has("gh") && quiet($`gh auth status`),
    async () => has("gh") && ask("Log in to GitHub now? (gh auth login)") && interactive(["gh", "auth", "login"]),
    "gh auth login",
  );
  await ensure(
    "A coding agent: Claude Code or Codex",
    async () => has("claude") || has("codex"),
    undefined,
    "curl -fsSL https://claude.ai/install.sh | bash, or brew install codex",
  );
  if (process.env.ANTHROPIC_API_KEY) note("ANTHROPIC_API_KEY is set in this shell. PR Bunny ignores it, so runs use your subscription.");
  detail("Agent sign-in is checked in the browser setup: `claude` then /login, or `codex login`.");

  if (!COMPILED) {
    section("Dependencies");
    await ensure(
      "node_modules installed",
      async () => Bun.file("node_modules/.bin/tsc").exists(),
      async () => task("bun install", ["bun", "install"]),
    );
  }

  // HTTPS is optional: http://127.0.0.1:4477 works with no Caddy and no sudo.
  section("Address");
  let https = serviceConfig().https;
  if (args.has("--https")) https = true;
  else if (args.has("--no-https")) https = false;
  else if (!CHECK) {
    detail(`PR Bunny runs at http://127.0.0.1:${PORT}. It can also be https://${DOMAIN},`);
    detail("which installs Caddy and needs sudo once (a hosts entry and a trusted local certificate).");
    https = ask(`Serve at https://${DOMAIN} too?`, https);
  }
  if (!CHECK) saveServiceConfig({ https });
  line(icons.ok, https ? `https://${DOMAIN}` : `http://127.0.0.1:${PORT}`, https ? undefined : `bunny setup --https for https://${DOMAIN}`);

  const brewCaddyActive = async () => {
    const out = (await $`brew services info caddy --json`.env({ ...process.env, ...BREW_ENV }).quiet().nothrow()).stdout.toString();
    try {
      const [info] = JSON.parse(out);
      return Boolean(info?.running || info?.loaded);
    } catch {
      return false;
    }
  };
  if (https) {
    section(`HTTPS: ${DOMAIN}`);
    await ensure(
      "Caddy",
      async () => has("caddy"),
      async () => has("brew") && ask("Install Caddy with Homebrew?") && brew("Installing Caddy", "caddy"),
      brewHint ?? "brew install caddy",
    );
    const hostsHas = async () => (await Bun.file("/etc/hosts").text()).split("\n").some((l) => l.trim().split(/\s+/).includes(DOMAIN) && !l.trim().startsWith("#"));
    await ensure(
      `/etc/hosts maps ${DOMAIN} to 127.0.0.1`,
      hostsHas,
      async () =>
        ask(`Add "127.0.0.1 ${DOMAIN}" to /etc/hosts?`) &&
        (await sudoUpfront("Editing /etc/hosts")) &&
        task("Updating /etc/hosts", ["sudo", "-n", "sh", "-c", `printf '\\n127.0.0.1 ${DOMAIN}\\n' >> /etc/hosts`]),
      `echo "127.0.0.1 ${DOMAIN}" | sudo tee -a /etc/hosts`,
    );
    await ensure(
      "Homebrew's own Caddy service is off (it would clash over port 443)",
      async () => !has("caddy") || !(await brewCaddyActive()),
      async () => ask("Stop Homebrew's Caddy service?") && task("Stopping brew services caddy", ["brew", "services", "stop", "caddy"], BREW_ENV),
      "brew services stop caddy",
    );
  }

  section("Login service");
  const agentRunning = async (label: string) =>
    /state = running/.test((await $`launchctl print gui/${process.getuid!()}/${label}`.quiet().nothrow()).stdout.toString());
  const portHolder = async () => (await $`lsof -tiTCP:${PORT} -sTCP:LISTEN`.quiet().nothrow()).stdout.toString().trim();
  const wantCaddy = https && has("caddy");
  await ensure(
    wantCaddy ? "PR Bunny and Caddy start at login" : "PR Bunny starts at login",
    async () => (await agentRunning(APP_LABEL)) && wantCaddy === (await agentRunning(CADDY_LABEL)),
    async () => {
      const pid = await portHolder();
      if (pid && !(await agentRunning(APP_LABEL)) && !(await Promise.all(LEGACY_LABELS.map(agentRunning))).some(Boolean)) {
        note(`Port ${PORT} is in use by pid ${pid} (a dev server?). Stop it, or PR Bunny can't start.`);
      }
      if (!ask("Install and start the login service?")) return false;
      const spin = spinner("Starting PR Bunny");
      const log: string[] = [];
      const orig = console.log;
      console.log = (...a: unknown[]) => void log.push(a.join(" ")); // service.ts reports per agent; keep the spinner tidy
      try {
        await installService();
      } catch (e) {
        console.log = orig;
        spin.fail("Starting PR Bunny", e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        console.log = orig;
      }
      // Wait for it to answer rather than a fixed sleep.
      for (let i = 0; i < 20 && !(await quiet($`curl -sf --max-time 1 -o /dev/null http://127.0.0.1:${PORT}/api/health`)); i++) await Bun.sleep(500);
      spin.stop();
      return true;
    },
    "bunny service install",
  );

  section("Terminal command");
  removeLegacyLinks(CHECK);
  const cliOnPath = () => Bun.which(CLI_NAME, { PATH: userPath }) != null;
  await ensure(
    `\`${CLI_NAME}\` command`,
    async () => cliInfo().linked,
    async () => {
      const { conflict } = cliInfo();
      if (!ask(`Link ${tilde(CLI_LINK)} so \`${CLI_NAME} review\` works from any checkout?`)) return false;
      if (conflict && !ask(`Something else is there (${conflict}). Replace it?`, false)) return false;
      linkCli({ replace: true });
      return true;
    },
    `ln -s ${CLI_TARGET} ${CLI_LINK}`,
  );
  if (cliInfo().linked && !cliOnPath()) {
    note(`${tilde(CLI_LINK.replace(/\/[^/]+$/, ""))} isn't on your PATH. Add to ~/.zshrc: ${c.cyan('export PATH="$HOME/.local/bin:$PATH"')}`);
  }

  if (https) {
    section("Certificate");
    const caTrusted = async () => quiet($`security find-certificate -c ${CA_NAME} /Library/Keychains/System.keychain`);
    await ensure(
      "Caddy's local certificate is trusted by macOS",
      caTrusted,
      async () => {
        if (!has("caddy")) return false;
        if (!ask("Trust Caddy's local certificate? (adds it to the System keychain)")) return false;
        // Caddy creates its CA on the first run of a `tls internal` site; wait for its admin API.
        const wait = spinner("Waiting for Caddy");
        for (let i = 0; i < 20 && !(await quiet($`curl -sf http://${ADMIN}/pki/ca/local`)); i++) await Bun.sleep(500);
        wait.stop();
        // macOS may show its own password or Touch ID dialog here, so this one stays attached to the terminal.
        return (await sudoUpfront("Trusting the certificate")) && interactive(["sudo", "caddy", "trust", "--address", ADMIN]);
      },
      `sudo caddy trust --address ${ADMIN}`,
    );
  }

  section("Health check");
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
    `see ${tilde(DATA_DIR)}/logs/app.log${https ? " and caddy.log" : ""}`,
  );

  if (missing) {
    console.log(`\n${c.yellow(`${missing} step${missing === 1 ? "" : "s"} outstanding.`)}${CHECK ? " Run `bunny setup` to fix them." : ""}`);
    process.exit(1);
  }
  // The rest (agent, repos, notifications, review skills) happens in the browser, on first launch.
  const onboarded = await fetch(`http://127.0.0.1:${PORT}/api/setup`).then((r) => r.json()).then((s: any) => Boolean(s.completedAt), () => true);
  const open = onboarded ? url : `${url}/setup`;
  console.log(`\n  ${c.rose("●")} ${c.bold("All set")} ${c.dim("→")} ${c.cyan(open)}${onboarded ? "" : c.dim("  (finish setup in the browser)")}\n`);
  if (!CHECK && !YES) Bun.spawn(["open", open], { stdout: "ignore", stderr: "ignore" });
}
