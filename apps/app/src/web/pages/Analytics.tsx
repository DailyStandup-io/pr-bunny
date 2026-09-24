import type { StatsBucket } from "../../shared/types";
import { api, navigate, useAsync } from "../api";
import { Page } from "../components/Page";
import { card, PHASE_LABEL, phaseColor, Spinner, timeAgo } from "../components/ui";

const COLS = "minmax(0,1fr) 120px 120px 170px 100px";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Analytics: how your reviews go (tiles, accept rates, dismissals), then the full history. */
export function Analytics() {
  const { data, error } = useAsync(api.reviews, []);
  const { data: stats } = useAsync(api.stats, []);
  const decided = stats ? stats.accepted + stats.dismissed : 0;

  return (
    <Page title="Analytics">

      {stats && (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
            <Tile label="Reviews" value={stats.reviews} sub={`${stats.submitted} posted`} />
            <Tile label="Findings" value={stats.findings} sub={`${decided} decided`} />
            <Tile label="Accept rate" value={decided ? `${Math.round((stats.accepted / decided) * 100)}%` : "—"} sub={`${stats.accepted} accepted · ${stats.dismissed} dismissed`} />
            <Tile label="Agent time" value={`${stats.claudeMinutes}m`} sub={`≈ $${stats.estCostUsd.toFixed(2)} at list price (subscription)`} />
          </div>

          {stats.findings > 0 && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] items-stretch gap-4">
              <Buckets title="By severity" rows={stats.bySeverity} />
              <Buckets title="By lens" rows={stats.byLens} />
              <section className={`${card} col-span-full px-5 py-[18px]`}>
                <h2 className="mt-0 mb-1 text-[14px] font-semibold">Recent dismissals</h2>
                <p className="mt-0 mb-3 text-[12.5px] text-fg-3">Fed back into future reviews of the same repo so they stop recurring.</p>
                {stats.recentDismissals.length === 0 ? (
                  <p className="m-0 text-[13.5px] text-fg-3">None yet.</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                    {stats.recentDismissals.map((d, i) => (
                      <li key={i} className="text-[13.5px] leading-[1.4]">
                        <span>{d.title}</span>
                        <span className="mt-0.5 block text-[12px] text-fg-3">
                          {d.lens ?? "general"} · {d.reason ?? "no reason"} · {d.repo}#{d.prNumber}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </>
      )}

      <h2 className="mt-3 mb-[-12px] text-[15px] font-semibold">History</h2>
      {error && <p className="m-0 text-[14px] text-del">{error}</p>}
      <div className={`${card} overflow-x-auto`}>
        <div className="min-w-[760px]">
          <div className="grid gap-4 border-b border-line px-5 py-3 text-[12.5px] font-semibold text-fg-3" style={{ gridTemplateColumns: COLS }}>
            <span>PR</span>
            <span>Author</span>
            <span>Size</span>
            <span>Status</span>
            <span>Started</span>
          </div>
          {!data && !error && (
            <div className="px-5 py-6">
              <Spinner />
            </div>
          )}
          {data?.map((r) => (
            <button
              key={r.id}
              onClick={() => navigate(`/review/${r.id}`)}
              className="grid w-full cursor-pointer items-center gap-4 border-0 border-b border-line bg-transparent px-5 py-3 text-left text-[14px] last:border-b-0 hover:bg-hover"
              style={{ gridTemplateColumns: COLS }}
            >
              <span className="min-w-0">
                <span className="block truncate">{r.title}</span>
                <span className="font-mono text-[12px] text-fg-3">
                  {r.repo}#{r.prNumber}
                </span>
              </span>
              <span className="truncate text-fg-2">{r.author}</span>
              <span className="font-mono text-[12.5px]">
                <span className="text-add">+{r.additions.toLocaleString()}</span> <span className="text-del">−{r.deletions.toLocaleString()}</span>
              </span>
              <span style={{ color: phaseColor(r.phase) }}>{PHASE_LABEL[r.phase]}</span>
              <span className="text-fg-3">{timeAgo(r.startedAt)}</span>
            </button>
          ))}
          {data?.length === 0 && <p className="m-0 px-5 py-8 text-center text-[14px] text-fg-3">No reviews yet.</p>}
        </div>
      </div>
    </Page>
  );
}

function Tile({ label, value, sub }: { label: string; value: string | number; sub: string }) {
  return (
    <div className={`${card} px-[18px] py-4`}>
      <div className="text-[13px] text-fg-3">{label}</div>
      <div className="mt-0.5 text-[28px] font-semibold tracking-[-0.02em] tabular-nums">{value}</div>
      <div className="mt-0.5 text-[12.5px] text-fg-3">{sub}</div>
    </div>
  );
}

function Buckets({ title, rows }: { title: string; rows: StatsBucket[] }) {
  return (
    <section className={`${card} px-5 py-[18px]`}>
      <h2 className="mt-0 mb-3.5 text-[14px] font-semibold">{title}</h2>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {rows.map((r) => {
          const decided = r.accepted + r.dismissed;
          return (
            <li key={r.key}>
              <div className="flex justify-between gap-3 text-[13.5px]">
                <span>{cap(r.key)}</span>
                <span className="font-mono text-[12px] text-fg-3">
                  {r.total} · {decided ? `${Math.round((r.accepted / decided) * 100)}% kept` : "undecided"}
                </span>
              </div>
              <div className="mt-[5px] flex h-1.5 overflow-hidden rounded-[3px] bg-sunken">
                <div className="bg-add" style={{ width: `${(r.accepted / r.total) * 100}%` }} />
                <div className="bg-line-strong" style={{ width: `${(r.dismissed / r.total) * 100}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
