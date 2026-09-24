// bunny: PR Bunny's one command. The compiled binary is the whole app (server + UI); from source
// it's `bun bin/bunny.ts`.
import { VERSION } from "../build-info";

const USAGE = `bunny ${VERSION} — review GitHub PRs with your local coding agent

usage:
  bunny setup [--check] [--yes] [--https | --no-https]
                          set up this Mac: checks, login service, optional https://prbunny.localhost
  bunny open               open PR Bunny in your browser
  bunny review [branch] [--base <b>] [--committed] [--pr <n>] [--rerun] [--no-open]
                          self-review your work (run inside a checkout)
  bunny service install|uninstall|restart|status
                          manage the login service that keeps PR Bunny running
  bunny serve              run the server in this terminal
  bunny version`;

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "review":
    await (await import("./review")).review(rest);
    break;
  case "setup":
    await (await import("./setup")).setup(rest);
    break;
  case "service": {
    const service = await import("./service");
    const commands: Record<string, () => Promise<void>> = { install: service.install, uninstall: service.uninstall, restart: service.restart, status: service.status };
    const run = commands[rest[0] ?? ""];
    if (!run) fail("usage: bunny service install|uninstall|restart|status");
    await run();
    break;
  }
  case "serve":
    await import("../server/index");
    break;
  case "open": {
    const { health } = await import("./review");
    const { url } = await health();
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    console.log(url);
    break;
  }
  case "version":
  case "--version":
  case "-v":
    console.log(VERSION);
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  default:
    fail(`unknown command "${cmd}".\n\n${USAGE}`);
}

function fail(msg: string): never {
  console.error(`bunny: ${msg}`);
  process.exit(1);
}
