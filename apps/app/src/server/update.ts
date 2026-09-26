// Self-update for the installed `bunny` binary. Checks latest.json (RELEASE_SOURCES), downloads the
// build for this Mac, verifies its sha256 and that it runs, swaps it in place, and restarts the
// launchd service onto it. Installing and restarting only happen from a click in Settings;
// checking runs in the background.
//
// Release files (written by scripts/build.ts, attached to the GitHub Release for tag v<version>):
//   latest.json                    { version, name, notesUrl?, publishedAt? }
//   bunny-<os>-<arch>              the binary
//   bunny-<os>-<arch>.sha256
// Found at prbunny.dev/releases/… (redirects to GitHub), else on GitHub directly (see config.ts).
import { $ } from "bun";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseInfo, UpdateState } from "../shared/types";
import { CODENAME, COMPILED, VERSION } from "../build-info";
import { APP_LABEL, DATA_DIR, env, RELEASE_SOURCES, type ReleaseSource } from "./config";

const STATE_FILE = join(DATA_DIR, "update.json");
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const current = { version: VERSION, name: CODENAME };
const asset = `bunny-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;

/** Why this copy can't update itself, or null if it can. */
function unsupported(): string | null {
  if (RELEASE_SOURCES === "off") return "Update checks are turned off (PR_BUNNY_UPDATE_URL=off).";
  if (!COMPILED) return "Running from source. Pull the latest changes and restart instead.";
  if (process.platform !== "darwin") return "Updates are only published for macOS.";
  return null;
}

let state: UpdateState = {
  status: unsupported() ? "unsupported" : "idle",
  current,
  latest: null,
  checkedAt: null,
  progress: 0,
  error: null,
  note: unsupported(),
};

// What the last check found survives restarts, so "Last checked 2 hours ago" stays true.
try {
  const saved = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { checkedAt?: string; latest?: ReleaseInfo | null };
  state.checkedAt = saved.checkedAt ?? null;
  if (saved.latest && state.status === "idle") {
    state.latest = saved.latest;
    if (newer(saved.latest.version, VERSION)) state.status = "available";
  }
} catch {}

const persist = () => writeFileSync(STATE_FILE, `${JSON.stringify({ checkedAt: state.checkedAt, latest: state.latest }, null, 2)}\n`);
const set = (patch: Partial<UpdateState>) => (state = { ...state, ...patch });

export const updateState = (): UpdateState => state;

/** Semver comparison: is `a` newer than `b`? A release beats its own pre-releases. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core!.split(".").map((n) => Number(n) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d > 0;
  }
  if (x.pre === y.pre) return false;
  if (x.pre === null) return true;
  if (y.pre === null) return false;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true }) > 0;
}

export async function checkForUpdate(): Promise<UpdateState> {
  if (unsupported()) return state;
  if (state.status === "checking" || state.status === "downloading" || state.status === "restarting") return state;
  if (state.status === "ready") return state; // already installed; waiting for a restart
  set({ status: "checking", error: null });
  const failures: string[] = [];
  for (const source of RELEASE_SOURCES as ReleaseSource[]) {
    try {
      const latest = await fetchLatest(source);
      source_ = source;
      set({ status: newer(latest.version, VERSION) ? "available" : "latest", latest, checkedAt: new Date().toISOString() });
      persist();
      return state;
    } catch (e) {
      failures.push(`${source.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  set({ status: "error", error: `Couldn't check for updates (${failures.join("; ")})` });
  return state;
}

/** The source that answered the last check; downloads come from the same place. */
let source_: ReleaseSource | null = null;

