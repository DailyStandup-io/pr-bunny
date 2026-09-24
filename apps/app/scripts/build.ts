#!/usr/bin/env bun
// Builds the `bunny` release binaries: the whole app (server, UI, migrations, Caddyfile) compiled
// into one file per platform, laid out ready to upload as-is to https://prbunny.dev/releases/:
//
//   dist/latest                          the version number (what install.sh fetches first)
//   dist/latest.json                     { version, name, notesUrl, publishedAt } (what the app's updater reads)
//   dist/install.sh                      the installer (also served at https://prbunny.dev/install.sh)
//   dist/<version>/bunny-<os>-<arch>     binaries
//   dist/<version>/bunny-<os>-<arch>.sha256
//   dist/<version>/manifest.json         version + sha256 of every file
//
// Publishing = a GitHub Release for tag v<version> with all of these attached (flat); see the
// release skill. prbunny.dev/releases/* redirects there.
//
//   bun scripts/build.ts                 build every target, then smoke-test the native one
//   bun scripts/build.ts --target darwin-arm64
//   bun scripts/build.ts --check         only check install.sh knows every target; builds nothing
//
// PR_BUNNY_SIGN_IDENTITY="Developer ID Application: …" signs the binaries (needed to notarize).
// PR_BUNNY_NOTES_URL sets latest.json's release-notes link.
import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { GITHUB_REPO } from "../src/build-info";

const ROOT = resolve(import.meta.dir, "..");
const INSTALLER = join(ROOT, "scripts", "install.sh");

/** Release targets. Adding one here means install.sh must map `uname` to it (checked below). */
export const TARGETS = [
  { os: "darwin", arch: "arm64", bun: "bun-darwin-arm64" },
  { os: "darwin", arch: "x64", bun: "bun-darwin-x64" },
] as const;
const assetName = (t: (typeof TARGETS)[number]) => `bunny-${t.os}-${t.arch}`;

const args = process.argv.slice(2);
const only = args.includes("--target") ? args[args.indexOf("--target") + 1] : undefined;
const pkg = await Bun.file(join(ROOT, "package.json")).json();
const version: string = pkg.version;
const codename: string = pkg.codename ?? "";
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) fail(`package.json version "${version}" isn't semver`);
if (!codename) fail('package.json has no "codename" (each release has one: rabbit food, alphabetical)');

// ---------- install.sh contract ----------

/**
 * install.sh must build the same asset names and URL layout as this script. It declares what it
 * supports on a `# targets:` line; every target here must be listed there, and vice versa.
 */
