#!/usr/bin/env bun
// Downloads the licensed bunny art from the private art repo into packages/brand/private/.
//
//   bun run art:fetch             locally: uses PR_BUNNY_ART_TOKEN, else your `gh` login
//   (automatic)                   the root generate step calls this when PR_BUNNY_ART_TOKEN is set
//                                 and the art is missing, e.g. on Vercel or in CI
//
// PR_BUNNY_ART_TOKEN: a fine-grained GitHub token with read-only Contents access to the art repo.
// PR_BUNNY_ART_REPO overrides the repo (default DailyStandup-io/pr-bunny-art); PR_BUNNY_ART_REF the branch.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ART_FILES = [...Array.from({ length: 10 }, (_, i) => `bunny-${i + 1}.png`), "favicon.ico", "icon-32.png", "apple-touch-icon.png"];
const PRIVATE = resolve(import.meta.dir, "..", "private");
const REPO = process.env.PR_BUNNY_ART_REPO ?? "DailyStandup-io/pr-bunny-art";
const REF = process.env.PR_BUNNY_ART_REF ?? "main";

export const hasArt = () => ART_FILES.every((f) => existsSync(join(PRIVATE, f)));

function token(): string | null {
  if (process.env.PR_BUNNY_ART_TOKEN) return process.env.PR_BUNNY_ART_TOKEN;
  // Locally, your GitHub CLI login works too (if you can read the art repo).
  const gh = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
  const t = gh.exitCode === 0 ? gh.stdout.toString().trim() : "";
  return t || null;
}

export async function fetchArt(): Promise<void> {
  const auth = token();
  if (!auth) throw new Error("No token: set PR_BUNNY_ART_TOKEN (read-only access to the art repo), or log in with `gh auth login`.");
  mkdirSync(PRIVATE, { recursive: true });
  await Promise.all(
    ART_FILES.map(async (file) => {
      const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${file}?ref=${encodeURIComponent(REF)}`, {
        headers: { authorization: `Bearer ${auth}`, accept: "application/vnd.github.raw", "user-agent": "pr-bunny-build" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const hint = res.status === 404 || res.status === 401 ? " (does the token have read access to the art repo?)" : "";
        throw new Error(`${file}: ${res.status} ${res.statusText}${hint}`);
      }
      writeFileSync(join(PRIVATE, file), new Uint8Array(await res.arrayBuffer()));
    }),
  );
}

if (import.meta.main) {
  try {
    await fetchArt();
    console.log(`✓ bunny art fetched from ${REPO} into packages/brand/private/`);
  } catch (e) {
    console.error(`✗ Couldn't fetch the bunny art from ${REPO}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
