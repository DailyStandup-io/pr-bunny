import { useEffect, useRef, useState } from "react";
import { useBunnyMood, type MoodReport } from "../components/Bunny";
import type { LiveEvent, Phase, ReviewDetail, TurnLimitStop } from "../../shared/types";
import { api, navigate, readPos, savePos, useAgentLabel, useAsync, useLayout, useLive } from "../api";
import { Overview } from "../components/Overview";
import { ReadyCheck } from "../components/ReadyCheck";
import { ProgressFeed, type ProgressLine } from "../components/ProgressFeed";
import { StatusPanel } from "../components/StatusPanel";
import { SubmitPanel } from "../components/SubmitPanel";
import { card, cardLabel, field, Inline, RunMeta, Spinner, Sym } from "../components/ui";
import { Walkthrough } from "../components/Walkthrough";

type Tab = "overview" | "findings" | "submit" | "status";

const defaultTab = (phase: Phase, hasRecon: boolean): Tab =>
  phase === "submitted" ? "submit" : phase === "walkthrough" || phase === "reviewing" || phase === "read" ? "findings" : phase === "failed" && hasRecon ? "findings" : "overview";

/** Page gutter + max width shared by every tab body. */
const body = "mx-auto w-full max-w-[1400px] px-[clamp(16px,3vw,32px)]";

