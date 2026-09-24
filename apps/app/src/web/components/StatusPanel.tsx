import { useEffect, useState } from "react";
import type { PrCheck, ReviewDetail } from "../../shared/types";
import { api, navigate, useAsync, useLayout } from "../api";
import { card, field, Spinner, Sym, timeAgo } from "./ui";

const GOOD = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const BAD = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

const DECISION: Record<string, { text: string; color: string }> = {
  APPROVED: { text: "Approved", color: "var(--add)" },
  CHANGES_REQUESTED: { text: "Changes requested", color: "var(--del)" },
  REVIEW_REQUIRED: { text: "Review required", color: "var(--warn)" },
};

const REVIEW_STATE: Record<string, { text: string; color?: string }> = {
  APPROVED: { text: "approved", color: "var(--add)" },
  CHANGES_REQUESTED: { text: "changes requested", color: "var(--del)" },
  COMMENTED: { text: "commented" },
  DISMISSED: { text: "dismissed" },
};

const humanize = (s: string) => {
  const t = s.toLowerCase().replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const page = "mx-auto w-full max-w-[1400px] flex-1 px-[clamp(16px,3vw,32px)] pt-6 pb-12";

export function StatusPanel({ review }: { review: ReviewDetail }) {
  const { wide, mid } = useLayout();
  const { data: s, error, loading, reload } = useAsync(() => api.status(review.id), [review.id]);
  const [approveBody, setApproveBody] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);

  // Poll while the tab is open; checks move on their own.
  useEffect(() => {
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !s) return <div className={page}><p className="m-0 text-[14px] text-del">{error}</p></div>;
  if (!s) return <div className={page}><Spinner /></div>;

  const failing = s.checks.filter((c) => BAD.has(c.state));
  const pending = s.checks.filter((c) => !GOOD.has(c.state) && !BAD.has(c.state));
  const passing = s.checks.filter((c) => GOOD.has(c.state));
  const isAuthor = s.viewer && s.viewer === review.author;
  const canApprove = s.state === "OPEN" && !isAuthor;
  const side = wide || mid;

  const summary = [failing.length && `${failing.length} failing`, pending.length && `${pending.length} pending`, passing.length && `${passing.length} passing`]
    .filter(Boolean)
    .join(" · ");
  const summaryColor = failing.length ? "var(--del)" : pending.length ? "var(--warn)" : "var(--add)";

  const doApprove = async () => {
    setBusy("approve");
    setActionError(null);
    try {
      await api.approve(review.id, approveBody);
      setApproved(true);
      setConfirming(false);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const rereview = async () => {
    setBusy("rereview");
    setActionError(null);
    try {
      const { id } = await api.rereview(review.id);
      navigate(`/review/${id}`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <div className={page}>
      <div className="grid items-start gap-5" style={{ gridTemplateColumns: side ? "minmax(0,1fr) 340px" : "minmax(0,1fr)" }}>
        <div className="flex min-w-0 flex-col gap-4">
          {s.newCommitsSinceReview && (
            <section className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-xl border border-accent-soft-2 bg-accent-soft px-5 py-4">
              <div>
                <p className="m-0 text-[14.5px] font-semibold">New commits since this review</p>
                <p className="mt-0.5 mb-0 text-[13px] text-fg-2">
                  Reviewed <span className="font-mono">{review.headSha.slice(0, 8)}</span>; the PR is now at <span className="font-mono">{s.headSha.slice(0, 8)}</span>.
                </p>
              </div>
              <button
                onClick={rereview}
                disabled={busy !== null}
                className="h-[46px] cursor-pointer rounded-[10px] border-0 bg-accent px-[18px] text-[14.5px] font-semibold text-on-accent disabled:opacity-60"
              >
                {busy === "rereview" ? "Starting…" : "Re-review changes →"}
              </button>
            </section>
          )}

          <section className={`${card} px-[22px] py-[18px]`}>
            <div className="mb-1.5 flex items-center justify-between">
              <h2 className="m-0 text-[14px] font-semibold">Checks</h2>
              <button onClick={reload} className="h-8 cursor-pointer rounded-lg border border-line bg-transparent px-2.5 text-[12.5px] text-fg-2 hover:bg-hover">
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {s.checks.length === 0 ? (
              <p className="m-0 text-[14px] text-fg-3">No checks reported.</p>
            ) : (
              <p className="mt-0 mb-2 text-[14px] font-medium" style={{ color: summaryColor }}>{summary}</p>
            )}
            <ul className="m-0 list-none p-0">
              {[...failing, ...pending, ...passing].map((c: PrCheck, i) => {
                const good = GOOD.has(c.state);
                const bad = BAD.has(c.state);
                return (
                  <li key={`${c.name}-${i}`} className="flex items-center gap-3 border-t border-line py-2.5 text-[14px]">
                    <Sym name={good ? "check_circle" : bad ? "cancel" : "pending"} size={19} className={good ? "text-add" : bad ? "text-del" : "text-warn"} />
                    <span className="min-w-0 flex-1 truncate">
                      {c.url ? (
                        <a href={c.url} target="_blank" rel="noreferrer" className="text-fg">
                          {c.name}
                        </a>
                      ) : (
                        c.name
                      )}
                    </span>
                    <span className={`text-[12.5px] ${bad ? "text-del" : "text-fg-3"}`}>{c.state.toLowerCase().replace(/_/g, " ")}</span>
                  </li>
                );
              })}
            </ul>
          </section>

          {s.reviews.length > 0 && (
            <section className={`${card} px-[22px] py-[18px]`}>
              <h2 className="mt-0 mb-2 text-[14px] font-semibold">Reviews</h2>
              <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[14px]">
                {s.reviews.map((r, i) => {
                  const st = REVIEW_STATE[r.state] ?? { text: r.state.toLowerCase().replace(/_/g, " ") };
                  return (
                    <li key={i} className="flex items-center gap-3">
                      <span className="font-medium">{r.author === s.viewer ? "you" : r.author}</span>
                      <span style={{ color: st.color ?? "var(--text-2)" }}>{st.text}</span>
                      <span className="ml-auto text-[12.5px] text-fg-3">{r.submittedAt ? timeAgo(r.submittedAt) : ""}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>

        <aside className="top-[68px] flex min-w-0 flex-col gap-3.5" style={{ position: side ? "sticky" : "static" }}>
          <section className={`${card} flex flex-col gap-2.5 px-5 py-4 text-[14px]`}>
            <Row k="State" v={s.isDraft ? "Draft" : humanize(s.state)} />
            <Row k="Decision" v={DECISION[s.reviewDecision ?? ""]?.text ?? "None yet"} color={DECISION[s.reviewDecision ?? ""]?.color} />
            <Row
              k="Mergeable"
              v={s.mergeable === "MERGEABLE" ? "Yes" : s.mergeable === "CONFLICTING" ? "Conflicts" : "Unknown"}
              color={s.mergeable === "MERGEABLE" ? "var(--add)" : s.mergeable === "CONFLICTING" ? "var(--del)" : "var(--text-3)"}
            />
            <Row k="Merge state" v={humanize(s.mergeStateStatus)} />
          </section>

          <section className={`${card} flex flex-col gap-2.5 px-5 py-[18px]`}>
            <h2 className="m-0 text-[14px] font-semibold">Approve</h2>
            {approved ? (
              <p className="m-0 text-[14px] font-medium text-add">Approved #{review.prNumber}</p>
            ) : !canApprove ? (
              <p className="m-0 text-[14px] text-fg-3">{isAuthor ? "You can't approve your own PR." : `PR is ${s.state.toLowerCase()}.`}</p>
            ) : (
              <>
                <textarea
                  value={approveBody}
                  onChange={(e) => setApproveBody(e.target.value)}
                  rows={2}
                  placeholder="Optional comment (e.g. LGTM)"
                  className={`block w-full resize-y px-3 py-2.5 text-[14px] ${field}`}
                />
                {failing.length > 0 && <p className="m-0 text-[12.5px] text-warn">{failing.length} check{failing.length === 1 ? " is" : "s are"} failing.</p>}
                {!confirming ? (
                  <button
                    onClick={() => setConfirming(true)}
                    className="h-[50px] cursor-pointer rounded-[10px] border-0 bg-add-soft text-[15px] font-semibold text-add hover:bg-add-soft-2"
                  >
                    Approve PR…
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={doApprove}
                      disabled={busy !== null}
                      className="h-[50px] flex-1 cursor-pointer rounded-[10px] border-0 bg-add text-[14.5px] font-semibold text-surface disabled:opacity-60"
                    >
                      {busy === "approve" ? "Approving…" : `Yes, approve #${review.prNumber}`}
                    </button>
                    <button
                      onClick={() => setConfirming(false)}
                      className="h-[50px] cursor-pointer rounded-[10px] border border-line bg-transparent px-3.5 text-[14px] text-fg-2"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </>
            )}
            {actionError && <p className="m-0 text-[12.5px] text-del">{actionError}</p>}
          </section>
        </aside>
      </div>
    </div>
  );
}

function Row({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-fg-3">{k}</span>
      <span className="text-right" style={{ color }}>{v}</span>
    </div>
  );
}