async function checkInstaller(): Promise<string[]> {
  if (!existsSync(INSTALLER)) return ["scripts/install.sh is missing"];
  const text = await Bun.file(INSTALLER).text();
  const problems: string[] = [];
  const declared = text.match(/^# targets: (.+)$/m)?.[1]?.split(/[\s,]+/).filter(Boolean) ?? [];
  const built = TARGETS.map((t) => `${t.os}-${t.arch}`);
  for (const t of built) if (!declared.includes(t)) problems.push(`install.sh doesn't list target ${t} on its "# targets:" line (and may not map uname to it)`);
  for (const t of declared) if (!built.includes(t as never)) problems.push(`install.sh lists target ${t}, which the build doesn't produce`);
  if (!text.includes('bunny-${OS}-${ARCH}')) problems.push('install.sh no longer downloads "bunny-${OS}-${ARCH}"; asset names changed?');
  if (!text.includes('"$BASE/latest"')) problems.push('install.sh no longer reads "$BASE/latest" for the current version');
  if ((await $`sh -n ${INSTALLER}`.quiet().nothrow()).exitCode !== 0) problems.push("install.sh has a shell syntax error (sh -n)");
  return problems;
}

const problems = await checkInstaller();
if (problems.length) fail(`install.sh is out of date:\n  - ${problems.join("\n  - ")}`);
if (args.includes("--check")) {
  console.log(`✓ install.sh matches the build targets (${TARGETS.map(assetName).join(", ")}) · version ${version}`);
  process.exit(0);
}

// ---------- build ----------

// Releases ship with the bunny art. It's licensed and not in the repo, so it has to be in
// packages/brand/private/ on the machine that builds (see packages/brand/scripts/generate.ts).
// It also picks the icon set: Hugeicons Pro if installed here (bun run icons:pro), else free.
const art = Bun.spawnSync(["bun", join(ROOT, "..", "..", "scripts", "generate.ts"), "--require"], { stdio: ["ignore", "inherit", "inherit"] });
if (art.exitCode !== 0) process.exit(1);

const targets = TARGETS.filter((t) => !only || `${t.os}-${t.arch}` === only);
if (!targets.length) fail(`unknown --target ${only}; one of ${TARGETS.map((t) => `${t.os}-${t.arch}`).join(", ")}`);

const DIST = join(ROOT, "dist");
const OUT = join(DIST, version);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const manifest: { version: string; builtAt: string; files: Record<string, string> } = { version, builtAt: new Date().toISOString(), files: {} };
for (const t of targets) {
  const outfile = join(OUT, assetName(t));
  console.log(`→ ${assetName(t)}`);
  const res = await Bun.build({
    entrypoints: [join(ROOT, "src", "cli", "main.ts")],
    compile: { target: t.bun, outfile },
    plugins: [tailwind],
    minify: true,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.PR_BUNNY_VERSION": JSON.stringify(version),
      "process.env.PR_BUNNY_CODENAME": JSON.stringify(codename),
    },
  });
  if (!res.success) fail(`build failed for ${assetName(t)}:\n${res.logs.map(String).join("\n")}`);
  if (process.env.PR_BUNNY_SIGN_IDENTITY) {
    const entitlements = join(ROOT, "scripts", "entitlements.plist");
    await $`codesign --force --options runtime --timestamp --sign ${process.env.PR_BUNNY_SIGN_IDENTITY} --entitlements ${entitlements} ${outfile}`;
  }
  const sha = new Bun.CryptoHasher("sha256").update(await Bun.file(outfile).arrayBuffer()).digest("hex");
  await Bun.write(`${outfile}.sha256`, `${sha}  ${assetName(t)}\n`);
  manifest.files[assetName(t)] = sha;
}
await Bun.write(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await Bun.write(join(DIST, "install.sh"), Bun.file(INSTALLER));
await Bun.write(join(DIST, "latest"), `${version}\n`);
// Release notes are the GitHub Release body for this tag unless PR_BUNNY_NOTES_URL says otherwise.
const release = { version, name: codename, notesUrl: process.env.PR_BUNNY_NOTES_URL ?? `https://github.com/${GITHUB_REPO}/releases/tag/v${version}`, publishedAt: new Date().toISOString() };
await Bun.write(join(DIST, "latest.json"), `${JSON.stringify(release, null, 2)}\n`);

// ---------- smoke test (native target only) ----------

const native = targets.find((t) => t.os === process.platform && t.arch === (process.arch === "arm64" ? "arm64" : "x64"));
if (native) {
  const bin = join(OUT, assetName(native));
  const printed = (await $`${bin} version`.quiet().nothrow()).stdout.toString().trim();
  if (printed !== version) fail(`smoke test: \`${assetName(native)} version\` printed "${printed}", expected ${version}`);
  // Serve from a throwaway data folder on a spare port; the UI and API must both answer.
  const home = mkdtempSync(join(tmpdir(), "bunny-smoke-"));
  const port = String(45000 + Math.floor(Math.random() * 1000));
  // A local copy of the release host, so the updater's check runs against this build's latest.json.
  const releases = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(Bun.file(join(DIST, new URL(req.url).pathname))) });
  const proc = Bun.spawn([bin, "serve"], {
    env: { ...process.env, PORT: port, PR_BUNNY_HOME: home, PR_BUNNY_UPDATE_URL: `http://127.0.0.1:${releases.port}`, PR_BUNNY_UPDATE_CHECK: "0" },
    cwd: home,
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    let health: any = null;
    for (let i = 0; i < 40 && !health; i++) {
      await Bun.sleep(250);
      health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => (r.ok ? r.json() : null), () => null);
    }
    if (health?.version !== version) fail(`smoke test: /api/health answered ${JSON.stringify(health)}`);
    const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    if (!html.includes("<title>PR Bunny</title>")) fail("smoke test: the UI didn't load");
    const upd: any = await fetch(`http://127.0.0.1:${port}/api/update/check`, { method: "POST" }).then((r) => r.json());
    if (upd?.status !== "latest" || upd.latest?.version !== version) fail(`smoke test: the update check against latest.json answered ${JSON.stringify(upd)}`);
  } finally {
    proc.kill();
    releases.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
  console.log(`✓ smoke test passed (${assetName(native)})`);
} else {
  console.log("… no native target built; skipped the smoke test");
}

console.log(`\n✓ bunny ${version} \u201c${codename}\u201d → ${OUT}`);
for (const [name, sha] of Object.entries(manifest.files)) console.log(`  ${name}  ${sha.slice(0, 12)}…`);

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
