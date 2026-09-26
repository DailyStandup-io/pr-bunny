import { useEffect, useRef, useState } from "react";
import type { ActiveRun, Inbox, InboxEntry, SelfSources } from "../../shared/types";
import { api, navigate, savePos, useAsync } from "../api";
import { Page } from "../components/Page";
import { Spinner, Sym, timeAgo } from "../components/ui";
import { nextStep, openReviews, shortRef } from "../reviewState";
import { ReviewStackButton } from "../components/StackRail";
import { HiddenList, HideButton, InboxEmpty, InboxTabs, RowCheck, SelectionBar, useHidden, type HideMode } from "../components/InboxTools";
import { KeyHints, useToast } from "../components/Tidy";

type AsyncInbox = { data?: Inbox; error?: string; loading: boolean };

interface Row {
  key: string;
  kind?: string;
  title: string;
  /** Plain reason text, or split around a user chip. */
  reason: string;
  reasonColor?: string;
  user?: string;
  reasonPost?: string;
  repo?: string;
  meta: string;
  action: string;
  at: string;
  go: () => void;
  /** Part of a stack of open PRs: badge + "Review stack". */
  stack?: { repo: string; pr: number; pos: number; size: number };
  /** Hiding: `pr:owner/name#n`, `review:<id>` or `branch:owner/name:<branch>`, and when it last changed. */
  hideKey: string;
  stamp?: string;
  /** Set for a review you left open: ⌫ removes the review (with Undo) instead of hiding. */
  reviewId?: number;
}

const short = (repo: string) => repo.split("/")[1] ?? repo;
const DAY = 86_400_000;
const parse = (t: string) => Date.parse(t.includes("T") ? t : `${t.replace(" ", "T")}Z`);