export function Review({ id }: { id: number }) {
  const { data, error, reload } = useAsync(() => api.review(id), [id]);
  const [review, setReview] = useState<ReviewDetail | null>(null);
  const [lines, setLines] = useState<ProgressLine[]>([]);
  const [tab, setTabState] = useState<Tab | null>(null);
  const lastPhase = useRef<Phase | null>(null);
  const setTab = (t: Tab) => {
    setTabState(t);
    savePos(id, { tab: t });
  };

  useEffect(() => {
    if (data) setReview(data);
  }, [data]);
  useEffect(() => {
    setReview(null);
    setLines([]);
    setTabState(null);
    lastPhase.current = null;
  }, [id]);

  // Follow the flow: when the phase moves on, jump to the tab for it.
  useEffect(() => {
    if (!review) return;
    if (lastPhase.current !== review.phase) {
      const auto = defaultTab(review.phase, review.recon != null);
      // First load: go back to where you left it, if that tab is usable in this phase.
      const saved = lastPhase.current === null ? readPos(id)?.tab : undefined;
      const usable = saved && (saved === "overview" || (saved === "status" && review.mode === "peer") || review.phase === "walkthrough" || review.phase === "submitted");
      if (usable) setTabState(saved);
      else if (lastPhase.current === null || tab === null || auto !== "overview") setTabState(auto);
      lastPhase.current = review.phase;
    }
  }, [review?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  useLive(id, (ev: LiveEvent) => {
    if (ev.type === "progress") setLines((l) => [...l, { text: ev.text, tool: ev.tool, at: ev.at, kind: ev.runKind }]);
    if (ev.type === "phase" || ev.type === "run" || ev.type === "finding" || ev.type === "chat") reload();
  });

  useBunnyMood(review ? reviewMood(review, (t) => setTab(t)) : null);

  if (error && !review) return <Centered><p className="text-del">{error}</p></Centered>;
  if (!review) return <Centered><Spinner size={20} /></Centered>;

  const current = tab ?? defaultTab(review.phase, review.recon != null);
  const reconLines = lines.filter((l) => l.kind === "recon");
  const reviewLines = lines.filter((l) => l.kind === "review");
  const qaLines = lines.filter((l) => l.kind === "qa");
  const total = review.findings.length;
  const decided = review.findings.filter((f) => f.decision).length;
  const isRead = review.readAt != null;
  const hasFindings = review.phase === "walkthrough" || review.phase === "submitted";

  const self = review.mode === "self";
  const scanning = review.phase === "recon_running";
  const reviewing = review.phase === "reviewing" || review.phase === "read";
  const selfOpen = review.findings.filter((f) => f.resolvedRun == null && f.decision !== "dismissed").length;
  const tabs: Array<{ key: Tab; label: string; done: boolean; enabled: boolean; loading?: boolean; badge?: React.ReactNode }> = [
    { key: "overview", label: "Overview", done: !scanning && isRead, enabled: true, loading: scanning },
    {
      key: "findings",
      label: "Findings",
      done: hasFindings && total > 0 && decided === total,
      enabled: isRead || (!scanning && review.phase !== "recon_ready"),
      loading: reviewing,
      badge: hasFindings && !reviewing ? `${decided}/${total}` : undefined,
    },
    self
      ? { key: "submit", label: "Ready check", done: hasFindings && !reviewing && selfOpen === 0, enabled: hasFindings || (reviewing && total > 0) }
      : { key: "submit", label: "Submit", done: review.phase === "submitted", enabled: hasFindings },
    ...(self ? [] : [{ key: "status" as const, label: "Status", done: false, enabled: true }]),
  ];

  return (
    <div className="flex flex-1 flex-col">
      <Header review={review} />

      <div className="sticky top-0 z-20 border-b border-line bg-surface">
        <nav className="mx-auto flex max-w-[1400px] gap-0.5 overflow-x-auto px-[clamp(8px,3vw,24px)]">
          {tabs.map((t, i) => {
            const on = current === t.key;
            return (
              <button
                key={t.key}
                disabled={!t.enabled}
                onClick={() => t.enabled && setTab(t.key)}
                className={`-mb-px flex h-[52px] flex-none items-center gap-[9px] border-0 border-b-2 bg-transparent px-3.5 text-[14.5px] font-medium hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 ${
                  on ? "border-accent text-fg" : "border-transparent text-fg-2"
                } ${t.enabled ? "cursor-pointer" : ""}`}
              >
                <span
                  className={`grid size-[22px] place-items-center rounded-full font-mono text-[11.5px] font-medium ${
                    t.done ? "bg-add-soft text-add" : on || t.loading ? "bg-accent text-on-accent" : "bg-sunken text-fg-3"
                  }`}
                >
                  {t.done ? (
                    <Sym name="check" size={15} />
                  ) : t.loading ? (
                    <span className="pb-spin inline-block size-3 rounded-full border-2 border-[color-mix(in_oklch,var(--on-accent)_35%,transparent)] border-t-on-accent" />
                  ) : (
                    i + 1
                  )}
                </span>
                {t.label}
                {t.badge != null && t.enabled && (
                  <span className="inline-flex items-center rounded-full border border-line bg-sunken px-[7px] py-px font-mono text-[11.5px] text-fg-2">{t.badge}</span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {current === "overview" && (
        <>
          {review.phase === "recon_running" && (
            <div className={`${body} pt-6 pb-8`}>
              <ProgressFeed title={review.mode === "self" ? "Scanning your change" : "Scanning the PR"} lines={reconLines} active />
            </div>
          )}
          {review.phase === "failed" && !review.recon && (
            <div className={`${body} pt-6 pb-8`}>
              <Failed review={review} lines={reconLines} onRetry={async () => setReview(await api.retry(id))} />
            </div>
          )}
          {review.recon && !scanning && <Overview review={review} qaLines={qaLines} onRead={async () => setReview(await api.markRead(id))} onContinue={() => setTab("findings")} />}
        </>
      )}

      {current === "findings" && (
        <>
          {(review.phase === "reviewing" || review.phase === "read") && (
            <div className={`${body} pt-6 pb-8`}>
              <Reviewing review={review} lines={reviewLines} onCancel={() => api.cancel(id)} />
            </div>
          )}
          {review.phase === "failed" && review.recon && (
            <div className={`${body} pt-6 pb-8`}>
              <Failed review={review} lines={reviewLines} onRetry={async () => setReview(await api.retry(id))} />
            </div>
          )}
          {hasFindings && <Walkthrough review={review} qaLines={qaLines} onChanged={reload} onGoSubmit={() => setTab("submit")} />}
        </>
      )}

      {current === "submit" &&
        (self ? (
          <ReadyCheck
            review={review}
            onChanged={reload}
            onGoFinding={(idx) => {
              savePos(id, { tab: "findings", idx });
              setTab("findings");
            }}
          />
        ) : (
          <SubmitPanel review={review} onPosted={reload} onGoFindings={() => setTab("findings")} />
        ))}
      {current === "status" && <StatusPanel review={review} />}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-[60vh] items-center justify-center">{children}</div>;
}

function Header({ review }: { review: ReviewDetail }) {
  const chips = (
    <span className="inline-flex items-center gap-1.5 font-mono text-[12px]">
      <span className="rounded-[5px] border border-line bg-sunken px-[7px] py-px text-fg">{review.headRef}</span>
      <span className="text-fg-3">→</span>
      <span className="rounded-[5px] border border-line bg-sunken px-[7px] py-px text-fg">{review.baseRef}</span>
    </span>
  );
  if (review.mode === "self") {
    const pr = review.prNumber || review.openedPrNumber;
    return (
      <header className="bg-surface">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-2 px-[clamp(16px,3vw,32px)] pt-[22px] pb-1">
          <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1.5 text-[13px] text-fg-2">
            <span className="inline-flex h-6 items-center gap-[5px] rounded-full bg-accent-soft px-2.5 text-[12.5px] font-semibold text-accent">
              <Sym name="rate_review" size={15} />
              Self-review · run {review.runNumber}
            </span>
            <span className="font-mono text-[12.5px]">{review.repo}</span>
            {chips}
            {review.dirtyFiles > 0 && (
              <span className="text-warn">
                + {review.dirtyFiles} uncommitted {review.dirtyFiles === 1 ? "file" : "files"}
              </span>
            )}
            <span className="font-mono text-[12.5px]">
              <span className="text-add">+{review.additions.toLocaleString()}</span> <span className="text-del">−{review.deletions.toLocaleString()}</span>
            </span>
            <span>{review.changedFiles} {review.changedFiles === 1 ? "file" : "files"}</span>
            {pr ? (
              <a href={`https://github.com/${review.repo}/pull/${pr}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[12.5px] text-fg-2">
                #{pr}
                <Sym name="open_in_new" size={15} />
              </a>
            ) : (
              <span className="text-fg-3">No PR yet</span>
            )}
          </div>
          <h1 className="m-0 text-[clamp(20px,2.2vw,25px)] leading-[1.3] font-semibold tracking-[-0.01em] text-pretty">{review.title}</h1>
        </div>
      </header>
    );
  }
  return (
    <header className="bg-surface">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-2 px-[clamp(16px,3vw,32px)] pt-[22px] pb-1">
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1.5 text-[13px] text-fg-2">
          <a href={review.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[12.5px] text-fg-2">
            {review.repo} <span className="text-fg">#{review.prNumber}</span>
            <Sym name="open_in_new" size={15} />
          </a>
          <span>
            by <span className="font-medium text-fg">{review.author}</span>
          </span>
          {chips}
          <span className="font-mono text-[12.5px]">
            <span className="text-add">+{review.additions.toLocaleString()}</span> <span className="text-del">−{review.deletions.toLocaleString()}</span>
          </span>
          <span>{review.changedFiles} {review.changedFiles === 1 ? "file" : "files"}</span>
          <span className="font-mono text-[12.5px] text-fg-3">@ {review.headSha.slice(0, 8)}</span>
          {review.parentReviewId && (
            <button
              onClick={() => navigate(`/review/${review.parentReviewId}`)}
              className="cursor-pointer rounded-full border-0 bg-accent-soft px-2.5 py-0.5 text-[12px] font-medium text-accent hover:bg-accent-soft-2"
            >
              Re-review · see previous
            </button>
          )}
        </div>
        <h1 className="m-0 text-[clamp(20px,2.2vw,25px)] leading-[1.3] font-semibold tracking-[-0.01em] text-pretty">{review.title}</h1>
      </div>
    </header>
  );
}

function Reviewing({ review, lines, onCancel }: { review: ReviewDetail; lines: ProgressLine[]; onCancel: () => void }) {
  const agent = useAgentLabel();
  const { wide, mid } = useLayout();
  const [cancelling, setCancelling] = useState(false);
  const started = review.runs.filter((r) => r.kind === "review").at(-1)?.startedAt;
  return (
    <div className="grid items-start gap-5" style={{ gridTemplateColumns: wide || mid ? "minmax(0,1fr) 340px" : "minmax(0,1fr)" }}>
      <div className="flex min-w-0 flex-col gap-3">
        <ProgressFeed title={review.mode === "self" && review.runNumber > 1 ? `Re-running the review (run ${review.runNumber + 1})` : "In-depth review in progress"} lines={lines} active />
        <p className="m-0 px-1 text-[13px] leading-[1.55] text-pretty text-fg-3">
          {agent} is reading {review.mode === "self" ? "a snapshot of your change" : "the checked-out PR"}
          {review.stack.length ? " and its stack neighbours" : ""} with read-only access. Big changes can take 5–15 minutes. You can leave this page; it keeps
          running.
        </p>
      </div>
      <aside className="flex min-w-0 flex-col gap-4">
        {review.recon && review.recon.focusPoints.length > 0 && (
          <section className={`${card} px-[22px] py-5`}>
            <h2 className={`${cardLabel} mb-3`}>While you wait: where to look</h2>
            <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
              {review.recon.focusPoints.map((f, i) => (
                <li key={i} className="flex gap-2.5 text-[13.5px] leading-normal">
                  <span className="grid size-5 flex-none place-items-center rounded-[5px] bg-accent-soft font-mono text-[11px] font-medium text-accent">{i + 1}</span>
                  <span>
                    <Inline text={f} />
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
        {started && (
          <button
            onClick={() => {
              setCancelling(true);
              onCancel();
            }}
            disabled={cancelling}
            className="h-9 cursor-pointer self-start rounded-lg border border-line bg-transparent px-3 text-[13px] text-fg-2 hover:border-del hover:text-del disabled:opacity-50"
          >
            {cancelling ? "Cancelling…" : "Cancel review"}
          </button>
        )}
      </aside>
    </div>
  );
}

function Failed({ review, lines, onRetry }: { review: ReviewDetail; lines: ProgressLine[]; onRetry: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false);
  if (review.turnLimit) return <TurnLimitCard review={review} stop={review.turnLimit} lines={lines} onRetry={onRetry} />;
  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      <section className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-del-soft-2 bg-del-soft px-5 py-4">
        <div className="min-w-0">
          <p className="m-0 flex items-center gap-1.5 text-[14.5px] font-semibold text-del">
            <Sym name="error" size={20} />
            This step failed
          </p>
          <p className="mt-1.5 mb-0 font-mono text-[12.5px] whitespace-pre-wrap text-fg-2">{review.error}</p>
        </div>
        <button
          onClick={async () => {
            setRetrying(true);
            try {
              await onRetry();
            } finally {
              setRetrying(false);
            }
          }}
          disabled={retrying}
          className="h-10 flex-none cursor-pointer rounded-lg border border-line-strong bg-surface px-4 text-[13.5px] font-medium hover:bg-hover disabled:opacity-50"
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </section>
      {lines.length > 0 && <ProgressFeed title="What happened" lines={lines} active={false} />}
      <RunMeta runs={review.runs} />
    </div>
  );
}

/** A step that stopped at its turn cap: resume it with more turns, optionally raising the default. */
function TurnLimitCard({ review, stop, lines, onRetry }: { review: ReviewDetail; stop: TurnLimitStop; lines: ProgressLine[]; onRetry: () => Promise<void> }) {
  const agent = useAgentLabel();
  const what = stop.stage === "recon" ? "overview" : "deep review";
  const used = stop.limit ?? stop.defaultLimit;
  const [turns, setTurns] = useState(stop.stage === "recon" ? stop.defaultLimit : Math.max(50, Math.round(used / 2)));
  const [raise, setRaise] = useState(false);
  const [busy, setBusy] = useState<"continue" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = Number.isInteger(turns) && turns >= 1 && turns <= 1000;
  const suggested = used + turns;
  const canRaise = valid && suggested > stop.defaultLimit;

  const run = async (kind: "continue" | "retry", fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      <section className="flex flex-col gap-4 rounded-xl border border-warn-soft bg-warn-soft px-5 py-4">
        <div>
          <p className="m-0 flex items-center gap-1.5 text-[14.5px] font-semibold">
            <Sym name="hourglass_bottom" size={20} className="text-warn" />
            {agent} ran out of turns
          </p>
          <p className="mt-1.5 mb-0 text-[14px] leading-normal text-fg-2">
            It used {stop.limit ? `all ${stop.limit}` : "all"} of its turns before finishing the {what}
            {stop.stage === "recon" ? ", usually because its answer kept missing a required field" : ""}. You can let it pick up where it stopped, or start over.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
          <label className="flex items-center gap-2 text-[13.5px] text-fg-2">
            Continue with
            <input
              type="number"
              min={1}
              max={1000}
              value={turns}
              onChange={(e) => setTurns(Number(e.target.value))}
              className={`h-10 w-[76px] px-2.5 text-right font-mono text-[14px] text-fg ${field}`}
            />
            more turns
          </label>
          <button
            onClick={() => run("continue", () => api.continueRun(review.id, turns, raise && canRaise ? suggested : undefined))}
            disabled={!valid || busy !== null}
            className="h-10 cursor-pointer rounded-lg border-0 bg-accent px-4 text-[14px] font-semibold text-on-accent disabled:cursor-default disabled:opacity-50"
          >
            {busy === "continue" ? "Continuing…" : "Continue →"}
          </button>
          <button
            onClick={() => run("retry", onRetry)}
            disabled={busy !== null}
            className="h-10 cursor-pointer rounded-lg border border-line-strong bg-surface px-4 text-[13.5px] font-medium hover:bg-hover disabled:opacity-50"
          >
            {busy === "retry" ? "Starting over…" : "Start over"}
          </button>
        </div>
        {canRaise && (
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg-2">
            <input type="checkbox" checked={raise} onChange={(e) => setRaise(e.target.checked)} className="size-4 accent-[var(--accent)]" />
            Also raise the default {what} turn limit from {stop.defaultLimit} to {suggested}
          </label>
        )}
        {error && <p className="m-0 text-[13px] text-del">{error}</p>}
      </section>
      {lines.length > 0 && <ProgressFeed title="What happened" lines={lines} active={false} />}
      <RunMeta runs={review.runs} />
    </div>
  );
}

/** What the bunny says about this review: how a self-review stands, or what you posted. */
function reviewMood(review: ReviewDetail, go: (t: Tab) => void): MoodReport | null {
  const done = review.phase === "walkthrough" || review.phase === "submitted";
  if (review.mode === "self") {
    if (!done) return null;
    const open = review.findings.filter((f) => f.resolvedRun == null && f.decision !== "dismissed");
    if (open.length) {
      const still = open.filter((f) => f.stillOpenRun === review.runNumber).length;
      const say = still && review.runNumber > 1 ? `${still} still open after run ${review.runNumber}. So close.` : `${open.length} ${open.length === 1 ? "thing" : "things"} to fix before you open the PR.`;
      return { mood: "issues", say, go: () => go("findings") };
    }
    const fixed = review.findings.some((f) => f.resolvedRun != null);
    return { mood: fixed ? "fixed" : "clean", go: () => go("submit") };
  }
  const pr = `#${review.prNumber}`;
  if (review.postedEvent === "REQUEST_CHANGES") return { mood: "rejected", say: `Changes requested on ${pr}.`, go: () => go("status") };
  if (review.postedEvent === "APPROVE") return { mood: "approved", say: `Approved ${pr}.`, go: () => go("status") };
  if (review.postedEvent === "COMMENT") return { mood: "commented", say: `Review posted on ${pr}.`, go: () => go("status") };
  return null;
}
