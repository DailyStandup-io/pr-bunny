// Sign in to /stats from a browser: GET shows a one-field form, POST checks STATS_TOKEN and sets an
// HttpOnly cookie (lib/stats-auth.ts), then 303s to /stats. 404 without STATS_TOKEN or a wrong token.
import { COOKIE, allowed, cookieValue } from "@/lib/stats-auth";

export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404 });
const PRIVATE = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };

const FORM = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Stats · PR Bunny</title>
<style>body{font:14px system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f6f3;color:#2b2925}
@media(prefers-color-scheme:dark){body{background:#1c1b19;color:#ecebe8}}form{display:flex;gap:8px;padding:16px}
input,button{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid #8884}button{cursor:pointer}</style>
<form method="post"><input type="password" name="token" placeholder="Stats token" autocomplete="current-password" required autofocus><button>Open stats</button></form>`;

export function GET() {
  if (!process.env.STATS_TOKEN) return notFound();
  return new Response(FORM, { headers: { "content-type": "text/html; charset=utf-8", ...PRIVATE } });
}

export async function POST(req: Request) {
  const token = (await req.formData().catch(() => null))?.get("token");
  if (typeof token !== "string" || !allowed({ bearer: token })) return notFound();
  const cookie = `${COOKIE}=${cookieValue(token)}; Path=/stats; Max-Age=${30 * 86_400}; HttpOnly; Secure; SameSite=Strict`;
  return new Response(null, { status: 303, headers: { location: "/stats", "set-cookie": cookie, ...PRIVATE } });
}
