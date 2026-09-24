#!/usr/bin/env bun
// Generates the modules that depend on what's on this machine and never get committed:
//   packages/brand: the licensed bunny art, if present (--require: fail without it)
//   packages/icons: Hugeicons Pro if installed locally (bun run icons:pro), else free
// Runs on `bun install` and before every dev, typecheck and build.
import { join } from "node:path";

const run = (script: string, args: string[] = []) => {
  const res = Bun.spawnSync(["bun", join(import.meta.dir, "..", script), ...args], { stdio: ["ignore", "inherit", "inherit"] });
  if (res.exitCode !== 0) process.exit(res.exitCode ?? 1);
};
run("packages/brand/scripts/generate.ts", process.argv.includes("--require") ? ["--require"] : []);
run("packages/icons/scripts/generate.ts");
