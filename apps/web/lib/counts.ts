// Anonymous install and update counts, kept in Upstash Redis (Vercel Marketplace). Only counters are
// stored: no IPs, user agents, cookies or install IDs. Every value that ends up in a key is checked
// here first (semver, a known arch), and anything else becomes "unknown".
//
//   installs:total, installs:v:<version>, installs:arch:<arch>   all-time counts (INCR)
//   installs:day:<yyyy-mm-dd>   hash, field = arch                one binary download by install.sh
//   checks:day:<yyyy-mm-dd>     hash, field = running version     one updater check of latest.json
//   updates:day:<yyyy-mm-dd>    hash, field = "<from>><to>"       one binary download by the updater
//   updates:total                                                 all-time updates
//
// Without UPSTASH_REDIS_REST_URL/TOKEN (or Vercel's KV_REST_API_URL/TOKEN) nothing is recorded.
import { Redis } from "@upstash/redis";

export const ARCHES = ["darwin-arm64", "darwin-x64"] as const;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.-]{1,20})?$/;

export const version = (v: string | null | undefined) => (v && v.length <= 32 && SEMVER.test(v) ? v : "unknown");
export const arch = (a: string | null | undefined) => (ARCHES as readonly string[]).includes(a ?? "") ? a! : "unknown";
export const day = (d = new Date()) => d.toISOString().slice(0, 10);

const TIMEOUT_MS = 1500;

let client: Redis | null | undefined;
/** The Redis client, or null when storage isn't configured. */
export function redis(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  client = url && token
    ? new Redis({ url, token, retry: { retries: 0 }, signal: () => AbortSignal.timeout(TIMEOUT_MS), enableTelemetry: false })
    : null;
  return client;
}

export type Count =
  | { kind: "install"; arch: string; version: string }
  | { kind: "check"; version: string }
  | { kind: "update"; from: string; to: string };

/** Records one count. Never throws: a count that can't be stored is dropped. */
export async function record(count: Count): Promise<void> {
  await Promise.allSettled([store(count), mirror(count)]);
}

async function store(count: Count) {
  const r = redis();
  if (!r) return;
  const today = day();
  const p = r.pipeline();
  if (count.kind === "install") {
    p.incr("installs:total");
    p.incr(`installs:v:${count.version}`);
    p.incr(`installs:arch:${count.arch}`);
    p.hincrby(`installs:day:${today}`, count.arch, 1);
  } else if (count.kind === "check") {
    p.hincrby(`checks:day:${today}`, count.version, 1);
  } else {
    p.incr("updates:total");
    p.hincrby(`updates:day:${today}`, `${count.from}>${count.to}`, 1);
  }
  await p.exec();
}

/**
 * Vercel Web Analytics custom events (Pro plan), only with VERCEL_ANALYTICS_EVENTS=1. Empty headers:
 * otherwise track() forwards the request's user agent, IP (x-forwarded-for) and cookies.
 */
async function mirror(count: Count) {
  if (process.env.VERCEL_ANALYTICS_EVENTS !== "1") return;
  const { track } = await import("@vercel/analytics/server");
  const props =
    count.kind === "install" ? { arch: count.arch, version: count.version }
    : count.kind === "check" ? { version: count.version }
    : { from: count.from, to: count.to };
  await track(count.kind === "install" ? "Install" : count.kind === "check" ? "Update check" : "Update", props, { headers: new Headers() });
}

// ---------- reading (the /stats page and `bun run stats`) ----------

export interface Stats {
  installs: { total: number; byVersion: [string, number][]; byArch: [string, number][] };
  /** Update checks per running version over the window, newest day first. */
  checks: { days: number; total: number; byVersion: [string, number][]; perDay: { day: string; byVersion: Record<string, number> }[] };
  updates: { total: number; recent: { day: string; from: string; to: string; count: number }[] };
}

const num = (v: unknown) => Number(v) || 0;
const sorted = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0], undefined, { numeric: true }));

export async function readStats(r: Redis, days = 30): Promise<Stats> {
  const dates = Array.from({ length: days }, (_, i) => day(new Date(Date.now() - i * 86_400_000)));
  const versionKeys: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await r.scan(cursor, { match: "installs:v:*", count: 500 });
    versionKeys.push(...keys);
    cursor = String(next);
  } while (cursor !== "0");

  const p = r.pipeline();
  p.get("installs:total");
  p.get("updates:total");
  for (const a of [...ARCHES, "unknown"]) p.get(`installs:arch:${a}`);
  for (const k of versionKeys) p.get(k);
  for (const d of dates) p.hgetall(`checks:day:${d}`);
  for (const d of dates) p.hgetall(`updates:day:${d}`);
  const out = (await p.exec()) as unknown[];

  let i = 0;
  const installsTotal = num(out[i++]);
  const updatesTotal = num(out[i++]);
  const byArch = new Map<string, number>();
  for (const a of [...ARCHES, "unknown"]) {
    const n = num(out[i++]);
    if (n) byArch.set(a, n);
  }
  const byVersion = new Map<string, number>();
  for (const k of versionKeys) byVersion.set(k.slice("installs:v:".length), num(out[i++]));

  const checksByVersion = new Map<string, number>();
  const perDay: Stats["checks"]["perDay"] = [];
  for (const d of dates) {
    const h = (out[i++] ?? {}) as Record<string, unknown>;
    const row: Record<string, number> = {};
    for (const [v, n] of Object.entries(h)) {
      row[v] = num(n);
      checksByVersion.set(v, (checksByVersion.get(v) ?? 0) + num(n));
    }
    perDay.push({ day: d, byVersion: row });
  }
  const recent: Stats["updates"]["recent"] = [];
  for (const d of dates) {
    const h = (out[i++] ?? {}) as Record<string, unknown>;
    for (const [pair, n] of Object.entries(h)) {
      const [from = "unknown", to = "unknown"] = pair.split(">");
      recent.push({ day: d, from, to, count: num(n) });
    }
  }

  return {
    installs: { total: installsTotal, byVersion: sorted(byVersion), byArch: sorted(byArch) },
    checks: { days, total: [...checksByVersion.values()].reduce((a, b) => a + b, 0), byVersion: sorted(checksByVersion), perDay },
    updates: { total: updatesTotal, recent },
  };
}
