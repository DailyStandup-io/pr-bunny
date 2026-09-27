// Access to /stats: STATS_TOKEN as `Authorization: Bearer …`, or the cookie /stats/login sets from a
// POSTed form (so the token never sits in a URL, request logs or browser history). The cookie holds a
// hash of the token, not the token. Without STATS_TOKEN nothing is allowed.
import { createHash, timingSafeEqual } from "node:crypto";

export const COOKIE = "pb_stats";
export const cookieValue = (token: string) => createHash("sha256").update(`pr-bunny-stats:${token}`).digest("hex");

const same = (a: string, b: string) => {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
};

export function allowed({ bearer, cookie }: { bearer?: string | null; cookie?: string | null }): boolean {
  const expected = process.env.STATS_TOKEN;
  if (!expected) return false;
  if (bearer) return same(bearer, expected);
  if (cookie) return same(cookie, cookieValue(expected));
  return false;
}

export const bearerOf = (authorization: string | null) => authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
