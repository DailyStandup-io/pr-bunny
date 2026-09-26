// `bun run stats`: the /stats numbers in the terminal, read with the Upstash REST API.
// Needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (e.g. from `vercel env pull .env.local`).
import { readStats, redis } from "../lib/counts";

const r = redis();
if (!r) {
  console.error("Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (vercel env pull .env.local).");
  process.exit(1);
}
const days = Number(process.argv[2]) || 30;
const s = await readStats(r, days);

const pad = (s: string, n: number) => s.padEnd(n);
function bars(title: string, rows: [string, number][], total: number) {
  console.log(`\n${title}`);
  if (!rows.length || !total) return console.log("  nothing yet");
  for (const [name, n] of rows) {
    const pct = (n / total) * 100;
    console.log(`  ${pad(name, 16)} ${"█".repeat(Math.max(1, Math.round(pct / 4))).padEnd(25)} ${String(n).padStart(7)}  ${pct.toFixed(1).padStart(5)}%`);
  }
}

console.log(`PR Bunny · installs ${s.installs.total} · update checks (${s.checks.days}d) ${s.checks.total} · updates ${s.updates.total}`);
bars("Installs by version", s.installs.byVersion, s.installs.total);
bars("Installs by Mac", s.installs.byArch, s.installs.total);
bars(`Versions in use, last ${s.checks.days} days (share of update checks)`, s.checks.byVersion, s.checks.total);
console.log("\nRecent updates");
const updates = s.updates.recent.filter((u) => u.count > 0);
if (!updates.length) console.log("  nothing yet");
for (const u of updates) console.log(`  ${u.day}  ${pad(`${u.from} → ${u.to}`, 24)} ${u.count}`);