async function fetchLatest(source: ReleaseSource): Promise<ReleaseInfo> {
  const res = await fetch(source.latest, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": `pr-bunny/${VERSION}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as Partial<ReleaseInfo>;
  if (typeof body.version !== "string" || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(body.version)) throw new Error("latest.json has no valid version");
  return {
    version: body.version,
    name: typeof body.name === "string" ? body.name : "",
    notesUrl: typeof body.notesUrl === "string" && /^https:\/\//.test(body.notesUrl) ? body.notesUrl : null,
    publishedAt: typeof body.publishedAt === "string" ? body.publishedAt : null,
  };
}

/** Downloads and installs the latest version in the background; poll updateState() for progress. */
export function installUpdate(): UpdateState {
  const why = unsupported();
  if (why) throw new Error(why);
  if (state.status !== "available" || !state.latest) throw new Error("There's no update to install. Check for updates first.");
  const { version } = state.latest;
  set({ status: "downloading", progress: 0, error: null });
  download(version).then(
    () => set({ status: "ready", progress: 100 }),
    (e) => set({ status: "error", progress: 0, error: `Update failed: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.` }),
  );
  return state;
}

async function download(version: string) {
  const sources = [source_, ...(RELEASE_SOURCES as ReleaseSource[])].filter((x, i, all): x is ReleaseSource => !!x && all.indexOf(x) === i);
  let lastError: unknown = null;
  for (const source of sources) {
    try {
      const file = source.file(version, asset);
      return await downloadFrom(source.download?.(version, asset) ?? file, `${file}.sha256`, version);
    } catch (e) {
      lastError = e;
      if (e instanceof VerifyError) throw e; // a bad file, not a bad host: don't try elsewhere
    }
  }
  throw lastError;
}

/** The file arrived but isn't right (checksum, won't run): stop rather than try another host. */
class VerifyError extends Error {}

async function downloadFrom(url: string, sumUrl: string, version: string) {
  const target = process.execPath;
  const tmp = `${target}.download`;
  rmSync(tmp, { force: true });
  try {
    const sumRes = await fetch(sumUrl, { signal: AbortSignal.timeout(15_000) });
    if (!sumRes.ok) throw new Error(`checksum: ${sumRes.status} ${sumRes.statusText}`);
    const expected = (await sumRes.text()).trim().split(/\s+/)[0]!.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error("the checksum file is malformed");

    const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`download: ${res.status} ${res.statusText}`);
    const total = Number(res.headers.get("content-length")) || 0;
    const hasher = new Bun.CryptoHasher("sha256");
    const out = Bun.file(tmp).writer();
    let got = 0;
    for await (const chunk of res.body) {
      hasher.update(chunk);
      out.write(chunk);
      got += chunk.byteLength;
      if (total) set({ progress: Math.min(99, Math.floor((got / total) * 100)) });
    }
    await out.end();
    if (hasher.digest("hex") !== expected) throw new VerifyError("the download doesn't match its checksum");

    chmodSync(tmp, 0o755);
    // Downloaded with fetch, so there's no quarantine flag; still, make sure it runs before swapping.
    const said = (await $`${tmp} version`.quiet().nothrow()).stdout.toString().trim();
    if (said !== version) throw new VerifyError(`the new binary reports version "${said}", expected ${version}`);
    // Atomic swap: this process keeps running the old file until it restarts.
    renameSync(tmp, target);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

/** Restarts the launchd service onto the new binary. Only works when running as the service. */
export function restartForUpdate(): UpdateState {
  if (state.status !== "ready") throw new Error("No update is waiting for a restart.");
  if (process.env.XPC_SERVICE_NAME !== APP_LABEL) {
    throw new Error("PR Bunny isn't running as the login service, so it can't restart itself. Stop it and run `bunny serve` again.");
  }
  set({ status: "restarting" });
  // Give this response time to reach the browser, then let launchd replace us with the new binary.
  setTimeout(() => {
    Bun.spawn(["launchctl", "kickstart", "-k", `gui/${process.getuid!()}/${APP_LABEL}`], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  }, 400);
  return state;
}

/** Background checks: shortly after start, then every few hours. */
export function scheduleUpdateChecks() {
  if (unsupported() || env("UPDATE_CHECK") === "0") return;
  const due = state.checkedAt ? Math.max(0, Date.parse(state.checkedAt) + CHECK_EVERY_MS - Date.now()) : 0;
  setTimeout(() => {
    checkForUpdate();
    setInterval(checkForUpdate, CHECK_EVERY_MS);
  }, Math.max(30_000, due)).unref?.();
}
