import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { GITHUB_REPO, VERSION } from "../build-info";
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
 * `httpsPort` is for when something else (e.g. Tailscale Serve/Funnel) already holds 443.
 */
export interface ServiceConfig {
  https: boolean;
  httpsPort: number;
}
const SERVICE_FILE = join(DATA_DIR, "service.json");
const validPort = (p: unknown) => (Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536 ? (p as number) : 443);

export function serviceConfig(): ServiceConfig {
  try {
    const c = JSON.parse(readFileSync(SERVICE_FILE, "utf8"));
    return { https: Boolean(c.https), httpsPort: validPort(c.httpsPort) };
  } catch {
    return { https: false, httpsPort: 443 };
  }
}

export function saveServiceConfig(c: ServiceConfig) {
  // Only write the port when it isn't the default, so service.json stays `{ "https": true }` for most.
  const out = c.httpsPort === 443 ? { https: c.https } : c;
  writeFileSync(SERVICE_FILE, `${JSON.stringify(out, null, 2)}\n`);
}

/** The HTTPS host as a browser sends it: `prbunny.localhost`, or `prbunny.localhost:4443` off 443. */
export const httpsHost = (port = serviceConfig().httpsPort) => (port === 443 ? DOMAIN : `${DOMAIN}:${port}`);

/** launchd labels for the login service (see src/cli/service.ts). */
export const APP_LABEL = "dev.prbunny.app";
export const CADDY_LABEL = "dev.prbunny.caddy";


/**
 * Where to look for updates, in order. Each has `latest.json` and the release files:
 * - prbunny.dev/releases: our domain, which redirects to GitHub (so storage can move later
 *   without breaking installed copies)
 * - GitHub Releases directly, in case the site is down
 * prbunny.dev counts checks (by the running version, `?v=`) and updates (`?from=` on the binary);
 * only counters, nothing that identifies this copy. GitHub and custom URLs get no parameters.
 * PR_BUNNY_UPDATE_URL replaces both with one base URL laid out like dist/ (`<base>/latest.json`,
 * `<base>/<version>/<file>`); "off" disables update checks.
 */
export interface ReleaseSource {
  name: string;
  latest: string;
  file: (version: string, name: string) => string;
  /** The binary's URL for an update from this version, when it differs from `file` (its .sha256 doesn't). */
  download?: (version: string, name: string) => string;
}
const custom = env("UPDATE_URL")?.replace(/\/+$/, "");
const github = `https://github.com/${GITHUB_REPO}/releases`;
export const RELEASE_SOURCES: ReleaseSource[] | "off" =
  custom === "off"
    ? "off"
    : custom
      ? [{ name: custom, latest: `${custom}/latest.json`, file: (v, f) => `${custom}/${v}/${f}` }]
      : [
          {
            name: "prbunny.dev",
            latest: `https://prbunny.dev/releases/latest.json?v=${encodeURIComponent(VERSION)}`,
            file: (v, f) => `https://prbunny.dev/releases/${v}/${f}`,
            download: (v, f) => `https://prbunny.dev/releases/${v}/${f}?from=${encodeURIComponent(VERSION)}`,
          },
          { name: "GitHub", latest: `${github}/latest/download/latest.json`, file: (v, f) => `${github}/download/v${v}/${f}` },
        ];

/** Where the UI is opened: the HTTPS domain if set up, else the local port. */
export const publicUrl = () => (serviceConfig().https ? `https://${httpsHost()}` : `http://127.0.0.1:${PORT}`);

export const MODELS = {
  recon: env("RECON_MODEL") ?? "sonnet",
  review: env("REVIEW_MODEL") ?? "opus",
  qa: env("QA_MODEL") ?? "opus",
};

/** A review's checkout is removed after this long without activity (and right after posting). */
export const WORKTREE_TTL_HOURS = Number(env("WORKTREE_TTL_HOURS") ?? 72);

/** Diffs larger than this are truncated before being inlined into the recon prompt. */
export const RECON_DIFF_CHAR_LIMIT = 120_000;