/** Inbox: everything that's waiting on you, grouped by why. */
export function Home({ inbox, repo, runs }: { inbox: AsyncInbox; repo: string | null; runs: ActiveRun[] }) {
  const reviews = useAsync(api.reviews, []);
  const sources = useAsync(() => (repo ? api.selfSources(repo) : Promise.resolve(null)), [repo]);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<number>) => {
    setStarting(key);
    setError(null);
    try {
      navigate(`/review/${await fn()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(null);
    }
  };
  const open = (id: number, tab: ReturnType<typeof nextStep>["tab"]) => {
    savePos(id, { tab });
    navigate(`/review/${id}`);
  };

  // Review requested: assigned to you, not started (or the last attempt failed).
  const requested: Row[] = (inbox.data?.assigned ?? [])
    .filter((p) => !p.review || p.review.phase === "failed")
    .map((p: InboxEntry) => {
      const at = p.requestedAt ?? p.updatedAt;
      const old = Date.now() - parse(at) > DAY;
      // Its stack is running Review all, so the stack owns this PR's review: go there, don't start another.
      const owned = p.stack?.running && p.stack.stackId != null ? { ...p.stack, stackId: p.stack.stackId } : null;
      return {
        key: p.url,
        hideKey: `pr:${p.repo}#${p.number}`,
        stamp: p.updatedAt,
        kind: p.isDraft ? "Draft" : undefined,
        title: p.title,
        reason: p.requestedBy ? "Review requested by " : "Review requested ",
        user: p.requestedBy ?? undefined,
        reasonPost: ` ${timeAgo(at)}`,
        reasonColor: old ? "var(--warn)" : undefined,
        repo: p.repo,
        meta: `${short(p.repo)}#${p.number}`,
        action: owned ? `Reviewing in stack · ${owned.pos} of ${owned.size}` : "Start review",
        at,
        go: owned ? () => navigate(`/stack/${owned.stackId}`) : () => run(p.url, async () => (await api.start(p.url, p.repo)).id),
        stack: p.stack && !owned ? { repo: p.repo, pr: p.number, ...p.stack } : undefined,
      };
    });

  // Reviews you left open: peer reviews that aren't posted and aren't running.
  const all = reviews.data ?? [];
  const running = runs.filter((r) => r.mode === "peer");
  const left: Row[] = openReviews(all)
    .filter((r) => r.mode === "peer" && !runs.some((x) => x.reviewId === r.id) && !["recon_running", "reviewing", "read"].includes(r.phase))
    .map((r) => {
      const s = nextStep(r);
      return {
        key: `review:${r.id}`,
        hideKey: `review:${r.id}`,
        stamp: r.updatedAt,
        reviewId: r.id,
        title: r.title,
        reason: s.reason,
        reasonColor: r.phase === "failed" ? "var(--del)" : undefined,
        repo: r.repo,
        meta: `${shortRef(r)} · ${r.author} · ${timeAgo(r.updatedAt)}`,
        action: s.action,
        at: r.updatedAt,
        go: () => open(r.id, s.tab),
      };
    });

  const mine = yourWork(sources.data ?? null, (key, fn) => run(key, fn), open);

  // ---------- hide, select, remove (local only: nothing changes on GitHub) ----------
  const [toast, showToast] = useToast();
  const hidden = useHidden(showToast);
  const [tab, setTab] = useState<"inbox" | "hidden">("inbox");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const everyRow = [...requested, ...left, ...mine];
  // Rows hidden "until it changes" that have changed come back (and are forgotten).
  useEffect(() => {
    if (hidden.loaded) hidden.sweep(everyRow);
  }, [hidden.loaded, hidden.items.length, everyRow.map((r) => `${r.hideKey}@${r.stamp}`).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = [
    { label: "Review requested", sub: "Not started yet", rows: requested, note: null as string | null },
    {
      label: "Reviews you left open",
      sub: "Pick up where you stopped",
      rows: left,
      note: running.length ? `${shortRef(running[0]!)} is still running. It moves here when findings are ready.` : null,
    },
    { label: "Your work to check", sub: "Branches and drafts of yours", rows: mine, note: null },
  ]
    .map((g) => ({ ...g, rows: g.rows.filter((r) => !hidden.isHidden(r)) }))
    .filter((g) => g.rows.length || g.note);
  const n = groups.reduce((t, g) => t + g.rows.length, 0);
  const oldest = groups.flatMap((g) => g.rows).sort((a, b) => parse(a.at) - parse(b.at))[0];
  const loading = (inbox.loading && !inbox.data) || (reviews.loading && !reviews.data);

  const flat = groups.flatMap((g) => g.rows);
  const selected = flat.filter((r) => sel.has(r.key));
  const toggle = (key: string) =>
    setSel((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const hideRows = (rows: Row[], mode: HideMode) => {
    setSel(new Set());
    hidden.hide(rows, mode);
  };
  const removeReview = async (id: number) => {
    try {
      const { cleared } = await api.clearReviews([id]);
      reviews.reload();
      showToast({
        msg: "Removed",
        undo: async () => {
          await api.restoreReviews(cleared);
          reviews.reload();
        },
      });
    } catch (e) {
      showToast({ msg: e instanceof Error ? e.message : String(e) });
    }
  };
  // J/K move, X select, E hide until it changes, ⇧E for good, ⌫ remove (a review) or hide, Esc clears. Z (undo) is the toast's.
  const keysRef = useRef({ flat, focus, selected, tab, hideRows, removeReview, toggle });
  keysRef.current = { flat, focus, selected, tab, hideRows, removeReview, toggle };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { flat, focus, selected, tab, hideRows, removeReview, toggle } = keysRef.current;
      if (tab !== "inbox" || !flat.length) return;
      const i = Math.max(0, flat.findIndex((r) => r.key === focus));
      const cur = focus ? flat.find((r) => r.key === focus) : undefined;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") setFocus(flat[Math.min(flat.length - 1, focus ? i + 1 : 0)]!.key);
      else if (k === "k" || e.key === "ArrowUp") setFocus(flat[Math.max(0, i - 1)]!.key);
      else if (k === "x" && cur) toggle(cur.key);
      else if (k === "e") {
        const rows = selected.length ? selected : cur ? [cur] : [];
        if (!rows.length) return;
        hideRows(rows, e.shiftKey ? "good" : "change");
      } else if ((e.key === "Backspace" || e.key === "Delete") && (selected.length || cur)) {
        if (selected.length) hideRows(selected, "change");
        else if (cur!.reviewId) removeReview(cur!.reviewId);
        else hideRows([cur!], "change");
      } else if (e.key === "Escape") setSel(new Set());
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Page
      gap={40}
      title="On you"
      sub={
        loading
          ? "Checking what's waiting on you…"
          : n === 0
            ? "You're clear."
            : `${n} ${n === 1 ? "thing needs" : "things need"} you. Oldest is from ${oldest && Date.now() - parse(oldest.at) > DAY ? timeAgo(oldest.at) : "today"}.`
      }
    >
      <InboxTabs
        tab={tab}
        onTab={(t) => {
          setTab(t);
          setSel(new Set());
        }}
        counts={{ inbox: flat.length, hidden: hidden.items.length }}
      />
      {inbox.error && !inbox.data && <p className="m-0 text-[14px] text-del">{inbox.error}</p>}
      {error && <p className="m-0 text-[14px] text-del">{error}</p>}
      {tab === "inbox" && selected.length > 0 && <SelectionBar count={selected.length} onHide={(m) => hideRows(selected, m)} onClear={() => setSel(new Set())} />}

      {tab === "hidden" &&
        (hidden.items.length ? (
          <HiddenList items={hidden.items} onRestore={hidden.restore} />
        ) : (
          <InboxEmpty hiddenTab hiddenCount={0} onShowHidden={() => setTab("hidden")} />
        ))}

      {tab === "inbox" && groups.map((g) => (
        <section key={g.label} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="flex flex-wrap items-baseline gap-2.5">
              <h2 className="m-0 text-[15px] font-semibold">{g.label}</h2>
              <span className="text-[13px] text-fg-3">{g.sub}</span>
            </div>
            <span className="text-[13px] text-fg-3 tabular-nums">{g.rows.length || ""}</span>
          </div>
          {g.rows.length > 0 && (
            <ul className="m-0 list-none overflow-hidden rounded-xl border border-line bg-surface p-0">
              {g.rows.map((r, i) => (
                <li
                  key={r.key}
                  onMouseEnter={() => setFocus(r.key)}
                  className={`group relative flex flex-wrap items-center ${i ? "border-t border-line" : ""} ${sel.has(r.key) ? "bg-accent-soft" : focus === r.key ? "bg-hover" : ""}`}
                >
                  <RowCheck on={sel.has(r.key)} visible={sel.size > 0 || focus === r.key} onToggle={() => toggle(r.key)} />
                  <button
                    onClick={r.go}
                    onFocus={() => setFocus(r.key)}
                    disabled={starting != null}
                    className="flex min-h-[76px] min-w-0 flex-1 cursor-pointer items-center gap-4 border-0 bg-transparent py-3.5 pr-[18px] pl-2 text-left text-fg"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                      <span className="flex min-w-0 items-center gap-2 text-[15px] font-medium">
                        {r.kind && <span className="flex-none rounded border border-line bg-sunken px-1.5 py-px text-[11px] font-semibold text-fg-3">{r.kind}</span>}
                        <span className="truncate">{r.title}</span>
                        {r.stack && (
                          <span title="Part of a stack" className="inline-flex flex-none items-center gap-[3px] rounded bg-accent-soft px-1.5 py-px text-[11px] font-semibold text-accent">
                            <Sym name="stacks" size={13} />
                            {r.stack.pos} of {r.stack.size}
                          </span>
                        )}
                      </span>
                      <span className="text-[13.5px] leading-[1.45] text-pretty" style={{ color: r.reasonColor ?? "var(--text-2)" }}>
                        {r.reason}
                        {r.user && (
                          <span className="mx-px inline-flex items-center gap-[5px] align-bottom font-medium text-fg">
                            <Avatar login={r.user} size={18} round />
                            {r.user}
                          </span>
                        )}
                        {r.reasonPost}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5">
                        {r.repo && <Avatar login={r.repo.split("/")[0]!} size={16} title={r.repo} />}
                        <span className="truncate font-mono text-[12px] text-fg-3">{r.meta}</span>
                      </span>
                    </span>
                    <span className="inline-flex h-[34px] flex-none items-center gap-1 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium whitespace-nowrap">
                      {starting === r.key ? <Spinner /> : r.action}
                      <Sym name="arrow_forward" size={16} className="text-fg-3" />
                    </span>
                  </button>
                  {sel.size === 0 && (
                    <HideButton
                      onHide={(m) => hideRows([r], m)}
                      className={`my-1.5 mr-[18px] ${focus === r.key ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}
                    />
                  )}
                  {r.stack && (
                    <span className="my-1.5 mr-[18px] ml-auto">
                      <ReviewStackButton repo={r.stack.repo} pr={r.stack.pr} compact />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {g.note && (
            <button
              onClick={() => navigate("/review")}
              className="flex min-h-9 cursor-pointer items-center gap-2 self-start border-0 bg-transparent px-1 text-left text-[13px] text-fg-3 hover:text-fg"
            >
              <Spinner size={10} />
              <span>{g.note}</span>
            </button>
          )}
        </section>
      ))}
      {tab === "inbox" && !loading && groups.length === 0 && (
        <InboxEmpty hiddenTab={false} hiddenCount={hidden.items.length} onShowHidden={() => setTab("hidden")} />
      )}
      {tab === "inbox" && flat.length > 0 && (
        <KeyHints
          keys={[
            ["J K", "move"],
            ["X", "select"],
            ["E", "hide until it changes"],
            ["⇧E", "hide for good"],
            ["⌫", "remove or hide"],
            ["Z", "undo"],
            ["esc", "clear selection"],
          ]}
        />
      )}
      {toast}
    </Page>
  );
}

/** Your branches and PRs that still need a look before (or since) you opened them. */
function yourWork(
  s: SelfSources | null,
  start: (key: string, fn: () => Promise<number>) => void,
  open: (id: number, tab: ReturnType<typeof nextStep>["tab"]) => void,
): Row[] {
  if (!s) return [];
  const rows: Row[] = [];
  type Next = { reason: string; action: string; tab: ReturnType<typeof nextStep>["tab"] | null };
  const next = (review: SelfSources["branches"][number]["review"], fallback: string): Next | null => {
    if (!review) return { reason: fallback, action: "Check", tab: null };
    if (review.phase === "failed") return { reason: "The last self-review failed.", action: "Open", tab: "overview" };
    if (review.phase !== "walkthrough") return { reason: "Self-review in progress.", action: "Open", tab: "overview" };
    if (review.openedPrNumber && review.findingsOpen === 0) return null;
    if (review.findingsOpen === 0) return { reason: "All findings closed. Ready to open the PR.", action: "Open PR", tab: "submit" };
    return {
      reason: `${review.findingsOpen} ${review.findingsOpen === 1 ? "finding" : "findings"} still open after run ${review.runNumber}.`,
      action: "Continue",
      tab: "findings",
    };
  };
  for (const b of s.branches) {
    const kind = b.pr ? (b.pr.isDraft ? "Draft" : "PR") : b.pushed ? "Pushed" : "Local";
    const commits = `${b.ahead} ${b.ahead === 1 ? "commit" : "commits"}`;
    const fallback = b.pr ? `${commits} on this branch. Not checked yet.` : b.pushed ? "Pushed, no PR yet. Not checked yet." : `${commits}, not pushed. Not checked yet.`;
    const r = next(b.review, fallback);
    if (!r) continue;
    rows.push({
      key: `branch:${b.name}`,
      hideKey: `branch:${s.repo}:${b.name}`,
      stamp: b.updatedAt,
      kind,
      title: b.title,
      reason: r.reason,
      meta: `${b.pr ? `#${b.pr.number} · ` : ""}${b.name} · ${timeAgo(b.updatedAt)}${b.current && b.dirtyFiles ? ` · ${b.dirtyFiles} uncommitted` : ""}`,
      action: r.action,
      at: b.updatedAt,
      go: () =>
        b.review && r.tab
          ? open(b.review.id, r.tab)
          : start(`branch:${b.name}`, async () => (await api.startSelf({ localPath: s.localPath!, branch: b.name, includeDirty: b.current })).id),
    });
  }
  for (const p of s.prs.filter((p) => !s.branches.some((b) => b.name === p.headRefName))) {
    const r = next(p.review, "Not checked yet.");
    if (!r) continue;
    rows.push({
      key: `pr:${p.number}`,
      hideKey: `pr:${s.repo}#${p.number}`,
      stamp: p.updatedAt,
      kind: p.isDraft ? "Draft" : "PR",
      title: p.title,
      reason: r.reason,
      meta: `#${p.number} · ${p.headRefName} · ${timeAgo(p.updatedAt)}`,
      action: r.action,
      at: p.updatedAt,
      go: () => (p.review && r.tab ? open(p.review.id, r.tab) : start(`pr:${p.number}`, async () => (await api.startSelf({ repo: s.repo, pr: p.number })).id)),
    });
  }
  return rows.slice(0, 5);
}

/** GitHub avatar with the initial underneath, which shows until (or if) it loads. */
export function Avatar({ login, size, round = false, title }: { login: string; size: number; round?: boolean; title?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <span
      title={title}
      className={`relative grid flex-none place-items-center overflow-hidden bg-sunken font-semibold text-fg-3 shadow-[inset_0_0_0_1px_var(--line)] ${round ? "rounded-full" : "rounded"}`}
      style={{ width: size, height: size, fontSize: size * 0.56 }}
    >
      {login[0]?.toUpperCase()}
      <img
        src={`https://github.com/${login}.png?size=64`}
        alt=""
        onLoad={() => setOk(true)}
        className="absolute inset-0 size-full object-cover"
        style={{ opacity: ok ? 1 : 0 }}
      />
    </span>
  );
}
