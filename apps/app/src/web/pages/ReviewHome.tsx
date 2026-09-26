import { useEffect, useState } from "react";
import type { ActiveRun, Inbox, ReviewSummary, SelfSources, StackSummary } from "../../shared/types";
import { api, elapsed, navigate, savePos, useAsync, useNow } from "../api";
import { Page } from "../components/Page";
import { PrSearch } from "../components/PrSearch";
import { field, Link, plain, Spinner, Sym, timeAgo } from "../components/ui";
import { latestPerPr, nextStep, openReviews, outcome, shortRef } from "../reviewState";
import { BUNNY_FACES } from "../components/Bunny";
import { BunnyFace, ConfirmPop, CONFIRM_AFTER_MS, GreySpinner, useToast } from "../components/Tidy";

type AsyncInbox = { data?: Inbox; error?: string; loading: boolean };
const parse = (t: string) => Date.parse(t.includes("T") ? t : `${t.replace(" ", "T")}Z`);

/** Review: start one, see what's in progress, check your own branches, and what finished today. */
export function ReviewHome({ inbox, repo, onRepo, runs }: { inbox: AsyncInbox; repo: string | null; onRepo: (r: string) => void; runs: ActiveRun[] }) {
  const reviews = useAsync(api.reviews, []);
  const stacks = useAsync(api.stacks, []);
  const sources = useAsync(() => (repo ? api.selfSources(repo) : Promise.resolve(null)), [repo]);
  // Refresh the cards when a run starts or finishes.
  const runKey = runs.map((r) => `${r.reviewId}:${r.stage}`).join(",");
  useEffect(() => {
    reviews.reload();
    sources.reload();
    stacks.reload();
  }, [runKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = reviews.data ?? [];
  const active = openReviews(all, 7).sort((a, b) => {
    const ra = runs.some((r) => r.reviewId === a.id) ? 1 : 0;
    const rb = runs.some((r) => r.reviewId === b.id) ? 1 : 0;
    return rb - ra || parse(b.updatedAt) - parse(a.updatedAt);
  });
  const dayAgo = Date.now() - 86_400_000;
  const finished = all.filter((r) =>
    r.mode === "self" ? r.openedPrNumber != null && parse(r.updatedAt) > dayAgo : r.submittedAt != null && parse(r.submittedAt) > dayAgo,
  );

  // ---------- remove / clear (local only; Undo brings them back) ----------
  const [toast, showToast] = useToast();
  const [askClear, setAskClear] = useState(false);
  // Posted, failed and stopped. Anything with findings still to decide stays.
  const clearable = latestPerPr(all).filter(
    (r) => !runs.some((x) => x.reviewId === r.id) && (r.phase === "submitted" || r.phase === "failed" || r.phase === "cancelled" || (r.mode === "self" && r.openedPrNumber != null)),
  );
  const remove = async (ids: number[], msg: string) => {
    try {
      const { cleared } = await api.clearReviews(ids);
      reviews.reload();
      showToast({
        msg,
        undo: async () => {
          await api.restoreReviews(cleared);
          reviews.reload();
        },
      });
    } catch (e) {
      showToast({ msg: e instanceof Error ? e.message : String(e) });
    }
  };
  const clearAll = () => {
    setAskClear(false);
    const ids = clearable.map((r) => r.id);
    remove(ids, `Cleared ${ids.length} finished ${ids.length === 1 ? "review" : "reviews"}`);
  };

  return (
    <Page gap={44}>
      <PrSearch inbox={inbox} repo={repo} onRepo={onRepo} reviews={all} title="Start a review" />

      {active.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="m-0 text-[15px] font-semibold">In progress</h2>
            <span className="flex items-baseline gap-3 text-[13px] text-fg-3">
              {active.length} open
              {clearable.length > 0 && (
                <span className="relative">
                  <button
                    onClick={() => setAskClear(true)}
                    className="cursor-pointer border-0 bg-transparent p-0 text-[13px] font-medium text-fg-2 underline decoration-line-strong underline-offset-[3px] hover:text-fg"
                  >
                    Clear all finished
                  </button>
                  {askClear && (
                    <ConfirmPop
                      title={`Clear ${clearable.length} finished ${clearable.length === 1 ? "review" : "reviews"}?`}
                      body="Posted, failed and stopped. Anything with findings to decide stays. Comments on GitHub aren't touched."
                      cancel="Cancel"
                      confirm={`Clear ${clearable.length}`}
                      onConfirm={clearAll}
                      onClose={() => setAskClear(false)}
                    />
                  )}
                </span>
              )}
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
            {active.slice(0, 8).map((r) => (
              <ActiveCard
                key={r.id}
                review={r}
                run={runs.find((x) => x.reviewId === r.id)}
                onRemove={(running) => remove([r.id], running ? "Stopped and removed" : "Removed")}
                onChanged={() => reviews.reload()}
                toast={showToast}
              />
            ))}
          </div>
        </section>
      )}

      {(stacks.data ?? []).length > 0 && <Stacks stacks={stacks.data!} />}

      {repo && <YourBranches repo={repo} sources={sources} />}

      {finished.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="m-0 text-[15px] font-semibold">Finished in the last day</h2>
            <Link to="/analytics" className="text-[13px]">All history</Link>
          </div>
          <ul className="m-0 list-none p-0">
            {finished.map((r) => {
              const o = outcome(r);
              return (
                <li key={r.id} className="group flex items-center border-t border-line">
                  <Link to={`/review/${r.id}`} className="flex min-h-12 min-w-0 flex-1 items-center gap-4 px-1 py-2.5 text-fg hover:text-accent hover:no-underline">
                    <span className="min-w-0 flex-1 truncate text-[14px]">{r.title}</span>
                    <span className="flex-none font-mono text-[12px] text-fg-3">{shortRef(r)}</span>
                    <span className="flex-none text-[12.5px]" style={{ color: o.color }}>{o.text}</span>
                    <span className="w-14 flex-none text-right text-[12.5px] text-fg-3">{timeAgo(r.submittedAt ?? r.updatedAt)}</span>
                  </Link>
                  {/* Removes it from these lists only: the review on GitHub stays. */}
                  <button
                    title="Remove from the list"
                    aria-label="Remove from the list"
                    onClick={() => remove([r.id], "Removed")}
                    className="ml-1 grid size-7 flex-none cursor-pointer place-items-center rounded-[7px] border border-transparent bg-transparent text-fg-3 opacity-0 group-hover:opacity-100 hover:border-del hover:bg-del-soft hover:text-del focus-visible:opacity-100"
                  >
                    <Sym name="close" size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {toast}
    </Page>
  );
}

/**
 * A review in progress. Running: a stop button shows on hover or focus (S), and the confirm replaces
 * the footer in place. Stopped: Resume or clear (×). Any card: ⌫ or × removes it, with Undo.
 */
function ActiveCard({
  review: r,
  run,
  onRemove,
  onChanged,
  toast,
}: {
  review: ReviewSummary;
  run?: ActiveRun;
  onRemove: (running: boolean) => void;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>[1];
}) {
  const s = nextStep(r, run);
  const now = useNow(s.running);
  const [ask, setAsk] = useState<"stop" | "remove" | null>(null);
  const [stoppingAt, setStoppingAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const stopped = r.phase === "cancelled";
  useEffect(() => {
    if (!s.running) setStoppingAt(null);
  }, [s.running]);
  const stopping = s.running && stoppingAt != null;

  const go = () => {
    if (ask) return;
    savePos(r.id, { tab: s.tab });
    navigate(`/review/${r.id}`);
  };
  const stop = async () => {
    setAsk(null);
    setStoppingAt(Date.now());
    try {
      await api.cancel(r.id);
    } catch (e) {
      setStoppingAt(null);
      toast({ msg: e instanceof Error ? e.message : String(e) });
    }
  };
  const requestStop = () => {
    if (!s.running || stopping) return;
    if (run && Date.now() - Date.parse(run.startedAt) < CONFIRM_AFTER_MS) {
      stop().then(() => toast({ msg: "Stopped", action: { label: "Start again", go: () => api.restart(r.id).then(onChanged, () => {}) } }));
    } else setAsk("stop");
  };
  const requestRemove = () => (s.running ? setAsk("remove") : onRemove(false));
  const resume = async () => {
    setBusy(true);
    try {
      if (r.hasOverview) await api.resume(r.id);
      else await api.restart(r.id);
      onChanged();
    } catch (e) {
      toast({ msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const status = stopping ? "Stopping…" : s.status;
  const color = stopping ? "var(--text-3)" : s.color;
  const iconBtn = "grid size-7 cursor-pointer place-items-center rounded-[7px] border border-line-strong bg-surface text-fg-2";

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") go();
        else if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey) requestStop();
        else if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          requestRemove();
        }
      }}
      className="group relative flex min-h-[204px] cursor-pointer flex-col gap-2 rounded-xl border border-line bg-surface px-[18px] py-4 text-left text-fg transition-[border-color,box-shadow] duration-[120ms] outline-none hover:border-line-strong hover:shadow-[0_6px_18px_oklch(0.2_0.02_80/0.08)] focus-visible:border-line-strong focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]"
    >
      <span className="flex items-center gap-[7px] pr-16 text-[12.5px] font-semibold" style={{ color: stopped ? "var(--text-2)" : color }}>
        {stopping ? <GreySpinner size={12} /> : s.running ? <Spinner size={12} /> : <span className="size-2 flex-none rounded-full" style={{ background: s.color }} />}
        <span>{status}</span>
        <span className="ml-auto font-normal text-fg-3 tabular-nums">{run ? elapsed(run.startedAt, now) : timeAgo(r.updatedAt)}</span>
      </span>
      {!ask && !stopping && (
        <span className="absolute top-[9px] right-[9px] flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 group-focus-visible:opacity-100">
          {s.running && (
            <button
              title="Stop review · S"
              aria-label="Stop review"
              onClick={(e) => {
                e.stopPropagation();
                requestStop();
              }}
              className={`${iconBtn} hover:border-del hover:bg-del-soft hover:text-del`}
            >
              <Sym name="stop" size={17} />
            </button>
          )}
          <button
            title={s.running ? "Stop and remove · ⌫" : "Remove · ⌫"}
            aria-label="Remove review"
            onClick={(e) => {
              e.stopPropagation();
              requestRemove();
            }}
            className={`${iconBtn} hover:border-del hover:bg-del-soft hover:text-del`}
          >
            <Sym name="close" size={17} />
          </button>
        </span>
      )}
      <span className={`line-clamp-2 text-[15px] leading-[1.35] font-medium text-pretty ${stopping ? "text-fg-2" : ""}`}>{r.title}</span>
      <span className="font-mono text-[12px] text-fg-3">
        {r.mode === "self" ? "Self-review · " : ""}
        {shortRef(r)} · {r.author}
      </span>
      <span className="mt-auto flex flex-col gap-2">
        {s.sub && <span className="text-[12.5px] text-fg-2">{s.sub}</span>}
        {s.bar != null && (
          <span className="block h-1 overflow-hidden rounded-sm bg-sunken">
            <span className="block h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.round(s.bar * 100)}%` }} />
          </span>
        )}
        {s.running && !ask && <span className="block truncate font-mono text-[12px] text-fg-2">{stopping ? "Waiting for the agent to stop" : (run?.lines.at(-1)?.text ?? "Starting…")}</span>}
        {ask === "stop" ? (
          <span className="flex items-center gap-1.5 border-t border-line pt-2.5" onClick={(e) => e.stopPropagation()}>
            <span className="min-w-0 flex-1 text-[12.5px] text-fg-2">{run?.stage === "recon" ? "Stop? Nothing is kept yet" : "Stop? The overview is kept"}</span>
            <CardButton onClick={() => setAsk(null)} autoFocus>
              No
            </CardButton>
            <CardButton danger onClick={stop}>
              Stop
            </CardButton>
          </span>
        ) : ask === "remove" ? (
          <span className="flex flex-col gap-2 border-t border-line pt-2.5" onClick={(e) => e.stopPropagation()}>
            <span className="flex gap-2">
              <BunnyFace face={BUNNY_FACES.wobbly} size={28} />
              <span className="text-[12.5px] leading-snug text-fg-2">
                <b className="font-semibold text-fg">Remove this review?</b> It's still running. We'll stop it first.
              </span>
            </span>
            <span className="flex justify-end gap-1.5">
              <CardButton onClick={() => setAsk(null)} autoFocus>
                Keep it
              </CardButton>
              <CardButton
                danger
                onClick={() => {
                  setAsk(null);
                  onRemove(true);
                }}
              >
                Stop and remove
              </CardButton>
            </span>
          </span>
        ) : stopped ? (
          <span className="flex items-center gap-2.5 border-t border-line pt-2.5 text-[13px]">
            <span className="min-w-0 flex-1 truncate text-fg-2">{s.detail}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                resume();
              }}
              disabled={busy}
              className="cursor-pointer border-0 bg-transparent p-0 text-[13px] font-semibold text-accent disabled:opacity-50"
            >
              {busy ? <Spinner size={12} /> : s.action}
            </button>
          </span>
        ) : (
          <span className="flex items-center justify-between gap-2 border-t border-line pt-2.5 text-[13px]">
            <span className="min-w-0 truncate text-fg-2">{s.detail}</span>
            <span className="inline-flex flex-none items-center gap-1 font-semibold text-accent">
              {s.action}
              <Sym name="arrow_forward" size={16} />
            </span>
          </span>
        )}
      </span>
    </div>
  );
}

function CardButton({ onClick, danger, autoFocus, children }: { onClick: () => void; danger?: boolean; autoFocus?: boolean; children: React.ReactNode }) {
  return (
    <button
      autoFocus={autoFocus}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`h-[26px] flex-none cursor-pointer rounded-md px-2 text-[12px] font-medium ${danger ? "border-0 bg-del text-on-accent" : "border border-line-strong bg-surface text-fg hover:bg-hover"}`}
    >
      {children}
    </button>
  );
}

// ---------- your branches ----------

function YourBranches({ repo, sources }: { repo: string; sources: { data?: SelfSources | null; loading: boolean; error?: string } }) {
  const s = sources.data;
  const [picker, setPicker] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const start = async (key: string, input: Parameters<typeof api.startSelf>[0], tab: "overview" | "findings" | "submit" = "overview") => {
    setStarting(key);
    setError(null);
    try {
      const { id } = await api.startSelf(input);
      savePos(id, { tab });
      navigate(`/review/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(null);
    }
  };

  // Branches first (with their PR if any), then your PRs whose branch isn't in this checkout.
  const rows = [
    ...(s?.branches ?? []).map((b) => {
      const kind = b.pr ? (b.pr.isDraft ? "Draft" : "PR") : b.pushed ? "Pushed" : "Local";
      const meta = b.pr
        ? `${b.name} · ${timeAgo(b.updatedAt)}`
        : b.pushed
          ? `No PR yet · pushed ${timeAgo(b.updatedAt)}`
          : `${b.ahead} ${b.ahead === 1 ? "commit" : "commits"} ahead${b.current && b.dirtyFiles ? ` · ${b.dirtyFiles} uncommitted files` : " · not pushed"}`;
      return { key: `b:${b.name}`, kind, ref: b.pr ? `#${b.pr.number}` : b.name, title: b.title, meta, review: b.review, start: () => start(`b:${b.name}`, { localPath: s!.localPath!, branch: b.name, includeDirty: b.current }) };
    }),
    ...(s?.prs ?? [])
      .filter((p) => !(s?.branches ?? []).some((b) => b.name === p.headRefName))
      .map((p) => ({
        key: `p:${p.number}`,
        kind: p.isDraft ? "Draft" : "PR",
        ref: `#${p.number}`,
        title: p.title,
        meta: `${p.headRefName} · ${timeAgo(p.updatedAt)}`,
        review: p.review,
        start: () => start(`p:${p.number}`, { repo, pr: p.number }),
      })),
  ];

  const pill = (review: (typeof rows)[number]["review"]) => {
    if (!review) return { text: "Not reviewed", cls: "bg-sunken text-fg-3" };
    if (review.phase === "failed") return { text: "Failed", cls: "bg-del-soft text-del" };
    if (review.phase !== "walkthrough") return { text: "Reviewing", cls: "bg-accent-soft text-accent" };
    if (review.openedPrNumber) return { text: `Opened #${review.openedPrNumber}`, cls: "bg-add-soft text-add" };
    if (review.findingsOpen === 0) return { text: "Ready", cls: "bg-add-soft text-add" };
    return { text: `Run ${review.runNumber} · ${review.findingsOpen} open`, cls: "bg-warn-soft text-warn" };
  };

  const copy = () => {
    try {
      navigator.clipboard?.writeText("bunny review");
    } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.5">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="m-0 text-[15px] font-semibold">Your branches</h2>
          <span className="text-[13px] text-fg-3">Check your own work before anyone else sees it</span>
        </div>
        <button
          onClick={() => setPicker(!picker)}
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium text-fg hover:bg-hover"
        >
          <Sym name={picker ? "close" : "add"} />
          Review a branch or PR
        </button>
      </div>

      {picker && s && <Picker sources={s} busy={starting != null} onStart={(input) => start("picker", input)} onCancel={() => setPicker(false)} />}
      {error && <p className="m-0 text-[13.5px] text-del">{error}</p>}

      {sources.loading && !s ? (
        <p className="m-0 flex items-center gap-2 rounded-xl border border-dashed border-line-strong p-[18px] text-[14px] text-fg-3">
          <Spinner size={12} /> Looking for your branches…
        </p>
      ) : s && !s.localPath && rows.length === 0 ? (
        <p className="m-0 rounded-xl border border-dashed border-line-strong p-[18px] text-[14px] text-fg-3">
          No checkout of {repo} found in your usual code folders. Run <span className="font-mono text-fg-2">bunny review</span> inside one and it'll be remembered.
        </p>
      ) : rows.length === 0 ? (
        <p className="m-0 rounded-xl border border-dashed border-line-strong p-[18px] text-[14px] text-fg-3">No branches or PRs of yours in {repo}.</p>
      ) : (
        <ul className="m-0 list-none overflow-hidden rounded-xl border border-line bg-surface p-0">
          {rows.map((y, i) => {
            const p = pill(y.review);
            const s2 = y.review;
            return (
              <li key={y.key} className={i ? "border-t border-line" : ""}>
                <button
                  onClick={() => {
                    if (!s2) return y.start();
                    const tab = s2.phase === "walkthrough" ? (s2.findingsOpen === 0 ? "submit" : "findings") : "overview";
                    savePos(s2.id, { tab });
                    navigate(`/review/${s2.id}`);
                  }}
                  disabled={starting != null}
                  className="flex min-h-[72px] w-full cursor-pointer items-center gap-4 border-0 bg-transparent px-[18px] py-3.5 text-left text-fg hover:bg-hover"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="flex min-w-0 items-center gap-2 text-[15px] font-medium">
                      <span className="flex-none rounded border border-line bg-sunken px-1.5 py-px text-[11px] font-semibold text-fg-3">{y.kind}</span>
                      <span className="truncate">{y.title}</span>
                    </span>
                    <span className="truncate font-mono text-[12px] text-fg-3">
                      {y.ref} · {y.meta}
                    </span>
                  </span>
                  <span className={`flex-none rounded-full px-2.5 py-[3px] text-[12.5px] font-medium ${p.cls}`}>{p.text}</span>
                  {starting === y.key ? <Spinner size={18} /> : <Sym name="arrow_forward" size={20} className="text-fg-3" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-1 text-[12.5px] text-fg-3">
        <span>From a terminal, in any checkout:</span>
        <button
          onClick={copy}
          title="Copy"
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-sunken px-2 font-mono text-[12px] text-fg hover:border-line-strong"
        >
          bunny review
          <Sym name={copied ? "check" : "content_copy"} size={14} className="text-fg-3" />
        </button>
        <span>
          opens it here. Add <span className="font-mono text-fg-2">--pr {s?.prs[0]?.number ?? 123}</span> for a PR.
        </span>
      </div>
    </section>
  );
}

function Picker({
  sources: s,
  busy,
  onStart,
  onCancel,
}: {
  sources: SelfSources;
  busy: boolean;
  onStart: (input: Parameters<typeof api.startSelf>[0]) => void;
  onCancel: () => void;
}) {
  const [src, setSrc] = useState<"local" | "pr">(s.localPath && s.branches.length ? "local" : "pr");
  const current = s.branches.find((b) => b.current) ?? s.branches[0];
  const [branch, setBranch] = useState(current?.name ?? "");
  const [base, setBase] = useState(s.defaultBase);
  const [dirty, setDirty] = useState(true);
  const [pr, setPr] = useState(s.prs[0]?.number ?? 0);
  const picked = s.branches.find((b) => b.name === branch);
  const canDirty = Boolean(picked?.current);
  const dirtyNote = !canDirty
    ? "Only the checked-out branch has a working tree to include"
    : picked!.dirtyFiles
      ? `${picked!.dirtyFiles} ${picked!.dirtyFiles === 1 ? "file" : "files"} changed in your working tree`
      : "Working tree is clean";
  const useDirty = dirty && canDirty;
  const cli = src === "pr" ? `bunny review --pr ${pr}` : `bunny review ${branch}${base !== s.defaultBase ? ` --base ${base}` : ""}${useDirty ? "" : " --committed"}`;
  const seg = (on: boolean) => (on ? "bg-surface text-fg shadow-seg" : "bg-transparent text-fg-3");

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-accent bg-surface p-[18px] shadow-[0_0_0_3px_var(--accent-soft)]">
      <div role="group" aria-label="Source" className="flex gap-0.5 self-start rounded-lg border border-line bg-sunken p-0.5">
        {(
          [
            ["local", "Local branch"],
            ["pr", "Pull request"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            onClick={() => setSrc(k)}
            aria-pressed={src === k}
            disabled={k === "local" ? !s.localPath : !s.prs.length}
            className={`h-8 cursor-pointer rounded-md border-0 px-3 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40 ${seg(src === k)}`}
          >
            {l}
          </button>
        ))}
      </div>
      {src === "local" ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
            <label className="flex flex-col gap-1.5 text-[12.5px] font-semibold text-fg-3">
              Branch
              <select value={branch} onChange={(e) => setBranch(e.target.value)} className={`h-11 px-3 font-mono text-[13px] font-normal text-fg ${field}`}>
                {s.branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name} · {b.ahead} ahead{b.current && b.dirtyFiles ? ` · ${b.dirtyFiles} uncommitted` : ""}
                    {b.pr ? ` · #${b.pr.number}` : b.pushed ? " · pushed" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-[12.5px] font-semibold text-fg-3">
              Compare against
              <select value={base} onChange={(e) => setBase(e.target.value)} className={`h-11 px-3 font-mono text-[13px] font-normal text-fg ${field}`}>
                {s.bases.filter((b) => b !== branch).map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            onClick={() => canDirty && setDirty(!dirty)}
            role="switch"
            aria-checked={useDirty}
            disabled={!canDirty}
            className="flex min-h-11 cursor-pointer items-center gap-3 self-start border-0 bg-transparent p-0 text-left disabled:cursor-default"
          >
            <span className={`relative h-[22px] w-10 flex-none rounded-full transition-colors ${useDirty ? "bg-accent" : "bg-line-strong"}`}>
              <span className="absolute top-[3px] size-4 rounded-full bg-surface transition-[left]" style={{ left: useDirty ? 21 : 3 }} />
            </span>
            <span className="flex flex-col">
              <span className={`text-[14px] font-medium ${canDirty ? "" : "text-fg-3"}`}>Include uncommitted changes</span>
              <span className="text-[12.5px] text-fg-3">{dirtyNote}</span>
            </span>
          </button>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1.5 text-[12.5px] font-semibold text-fg-3">
            Your pull requests
            <select value={pr} onChange={(e) => setPr(Number(e.target.value))} className={`h-11 px-3 text-[14px] font-normal text-fg ${field}`}>
              {s.prs.map((p) => (
                <option key={p.number} value={p.number}>
                  #{p.number} · {p.isDraft ? "Draft" : "Open"} · {p.title}
                </option>
              ))}
            </select>
          </label>
          <p className="m-0 text-[12.5px] text-fg-3">Checked out read-only through gh. Nothing is posted to the PR.</p>
        </>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          onClick={() => onStart(src === "pr" ? { repo: s.repo, pr } : { localPath: s.localPath!, branch, base, includeDirty: useDirty })}
          disabled={busy || (src === "local" ? !branch : !pr)}
          className="h-11 cursor-pointer rounded-lg border-0 bg-accent px-4 text-[14px] font-semibold text-on-accent disabled:opacity-60"
        >
          {busy ? "Starting…" : "Start self-review"}
        </button>
        <button onClick={onCancel} className="h-11 cursor-pointer border-0 bg-transparent px-3 text-[14px] text-fg-2">
          Cancel
        </button>
        <span className="ml-auto font-mono text-[12px] text-fg-3">$ {cli}</span>
      </div>
    </div>
  );
}

const STACK_SEG: Record<string, string> = {
  waiting: "var(--line)",
  scanning: "var(--accent-soft-2)",
  readable: "var(--accent-soft-2)",
  reviewing: "var(--accent)",
  decide: "var(--warn)",
  changed: "var(--warn)",
  submitted: "var(--add)",
  approved: "var(--add)",
  failed: "var(--del)",
  merged: "var(--line-strong)",
  skipped: "var(--line-strong)",
  stopped: "var(--line-strong)",
};

/** Stack reviews in progress: reviewed together, posted as one review per PR. */
function Stacks({ stacks }: { stacks: StackSummary[] }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="m-0 text-[15px] font-semibold">Stacks</h2>
          <span className="text-[13px] text-fg-3">Reviewed together, posted as one review per PR</span>
        </div>
        <span className="text-[13px] text-fg-3">{stacks.length}</span>
      </div>
      {stacks.slice(0, 4).map((c) => {
        const color = c.running ? "var(--accent)" : c.states.some((x) => x === "failed") ? "var(--del)" : c.states.some((x) => x === "decide" || x === "changed") ? "var(--warn)" : "var(--add)";
        return (
          <button
            key={c.id}
            onClick={() => navigate(`/stack/${c.id}`)}
            className="flex w-full cursor-pointer flex-col gap-2.5 rounded-xl border border-line bg-surface px-[18px] py-4 text-left text-fg transition-[border-color,box-shadow] duration-100 hover:border-line-strong hover:shadow-[0_6px_18px_oklch(0.2_0.02_80/0.08)]"
          >
            <span className="flex items-center gap-[7px] text-[12.5px] font-semibold" style={{ color }}>
              {c.running ? <Spinner size={12} /> : <span className="size-2 flex-none rounded-full" style={{ background: color }} />}
              <span>{c.detail}</span>
              <span className="ml-auto font-normal text-fg-3">{timeAgo(c.updatedAt)}</span>
            </span>
            <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-[15px] font-medium">{plain(c.title)}</span>
              <span className="font-mono text-[12px] text-fg-3">
                {c.repo} · {c.baseRef} → {c.topRef} · {c.size} PRs
              </span>
            </span>
            <span className="flex h-1.5 max-w-[420px] gap-[3px]">
              {c.states.map((st, i) => (
                <span key={i} className="flex-1 rounded-[3px]" style={{ background: STACK_SEG[st] }} />
              ))}
            </span>
            <span className="flex items-center justify-end gap-2 border-t border-line pt-2.5 text-[13px]">
              <span className="inline-flex flex-none items-center gap-1 font-semibold text-accent">
                Open stack
                <Sym name="arrow_forward" size={16} />
              </span>
            </span>
          </button>
        );
      })}
    </section>
  );
}
