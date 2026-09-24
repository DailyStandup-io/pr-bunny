#!/usr/bin/env bun
// Generates the modules that depend on what's on this machine and never get committed:
//   packages/brand: the licensed bunny art, if present (--require: fail without it). With
//                   PR_BUNNY_ART_TOKEN set (Vercel, CI) and no art here yet, it's fetched first
//                   from the private art repo (packages/brand/scripts/fetch-art.ts).
//   packages/icons: Hugeicons Pro if installed locally (bun run icons:pro), else free. On CI and
//                   Vercel, HUGEICONS_TOKEN installs Pro first (locally that stays opt-in).
// Runs on `bun install` and before every dev, typecheck and build.
import { join } from "node:path";

const run = (script: string, args: string[] = []) => {
  const res = Bun.spawnSync(["bun", join(import.meta.dir, "..", script), ...args], { stdio: ["ignore", "inherit", "inherit"] });
  if (res.exitCode !== 0) process.exit(res.exitCode ?? 1);
};
if (process.env.PR_BUNNY_ART_TOKEN) {
  const { fetchArt, hasArt } = await import("../packages/brand/scripts/fetch-art");
  if (!hasArt()) {
    await fetchArt().then(
      () => console.log("✓ bunny art fetched from the private art repo"),
      (e) => console.error(`✗ Couldn't fetch the bunny art: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}
run("packages/brand/scripts/generate.ts", process.argv.includes("--require") ? ["--require"] : []);
const ci = Boolean(process.env.CI || process.env.VERCEL);
const proInstalled = (await import("node:fs")).existsSync(join(import.meta.dir, "..", "packages/icons/pro/node_modules/@hugeicons-pro"));
if (ci && process.env.HUGEICONS_TOKEN && !proInstalled && process.env.PR_BUNNY_ICONS !== "free") {
  run("packages/icons/scripts/pro.ts", ["install"]); // also regenerates the icon module
} else {
  run("packages/icons/scripts/generate.ts");
}
