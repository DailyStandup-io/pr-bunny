#!/usr/bin/env bun
// Hugeicons Pro, locally. The public repo builds with the free icons; this installs Pro into the
// gitignored pro/ folder (its own package.json and .npmrc, so the root package.json, bun.lock and
// your token never change or get committed) and regenerates the icon module to use it.
//
//   bun run icons:pro            install Pro (needs HUGEICONS_TOKEN) and switch to it
//   bun run icons:pro remove     back to the free icons
//   bun run icons:pro status
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PRO_PACKAGE } from "./generate";

const ROOT = resolve(import.meta.dir, "..");
const PRO = join(ROOT, "pro");
const installed = () => existsSync(join(PRO, "node_modules", ...PRO_PACKAGE.split("/")));
const regenerate = () => Bun.spawnSync(["bun", join(import.meta.dir, "generate.ts")], { stdio: ["ignore", "inherit", "inherit"] });

const cmd = process.argv[2] ?? "install";
if (cmd === "status") {
  console.log(installed() ? `Hugeicons Pro is installed (${PRO_PACKAGE}).` : "Using the free icons. `bun run icons:pro` installs Pro.");
} else if (cmd === "remove") {
  rmSync(PRO, { recursive: true, force: true });
  regenerate();
} else if (cmd === "install") {
  if (!process.env.HUGEICONS_TOKEN) {
    console.error("✗ HUGEICONS_TOKEN isn't set. Export your Hugeicons Pro token, then run this again.");
    process.exit(1);
  }
  mkdirSync(PRO, { recursive: true });
  writeFileSync(join(PRO, "package.json"), `${JSON.stringify({ name: "pr-bunny-icons-pro", private: true, dependencies: { [PRO_PACKAGE]: "^4" } }, null, 2)}\n`);
  // The token stays an env reference; bun expands it at install time.
  writeFileSync(join(PRO, ".npmrc"), "@hugeicons-pro:registry=https://npm.hugeicons.com/\n//npm.hugeicons.com/:_authToken=${HUGEICONS_TOKEN}\n");
  writeFileSync(join(PRO, "bunfig.toml"), '[install]\nlinker = "hoisted"\n');
  const res = Bun.spawnSync(["bun", "install", "--no-save"], { cwd: PRO, stdio: ["ignore", "inherit", "inherit"] });
  if (res.exitCode !== 0 || !installed()) {
    console.error("✗ Installing Hugeicons Pro failed (is the token valid?).");
    process.exit(1);
  }
  regenerate();
} else {
  console.error("usage: bun run icons:pro [install|remove|status]");
  process.exit(1);
}
