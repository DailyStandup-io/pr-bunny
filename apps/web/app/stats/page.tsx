// Private install and update counts (lib/counts.ts). Needs STATS_TOKEN, as `Authorization: Bearer …`
// or ?token=…; anything else, including a site without STATS_TOKEN, gets a 404.
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createHash, timingSafeEqual } from "node:crypto";
import { readStats, redis, type Stats } from "@/lib/counts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Stats · PR Bunny",
  robots: { index: false, follow: false, nocache: true },
};

const same = (a: string, b: string) => {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
};

export default async function StatsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const expected = process.env.STATS_TOKEN;
  const auth = (await headers()).get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const q = (await searchParams).token;
  const given = auth ?? (typeof q === "string" ? q : undefined);
  if (!expected || !given || !same(given, expected)) notFound();

  const r = redis();
  let stats: Stats | null = null;
  let error: string | null = r ? null : "Storage isn't configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).";
  if (r) {
    try {
      stats = await readStats(r);
    } catch (e) {
      error = `Couldn't read the counts: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[760px] flex-col gap-8 bg-bg px-4 py-10 text-[14px] leading-[1.5] text-fg sm:px-8">
      <header className="flex items-baseline gap-2.5">
        <h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">PR Bunny stats</h1>
        <span className="text-[12.5px] text-fg-3">anonymous counts · UTC days</span>
      </header>
      {error && <p className="m-0 rounded-lg border border-line bg-surface px-4 py-3 text-del">{error}</p>}
      {stats && <Report s={stats} />}
    </main>
  );
}

function Report({ s }: { s: Stats }) {
  const updates = s.updates.recent.filter((u) => u.count > 0);
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile label="Installs, all time" value={s.installs.total} />
        <Tile label={`Update checks, ${s.checks.days} days`} value={s.checks.total} />
        <Tile label="Updates, all time" value={s.updates.total} />
      </div>

      <Section title="Installs by version">
        <Bars rows={s.installs.byVersion} total={s.installs.total} />
      </Section>
      <Section title="Installs by Mac">
        <Bars rows={s.installs.byArch} total={s.installs.total} />
      </Section>
      <Section title={`Versions in use, last ${s.checks.days} days`} note="Share of update checks; each running copy checks about four times a day.">
        <Bars rows={s.checks.byVersion} total={s.checks.total} />
      </Section>
      <Section title="Recent updates">
        {updates.length ? (
          <table className="w-full border-collapse font-mono text-[13px]">
            <tbody>
              {updates.map((u) => (
                <tr key={`${u.day} ${u.from} ${u.to}`} className="border-t border-line first:border-t-0">
                  <td className="py-1.5 pr-4 text-fg-3">{u.day}</td>
                  <td className="py-1.5 pr-4">
                    {u.from} <span className="text-fg-3">→</span> {u.to}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{u.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty />
        )}
      </Section>
    </>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3">
      <span className="text-[12px] text-fg-3">{label}</span>
      <span className="text-[24px] font-semibold tabular-nums">{value.toLocaleString("en-GB")}</span>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {note && <p className="m-0 text-[12.5px] text-fg-3">{note}</p>}
      </div>
      <div className="rounded-xl border border-line bg-surface px-4 py-2">{children}</div>
    </section>
  );
}

function Bars({ rows, total }: { rows: [string, number][]; total: number }) {
  if (!rows.length || !total) return <Empty />;
  return (
    <table className="w-full border-collapse text-[13px]">
      <tbody>
        {rows.map(([name, n]) => {
          const pct = (n / total) * 100;
          return (
            <tr key={name} className="border-t border-line first:border-t-0">
              <td className="w-[9rem] py-1.5 pr-3 font-mono whitespace-nowrap">{name}</td>
              <td className="py-1.5 pr-3">
                <div className="h-2 rounded-full bg-sunken">
                  <div className="h-2 rounded-full bg-accent" style={{ width: `${Math.max(pct, 0.5)}%` }} />
                </div>
              </td>
              <td className="w-[4.5rem] py-1.5 text-right tabular-nums">{n.toLocaleString("en-GB")}</td>
              <td className="w-[3.5rem] py-1.5 text-right text-fg-3 tabular-nums">{pct.toFixed(pct < 10 ? 1 : 0)}%</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const Empty = () => <p className="m-0 py-1.5 text-fg-3">Nothing yet.</p>;
