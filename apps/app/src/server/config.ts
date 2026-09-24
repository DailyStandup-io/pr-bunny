import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { GITHUB_REPO } from "../build-info";
import { homedir } from "node:os";
import { join } from "node:path";

/** `PR_BUNNY_<name>`, falling back to the pre-rename `REVIEW_PR_<name>` and `REVIEW_DESK_<name>`. */
export const env = (name: string): string | undefined =>
  process.env[`PR_BUNNY_${name}`] ?? process.env[`REVIEW_PR_${name}`] ?? process.env[`REVIEW_DESK_${name}`];

// Installs from before the renames keep their data where it is (~/.review-pr, ~/.review-desk and their db files).
const LEGACY_DIRS = [".review-pr", ".review-desk"].map((d) => join(homedir(), d));
export const DATA_DIR = env("HOME") ?? LEGACY_DIRS.find((d) => existsSync(d)) ?? join(homedir(), ".pr-bunny");
export const DB_PATH =
  ["review-pr.db", "review-desk.db"].map((f) => join(DATA_DIR, f)).find((p) => existsSync(p)) ?? join(DATA_DIR, "pr-bunny.db");
export const LOG_DIR = join(DATA_DIR, "logs");
export const REPOS_DIR = join(DATA_DIR, "repos");
export const WORKTREES_DIR = join(DATA_DIR, "worktrees");

for (const dir of [DATA_DIR, LOG_DIR, REPOS_DIR, WORKTREES_DIR]) mkdirSync(dir, { recursive: true });

export const PORT = Number(process.env.PORT ?? 4477);
export const HOST = "127.0.0.1";
/** Hostname Caddy serves the app on (see Caddyfile), when HTTPS is turned on. */
export const DOMAIN = env("DOMAIN") ?? "prbunny.localhost";

/**
 * How the app is reached, chosen in `bunny setup`: plain http://127.0.0.1:4477 (the default), or
 * https://prbunny.localhost through the optional Caddy proxy. Saved in the data folder.
 */
export interface ServiceConfig {
  https: boolean;
}
const SERVICE_FILE = join(DATA_DIR, "service.json");

export function serviceConfig(): ServiceConfig {
  try {
    return { https: Boolean(JSON.parse(readFileSync(SERVICE_FILE, "utf8")).https) };
  } catch {
    return { https: false };
  }
}

export function saveServiceConfig(c: ServiceConfig) {
  writeFileSync(SERVICE_FILE, `${JSON.stringify(c, null, 2)}\n`);
}

/** launchd labels for the login service (see src/cli/service.ts). */
export const APP_LABEL = "dev.prbunny.app";
export const CADDY_LABEL = "dev.prbunny.caddy";


/**
 * Where to look for updates, in order. Each has `latest.json` and the release files:
 * - prbunny.dev/releases: our domain, which redirects to GitHub (so storage can move later
 *   without breaking installed copies)
 * - GitHub Releases directly, in case the site is down
 * PR_BUNNY_UPDATE_URL replaces both with one base URL laid out like dist/ (`<base>/latest.json`,
 * `<base>/<version>/<file>`); "off" disables update checks.
 */
export interface ReleaseSource {
  name: string;
  latest: string;
  file: (version: string, name: string) => string;
}
const custom = env("UPDATE_URL")?.replace(/\/+$/, "");
const github = `https://github.com/${GITHUB_REPO}/releases`;
export const RELEASE_SOURCES: ReleaseSource[] | "off" =
  custom === "off"
    ? "off"
    : custom
      ? [{ name: custom, latest: `${custom}/latest.json`, file: (v, f) => `${custom}/${v}/${f}` }]
      : [
          { name: "prbunny.dev", latest: "https://prbunny.dev/releases/latest.json", file: (v, f) => `https://prbunny.dev/releases/${v}/${f}` },
          { name: "GitHub", latest: `${github}/latest/download/latest.json`, file: (v, f) => `${github}/download/v${v}/${f}` },
        ];

/** Where the UI is opened: the HTTPS domain if set up, else the local port. */
export const publicUrl = () => (serviceConfig().https ? `https://${DOMAIN}` : `http://127.0.0.1:${PORT}`);

export const MODELS = {
  recon: env("RECON_MODEL") ?? "sonnet",
  review: env("REVIEW_MODEL") ?? "opus",
  qa: env("QA_MODEL") ?? "opus",
};

/** A review's checkout is removed after this long without activity (and right after posting). */
export const WORKTREE_TTL_HOURS = Number(env("WORKTREE_TTL_HOURS") ?? 72);

/** Diffs larger than this are truncated before being inlined into the recon prompt. */
export const RECON_DIFF_CHAR_LIMIT = 120_000;
