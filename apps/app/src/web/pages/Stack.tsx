// A stack of PRs reviewed together (/stack/:id): the layers and Review all, one findings queue
// across the stack, and posting one GitHub review per PR. Each layer is still an ordinary review,
// reviewed against its own parent.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Finding, LayerState, ReviewDetail, ReviewEvent, Severity, StackDetail, StackFinding, StackLayer, StackSubmissionLayer } from "../../shared/types";
import { api, navigate, useCopy, useLayout, useNow } from "../api";
import { useBunnyMood, type MoodReport } from "../components/Bunny";
import { DISMISS_REASONS, SELF_REASONS, SEVERITY, Snippet } from "../components/Walkthrough";
import { Inline, Spinner, Sym, card, plain } from "../components/ui";
import { ConfirmPop } from "../components/Tidy";

/** m:ss for a duration in ms. */
const elapsedText = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

type Tab = "work" | "findings" | "submit";

const STATE: Record<LayerState, { label: string; icon?: string; color: string; bg: string; spin?: boolean }> = {
  waiting: { label: "Waiting", icon: "schedule", color: "var(--text-3)", bg: "var(--sunken)" },
  scanning: { label: "Scanning", color: "var(--accent)", bg: "var(--accent-soft)", spin: true },
  readable: { label: "Scanned", icon: "article", color: "var(--accent)", bg: "var(--accent-soft)" },
  reviewing: { label: "Deep review", color: "var(--accent)", bg: "var(--accent-soft)", spin: true },
  decide: { label: "Findings to decide", icon: "rule", color: "var(--warn)", bg: "var(--warn-soft)" },
  submitted: { label: "Posted", icon: "done", color: "var(--add)", bg: "var(--add-soft)" },
  approved: { label: "Approved", icon: "check_circle", color: "var(--add)", bg: "var(--add-soft)" },
  failed: { label: "Failed", icon: "error", color: "var(--del)", bg: "var(--del-soft)" },
  changed: { label: "Changed since review", icon: "update", color: "var(--warn)", bg: "var(--warn-soft)" },
  merged: { label: "Merged", icon: "merge", color: "var(--text-3)", bg: "var(--sunken)" },
  skipped: { label: "Skipped", icon: "do_not_disturb_on", color: "var(--text-3)", bg: "var(--sunken)" },
  stopped: { label: "Stopped", icon: "stop_circle", color: "var(--text-2)", bg: "var(--sunken)" },
};
const SEG: Record<LayerState, string> = {
  waiting: "var(--line)",
  scanning: "var(--accent-soft-2)",
  readable: "var(--accent-soft-2)",
  reviewing: "var(--accent)",
  decide: "var(--warn)",
  submitted: "var(--add)",
  approved: "var(--add)",
  failed: "var(--del)",
  changed: "var(--warn)",
  merged: "var(--line-strong)",
  skipped: "var(--line-strong)",
  stopped: "var(--line-strong)",
};
const KIND: Record<StackFinding["kind"], string> = { relies: "Relies on another layer", repeated: "Repeated across layers", fixed: "Fixed later in the stack", breaks: "Layers clash" };
const EVENTS: Array<{ key: ReviewEvent; label: string }> = [
  { key: "COMMENT", label: "Comment" },
  { key: "APPROVE", label: "Approve" },
  { key: "REQUEST_CHANGES", label: "Request changes" },
];
const RUNNING: LayerState[] = ["scanning", "readable", "reviewing"];

export function StackPage({ id }: { id: number }) {
  const [stack, setStack] = useState<StackDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("work");
  const [reviews, setReviews] = useState<Record<number, ReviewDetail>>({});
  const layout = useLayout();

  const load = async () => {
    try {
      setStack(await api.stack(id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // Poll: fast while anything runs, slowly otherwise (new commits on GitHub, other tabs).
  const busy = Boolean(stack && (stack.runState === "running" || stack.layers.some((l) => RUNNING.includes(l.state)) || stack.cross.state === "running"));
  useEffect(() => {
    load();
    const t = setInterval(load, busy ? 2500 : 10_000);
    return () => clearInterval(t);
  }, [id, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  // The findings queue needs each reviewed layer's findings; reload them when a layer's review moves on.
  const reviewKey = stack?.layers.map((l) => `${l.reviewId}:${l.state}:${l.decided}`).join(",") ?? "";
  const crossKey = stack?.cross.findings.map((f) => `${f.id}:${f.decision}`).join(",") ?? "";
  const loadReviews = async () => {
    if (!stack) return;
    const ids = stack.layers.filter((l) => l.reviewId && !["waiting", "scanning", "readable", "reviewing"].includes(l.state)).map((l) => l.reviewId!);
    const got = await Promise.all(ids.map((r) => api.review(r).catch(() => null)));
    setReviews(Object.fromEntries(got.filter(Boolean).map((r) => [r!.id, r!])));
  };
  useEffect(() => {
    loadReviews();
  }, [reviewKey, crossKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useBunnyMood(stack ? stackMood(stack, setTab) : null);

  if (error && !stack) return <Centered>{error}</Centered>;
  if (!stack) return <Centered><Spinner size={20} /></Centered>;

  const layers = stack.layers;
  const active = layers.filter((l) => !l.skipped && l.state !== "merged");
  const reviewed = active.filter((l) => ["decide", "submitted", "approved", "changed"].includes(l.state)).length;
  const top = layers[layers.length - 1];
  const totalFindings = active.reduce((n, l) => n + l.total, 0) + stack.cross.findings.length;
  const decidedFindings = active.reduce((n, l) => n + l.decided, 0) + stack.cross.findings.filter((f) => f.decision).length;
  const anyPostable = active.some((l) => !l.mine && l.state === "decide");
  const tabs: Array<{ key: Tab; label: string; enabled: boolean; done: boolean; loading?: boolean; badge?: string }> = [
    { key: "work", label: "Layers", enabled: true, done: reviewed === active.length && active.length > 0, loading: busy },
    { key: "findings", label: "Findings", enabled: reviewed > 0, done: totalFindings > 0 && decidedFindings === totalFindings, badge: totalFindings ? `${decidedFindings}/${totalFindings}` : undefined },
    { key: "submit", label: "Submit", enabled: reviewed > 0, done: Boolean(stack.postedAt) && !anyPostable },
  ];
  const add = layers.reduce((n, l) => n + l.additions, 0);
  const del = layers.reduce((n, l) => n + l.deletions, 0);

  return (
    <div className="flex flex-1 flex-col">
      <header className="bg-surface">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-2 px-[clamp(16px,3vw,32px)] pt-[22px] pb-3">
          <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1.5 text-[13px] text-fg-2">
            <span className="inline-flex h-6 items-center gap-[5px] rounded-full bg-accent-soft px-2.5 text-[12.5px] font-semibold text-accent">
              <Sym name="stacks" size={15} />
              Stack review
            </span>
            <span className="font-mono text-[12.5px]">{stack.repo}</span>
            <span className="inline-flex flex-wrap items-center gap-1.5 font-mono text-[12px]">
              <span className="rounded-[5px] border border-line bg-sunken px-[7px] py-px text-fg">{stack.baseRef}</span>
              <span className="text-fg-3">→</span>
              <span className="rounded-[5px] border border-line bg-sunken px-[7px] py-px text-fg">{top?.headRef}</span>
            </span>
            <span>{layers.length} PRs</span>
            <span className="font-mono text-[12.5px]">
              <span className="text-add">+{add}</span> <span className="text-del">−{del}</span>
            </span>
          </div>
          <h1 className="m-0 text-[clamp(20px,2.2vw,25px)] leading-[1.3] font-semibold tracking-[-0.01em] text-pretty">
            <Inline text={stack.title} />
          </h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex h-1.5 max-w-[360px] flex-[1_1_200px] gap-[3px]">
              {layers.map((l) => (
                <span key={l.pr} title={`#${l.pr} · ${STATE[l.state].label}`} className="flex-1 rounded-[3px] transition-[background] duration-300" style={{ background: SEG[l.state] }} />
              ))}
            </div>
            <span className="text-[13px] text-fg-2">
              {reviewed} of {active.length} reviewed
            </span>
            {stack.minutesLeft != null && busy && <span className="text-[13px] text-fg-3">About {stack.minutesLeft} min left</span>}
          </div>
        </div>
      </header>

      <div className="sticky top-0 z-20 border-b border-line bg-surface">
        <nav className="mx-auto flex max-w-[1400px] gap-0.5 overflow-x-auto px-[clamp(8px,3vw,24px)]">
          {tabs.map((t, i) => {
            const on = tab === t.key;
            return (
              <button
                key={t.key}
                disabled={!t.enabled}
                onClick={() => t.enabled && setTab(t.key)}
                className={`-mb-px flex h-[52px] flex-none items-center gap-[9px] border-0 border-b-2 bg-transparent px-3.5 text-[14.5px] font-medium hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 ${on ? "border-accent text-fg" : "border-transparent text-fg-2"} ${t.enabled ? "cursor-pointer" : ""}`}
              >
                <span className={`grid size-[22px] place-items-center rounded-full font-mono text-[11.5px] font-medium ${t.done ? "bg-add-soft text-add" : on || t.loading ? "bg-accent text-on-accent" : "bg-sunken text-fg-3"}`}>
                  {t.done ? <Sym name="check" size={15} /> : t.loading ? <span className="pb-spin inline-block size-3 rounded-full border-2 border-[color-mix(in_oklch,var(--on-accent)_35%,transparent)] border-t-on-accent" /> : i + 1}
                </span>
                {t.label}
                {t.badge && <span className="inline-flex items-center rounded-full border border-line bg-sunken px-[7px] py-px font-mono text-[11.5px] text-fg-2">{t.badge}</span>}
              </button>
            );
          })}
        </nav>
      </div>

      {tab === "work" && <Layers stack={stack} onChange={setStack} reload={load} goFindings={() => setTab("findings")} goSubmit={() => setTab("submit")} wide={layout.wide || layout.mid} />}
      {tab === "findings" && <Findings stack={stack} reviews={reviews} reload={async () => { await load(); await loadReviews(); }} goSubmit={() => setTab("submit")} wide={layout.wide || layout.mid} stickyBottom={layout.stickyBottom} />}
      {tab === "submit" && <Submit stack={stack} reviews={reviews} reload={load} goFindings={() => setTab("findings")} wide={layout.wide || layout.mid} />}
    </div>
  );
}

/** What the bunny says about the stack. */
function stackMood(s: StackDetail, setTab: (t: Tab) => void): MoodReport | null {
  const active = s.layers.filter((l) => !l.skipped && l.state !== "merged");
  const running = active.find((l) => RUNNING.includes(l.state));
  if (running) return { mood: "working", say: `Reviewing #${running.pr} (${active.indexOf(running) + 1} of ${active.length})…`, go: () => setTab("work") };
  if (s.cross.state === "running") return { mood: "working", say: "Reading the layers together…", go: () => setTab("work") };
  const failed = active.find((l) => l.state === "failed");
  if (failed) return { mood: "error", say: `#${failed.pr} failed. Retry it from the layers.`, go: () => setTab("work") };
  const changed = active.filter((l) => l.state === "changed").length;
  if (changed) return { mood: "update", say: `${changed} PR${changed === 1 ? "" : "s"} changed since your review.`, go: () => setTab("work") };
  const ready = active.filter((l) => l.state === "decide" && !l.mine).length;
  if (ready) return { mood: "clean", say: `${ready} PR${ready === 1 ? "" : "s"} ready to post.`, go: () => setTab("submit") };
  if (active.length && active.every((l) => l.state === "approved")) return { mood: "approved", say: "Stack approved." };
  if (s.postedAt) return { mood: "commented", say: "Posted the stack's reviews." };
  return null;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid flex-1 place-items-center p-10 text-fg-3">{children}</div>;
}

const modeBadge = (mine: boolean) =>
  mine
    ? { label: "Yours · self-review", cls: "bg-add-soft text-add border-add-soft" }
    : { label: "Peer review", cls: "bg-sunken text-fg-2 border-line" };

function StateChip({ state }: { state: LayerState }) {
  const s = STATE[state];
  return (
    <span className="inline-flex h-[22px] items-center gap-[5px] rounded-full px-[9px] text-[12px] font-semibold whitespace-nowrap" style={{ background: s.bg, color: s.color }}>
      {s.spin ? <Spinner size={11} /> : s.icon ? <Sym name={s.icon} size={14} /> : null}
      {s.label}
    </span>
  );
}

// ---------- Layers ----------

function Layers(props: { stack: StackDetail; onChange: (s: StackDetail) => void; reload: () => Promise<void>; goFindings: () => void; goSubmit: () => void; wide: boolean }) {
  const { stack } = props;
  const now = useNow(stack.runState === "running");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      const out = await fn();
      if (out && typeof out === "object" && "layers" in (out as object)) props.onChange(out as StackDetail);
      else await props.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const layers = stack.layers;
  const active = layers.filter((l) => !l.skipped && l.state !== "merged");
  const size = layers.filter((l) => l.state !== "merged").length;
  const tooBig = size > stack.maxAll;
  const started = layers.some((l) => l.state !== "waiting" && l.state !== "merged" && !l.skipped);
  const running = stack.runState === "running";
  const paused = stack.runState === "paused";
  const current = active.filter((l) => RUNNING.includes(l.state));
  const changed = active.filter((l) => l.state === "changed");
  const failed = active.filter((l) => l.state === "failed");
  const merged = layers.filter((l) => l.state === "merged");
  const reviewed = active.filter((l) => ["decide", "submitted", "approved", "changed"].includes(l.state)).length;
  const ready = active.filter((l) => l.state === "decide").length;

  // Big stacks: collapse the middle, keeping the ends and anything that needs you.
  const collapsible = layers.length > 8;
  const keep = (l: StackLayer, i: number) => i < 2 || i >= layers.length - 2 || ["failed", "changed", "reviewing", "scanning", "decide", "stopped"].includes(l.state);
  const rows: Array<{ layer: StackLayer; pos: number } | { gap: StackLayer[] }> = [];
  layers.forEach((l, i) => {
    if (!collapsible || expanded || keep(l, i)) rows.push({ layer: l, pos: i + 1 });
    else {
      const last = rows[rows.length - 1];
      if (last && "gap" in last) last.gap.push(l);
      else rows.push({ gap: [l] });
    }
  });
  // Rendered top of the stack first, like the rail on the Overview: base at the bottom.
  const shown = [...rows].reverse();

  const banners: Array<{ icon: string; color: string; bg: string; title: string; sub: string; items?: Array<{ ref: string; text: string }>; action?: { label: string; go: () => void } }> = [];
  if (changed.length)
    banners.push({
      icon: "update",
      color: "var(--warn)",
      bg: "var(--warn-soft)",
      title: `${changed.length} PR${changed.length === 1 ? "" : "s"} changed since your review`,
      sub: "Re-reviewing only looks at what changed, and keeps your decisions on everything else.",
      items: changed.map((l) => ({ ref: `#${l.pr}`, text: l.note ?? "New commits." })),
      action: { label: `Re-review ${changed.length === 1 ? "it" : `${changed.length} PRs`}`, go: () => act("rereview", () => api.stackRereview(stack.id)) },
    });
  if (failed.length)
    banners.push({
      icon: "error",
      color: "var(--del)",
      bg: "var(--del-soft)",
      title: failed.length === 1 ? `#${failed[0]!.pr} failed` : `${failed.length} layers failed`,
      sub: "The other layers are unaffected. Retry to review it again from scratch.",
      items: failed.map((l) => ({ ref: `#${l.pr}`, text: l.note ?? "The review failed." })),
      action: failed.length === 1 ? { label: "Retry", go: () => act(`start:${failed[0]!.pr}`, () => api.stackLayerStart(stack.id, failed[0]!.pr)) } : undefined,
    });
  if (merged.length)
    banners.push({
      icon: "merge",
      color: "var(--text-2)",
      bg: "var(--sunken)",
      title: `${merged.map((l) => `#${l.pr}`).join(", ")} merged`,
      sub: `Merged layers are left out. The PRs above them now build on ${stack.baseRef}.`,
    });
  if (stack.cross.state === "failed")
    banners.push({
      icon: "error",
      color: "var(--del)",
      bg: "var(--del-soft)",
      title: "The look across the stack failed",
      sub: stack.cross.error ?? "Try again.",
      action: { label: "Try again", go: () => act("cross", () => api.stackCross(stack.id)) },
    });

  const bar = running
    ? { text: current.length ? `Reviewing ${current.map((l) => `#${l.pr}`).join(", ")}. You can start deciding findings as layers finish.` : "Starting the next layer…", cta: "Pause", go: () => act("pause", () => api.stackRun(stack.id, "paused")) }
    : ready
      ? { text: `${ready} PR${ready === 1 ? "" : "s"} have findings to decide.`, cta: "Go to findings", go: props.goFindings }
      : reviewed && reviewed === active.length
        ? { text: "Every layer is reviewed.", cta: "Submit", go: props.goSubmit }
        : !started && !tooBig
          ? { text: `${active.length} PRs, each reviewed against its own parent.`, cta: "Review all", go: () => act("run", () => api.stackRun(stack.id, "running")) }
          : { text: "Open a layer to review it on its own, or start Review all.", cta: tooBig ? "Change the limit" : "Review all", go: tooBig ? () => navigate("/settings") : () => act("run", () => api.stackRun(stack.id, "running")) };

  const feed = [
    ...current.flatMap((l) => (l.line ? [{ t: l.line.at, text: `#${l.pr}  ${l.line.text}` }] : [])),
    ...(stack.cross.state === "running" ? stack.cross.lines.slice(-4).map((x) => ({ t: x.at, text: `across  ${x.text}` })) : []),
  ].sort((a, b) => a.t - b.t);
  const firstStart = current.map((l) => (l.startedAt ? Date.parse(l.startedAt.includes("T") ? l.startedAt : `${l.startedAt.replace(" ", "T")}Z`) : now)).sort()[0];

  return (
    <div className="mx-auto grid w-full max-w-[1400px] flex-1 items-start gap-5 px-[clamp(16px,3vw,32px)] pt-6 pb-5" style={{ gridTemplateColumns: props.wide ? "minmax(0,1fr) 360px" : "minmax(0,1fr)" }}>
      <div className="flex min-w-0 flex-col gap-4 self-stretch">
        {err && <p className="m-0 rounded-lg bg-del-soft px-3.5 py-3 text-[13.5px] text-del">{err}</p>}
        {banners.map((b) => (
          <section key={b.title} className="flex flex-wrap items-start gap-x-3.5 gap-y-3 rounded-xl border px-[18px] py-4" style={{ background: b.bg, borderColor: b.bg }}>
            <span className="mt-px flex-none" style={{ color: b.color }}>
              <Sym name={b.icon} size={22} fill />
            </span>
            <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
              <p className="m-0 text-[14.5px] font-semibold">{b.title}</p>
              <p className="m-0 text-[13.5px] leading-[1.55] text-pretty text-fg-2">{b.sub}</p>
              {b.items && (
                <ul className="m-0 mt-1.5 flex list-none flex-col gap-1.5 p-0">
                  {b.items.map((it) => (
                    <li key={it.ref} className="flex gap-2.5 text-[13.5px] leading-normal">
                      <span className="min-w-12 flex-none font-mono text-[12.5px] font-medium">{it.ref}</span>
                      <span className="min-w-0">
                        <Inline text={it.text} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {b.action && (
              <button onClick={b.action.go} disabled={busy !== null} className="h-[42px] flex-none cursor-pointer rounded-lg border-0 bg-accent px-4 text-[14px] font-semibold whitespace-nowrap text-on-accent disabled:opacity-60">
                {b.action.label}
              </button>
            )}
          </section>
        ))}

        <section className={`${card} overflow-hidden`}>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-[18px] pt-3.5 pb-3">
            <h2 className="m-0 text-[14px] font-semibold">Layers</h2>
            <span className="flex items-center gap-3 text-[12.5px] text-fg-3">
              Top of the stack first
              {collapsible && (
                <button onClick={() => setExpanded((v) => !v)} className="h-7 cursor-pointer rounded-md border border-line bg-transparent px-2.5 text-[12.5px] text-fg-2 hover:bg-hover">
                  {expanded ? "Collapse middle" : "Show all"}
                </button>
              )}
            </span>
          </div>
          {shown.map((row, i) =>
            "gap" in row ? (
              <div key={`gap-${i}`} className="relative border-t border-line">
                <span className="absolute top-0 bottom-0 left-[31px] border-l border-dashed border-line-strong" />
                <button onClick={() => setExpanded(true)} className="flex min-h-14 w-full cursor-pointer flex-col gap-px border-0 bg-transparent py-2.5 pr-[18px] pl-14 text-left hover:bg-hover">
                  <span className="flex items-center gap-1 text-[13.5px] font-medium text-accent">
                    <Sym name="unfold_more" size={17} />
                    {row.gap.length} more PR{row.gap.length === 1 ? "" : "s"}
                  </span>
                  <span className="font-mono text-[11.5px] text-fg-3">{row.gap.map((l) => `#${l.pr}`).join(" · ")}</span>
                </button>
              </div>
            ) : (
              <LayerRow key={row.layer.pr} layer={row.layer} pos={row.pos} stack={stack} busy={busy} act={act} first={i === 0} />
            ),
          )}
          <div className="relative flex items-center gap-3 border-t border-line px-[18px] py-2.5 text-[12.5px] text-fg-3">
            <span className="absolute top-0 bottom-1/2 left-[31px] w-px bg-line-strong" />
            <span className="relative grid w-[26px] flex-none place-items-center">
              <span className="size-[15px] rounded-[3px] border border-dashed border-line-strong bg-surface" />
            </span>
            <span className="font-mono text-fg-2">{stack.baseRef}</span>
          </div>
        </section>

        <div className="sticky bottom-0 z-15 mt-auto pb-3">
          <div className={`${card} flex flex-wrap items-center gap-x-3 gap-y-2 py-2 pr-2 pl-4 shadow-bar`}>
            <p className="m-0 min-w-0 flex-[1_1_200px] text-[14px] text-fg-2">{bar.text}</p>
            {(running || current.length > 0 || stack.cross.state === "running") && <StopAll stack={stack} busy={busy !== null} act={act} up />}
            <button onClick={bar.go} disabled={busy !== null} className="ml-auto h-[38px] flex-none cursor-pointer rounded-lg border-0 bg-accent px-3.5 text-[13.5px] font-semibold whitespace-nowrap text-on-accent disabled:opacity-60">
              {busy === "run" || busy === "pause" ? <Spinner size={13} light /> : bar.cta}
            </button>
          </div>
        </div>
      </div>

      <aside className="flex min-w-0 flex-col gap-4" style={{ position: props.wide ? "sticky" : "static", top: 68 }}>
        {!started && !running && !tooBig && (
          <section className={`${card} px-[22px] py-5`}>
            <h2 className="m-0 mb-1 text-[14px] font-semibold">Review the whole stack</h2>
            <p className="m-0 mb-3.5 text-[13px] leading-normal text-fg-3">Each PR is still reviewed against its own parent, and GitHub still gets one review per PR.</p>
            <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
              {[
                `Scan and deep-review every layer, ${stack.order === "base" ? "base first" : "top first"}, ${stack.concurrency} at a time.`,
                "Then read the layers together for problems that only show up across them.",
                "Decide everything in one queue, and post one review per PR.",
              ].map((text, i) => (
                <li key={i} className="flex gap-2.5 text-[13.5px] leading-normal">
                  <span className="grid size-5 flex-none place-items-center rounded-[5px] bg-accent-soft font-mono text-[11px] font-medium text-accent">{i + 1}</span>
                  <span>{text}</span>
                </li>
              ))}
            </ol>
            <button onClick={() => act("run", () => api.stackRun(stack.id, "running"))} disabled={busy !== null} className="mt-4 h-[46px] w-full cursor-pointer rounded-lg border-0 bg-accent text-[14.5px] font-semibold text-on-accent disabled:opacity-60">
              Review all {active.length} PRs
            </button>
            <p className="m-0 mt-2.5 font-mono text-[11.5px] text-fg-3">
              or <span className="text-fg-2">bunny review --stack</span>
            </p>
          </section>
        )}
        {tooBig && !running && (
          <section className={`${card} px-[22px] py-5`}>
            <h2 className="m-0 mb-1.5 text-[13px] font-semibold text-fg-3">Review all is off for this stack</h2>
            <p className="m-0 text-[13.5px] leading-[1.55] text-fg-2">
              It has {size} PRs, more than your limit of {stack.maxAll}. You can still open and review each layer.
            </p>
            <button onClick={() => navigate("/settings")} className="mt-3 h-9 cursor-pointer rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium hover:bg-hover">
              Change the limit
            </button>
          </section>
        )}
        {(running || current.length > 0 || stack.cross.state === "running") && (
          <section className={`${card} overflow-hidden`}>
            <header className="flex items-center gap-2.5 px-[18px] pt-3.5 pb-1">
              <Spinner size={15} />
              <span className="min-w-0 flex-1 text-[14px] font-semibold">
                {current.length ? `Reviewing ${current.map((l) => `#${l.pr}`).join(", ")}` : stack.cross.state === "running" ? "Reading the layers together" : "Starting…"}
              </span>
              {firstStart && <span className="font-mono text-[12px] text-fg-3">{elapsedText(now - firstStart)}</span>}
            </header>
            <p className="m-0 truncate px-[18px] pb-3 pl-[43px] text-[13px] text-fg-2">{current[0] ? <Inline text={current[0].title} /> : "Across the stack"}</p>
            <div className="min-h-[110px] border-t border-line bg-code px-[18px] py-2.5 font-mono text-[12px] leading-[1.75]">
              {!feed.length && <div className="text-fg-3">Starting…</div>}
              {feed.slice(-6).map((l, i) => (
                <div key={i} className="flex min-w-0 gap-2.5">
                  <span className="min-w-0 flex-1 truncate text-fg-2">{l.text}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line py-2.5 pr-3 pl-[18px]">
              <span className="flex-1 text-[12.5px] text-fg-3">
                {stack.order === "base" ? "Base first" : "Top first"} · {stack.concurrency} at a time
              </span>
              {running && (
                <button onClick={() => act("pause", () => api.stackRun(stack.id, "paused"))} className="h-8 cursor-pointer rounded-lg border border-line bg-transparent px-2.5 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg">
                  Pause
                </button>
              )}
            </div>
          </section>
        )}
        {paused && (
          <section className={`${card} flex flex-col gap-2.5 px-5 py-[18px]`}>
            <h2 className="m-0 text-[14px] font-semibold">Paused</h2>
            <p className="m-0 text-[13.5px] text-fg-2">Reviews already running finish; nothing new starts until you resume.</p>
            <button onClick={() => act("run", () => api.stackRun(stack.id, "running"))} className="h-10 cursor-pointer rounded-lg border-0 bg-accent text-[13.5px] font-semibold text-on-accent">
              Resume
            </button>
          </section>
        )}
        {stack.cross.findings.length > 0 ? (
          <section className={`${card} overflow-hidden`}>
            <div className="flex items-baseline justify-between gap-2.5 px-[18px] pt-4 pb-2">
              <h2 className="m-0 text-[14px] font-semibold">Across the stack</h2>
              <span className="font-mono text-[12px] text-fg-3">{stack.cross.findings.length}</span>
            </div>
            <ul className="m-0 flex list-none flex-col gap-0.5 px-1.5 pb-1.5">
              {stack.cross.findings.map((f) => (
                <li key={f.id}>
                  <button onClick={props.goFindings} className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg border-0 bg-transparent px-3 py-[9px] text-left hover:bg-hover">
                    <span className="mt-[7px] size-2 flex-none rounded-full" style={{ background: SEVERITY[f.severity].c }} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-[13.5px] leading-[1.4]">
                        <Inline text={f.title} />
                      </span>
                      <span className="text-[12px] text-fg-3">
                        {KIND[f.kind]} · {f.prs.map((p) => `#${p}`).join(", ")}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : stack.cross.state !== "running" ? (
          <section className={`${card} px-5 py-[18px]`}>
            <h2 className="m-0 mb-1.5 text-[13px] font-semibold text-fg-3">Across the stack</h2>
            <p className="m-0 text-[13.5px] leading-[1.55] text-fg-2">
              {stack.cross.state === "done"
                ? "Nothing that spans layers. Each layer's own findings are all there is."
                : stack.cross.state === "stopped"
                  ? "Stopped with Review all, so it won't start on its own. It runs again when you start Review all."
                  : "Runs once every layer has a deep review. It looks for code one PR adds and another relies on, problems a later PR fixes, and the same finding repeated in several layers."}
            </p>
            {stack.cross.state === "stopped" && active.filter((l) => ["decide", "submitted", "approved", "changed"].includes(l.state)).length >= 2 && (
              <button onClick={() => act("cross", () => api.stackCross(stack.id))} className="mt-3 h-9 cursor-pointer rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium hover:bg-hover">
                Run it now
              </button>
            )}
          </section>
        ) : null}
        <p className="m-0 px-1 text-[12.5px] leading-normal text-fg-3">
          Each layer's review also gets its neighbours' titles and descriptions as context (Settings › Review › Stack context).
        </p>
      </aside>
    </div>
  );
}

function LayerRow({ layer: l, pos, stack, busy, act, first }: { layer: StackLayer; pos: number; stack: StackDetail; busy: string | null; act: (k: string, fn: () => Promise<unknown>) => void; first: boolean }) {
  const s = STATE[l.state];
  const dim = l.state === "merged" || l.state === "skipped";
  const mode = modeBadge(l.mine);
  const indent = Math.min(3, Math.max(0, siblingsBefore(stack, l)));
  const actions: Array<{ key: string; label: string; icon: string; primary?: boolean; go: () => void }> = [];
  if (l.reviewId && l.state !== "waiting") actions.push({ key: "open", label: "Open", icon: "arrow_forward", primary: l.state === "decide" || l.state === "readable", go: () => navigate(`/review/${l.reviewId}`) });
  if (l.state === "waiting" && !l.skipped) actions.push({ key: `start:${l.pr}`, label: "Review", icon: "play_arrow", go: () => act(`start:${l.pr}`, () => api.stackLayerStart(stack.id, l.pr)) });
  if (l.state === "failed") actions.push({ key: `start:${l.pr}`, label: "Retry", icon: "refresh", go: () => act(`start:${l.pr}`, () => api.stackLayerStart(stack.id, l.pr)) });
  // Stopped: Resume (before the across pass runs, it puts the layer back in), or Start again.
  if (l.state === "stopped" && l.reviewId) {
    actions.push({ key: `resume:${l.pr}`, label: "Resume", icon: "play_arrow", primary: true, go: () => act(`resume:${l.pr}`, () => api.resume(l.reviewId!)) });
    actions.push({ key: `restart:${l.pr}`, label: "Start again", icon: "restart_alt", go: () => act(`restart:${l.pr}`, () => api.restart(l.reviewId!)) });
  }
  if (l.state !== "merged" && !RUNNING.includes(l.state) && l.state !== "submitted" && l.state !== "approved")
    actions.push({ key: `skip:${l.pr}`, label: l.skipped ? "Include" : "Skip", icon: l.skipped ? "add" : "block", go: () => act(`skip:${l.pr}`, () => api.stackLayerSkip(stack.id, l.pr, !l.skipped)) });
  const counts = (["critical", "high", "medium", "low"] as Severity[]).filter((k) => l.counts[k] > 0);
  return (
    <div className="relative flex flex-wrap items-start gap-x-3 gap-y-2.5 border-t border-line py-3.5 pr-[18px]" style={{ paddingLeft: 18 + indent * 22, opacity: dim ? 0.6 : 1, background: l.state === "decide" ? "transparent" : undefined }}>
      <span className="absolute w-px bg-line-strong" style={{ left: 31 + indent * 22, top: first ? "50%" : 0, bottom: 0 }} />
      <span
        className="relative grid size-[26px] flex-none place-items-center rounded-full border-2 font-mono text-[11.5px] font-medium"
        style={{ borderColor: RUNNING.includes(l.state) ? "var(--accent)" : s.color, background: RUNNING.includes(l.state) ? "var(--accent)" : "var(--surface)", color: RUNNING.includes(l.state) ? "var(--on-accent)" : s.color }}
      >
        {pos}
      </span>
      <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1.5">
        {indent > 0 && (
          <span className="inline-flex items-center gap-1 text-[12px] text-fg-3">
            <Sym name="call_split" size={15} />
            Branches from #{l.parentPr}
          </span>
        )}
        <div className="flex min-w-0 items-baseline gap-2">
          <a href={l.url} target="_blank" rel="noreferrer" className="flex-none font-mono text-[12.5px] text-fg-3 hover:text-fg">
            #{l.pr}
          </a>
          <span className="text-[14.5px] leading-[1.4] font-medium text-pretty">
            <Inline text={l.title} />
            {l.isDraft && <span className="ml-2 rounded border border-line bg-sunken px-1.5 py-px align-[1px] text-[11px] font-semibold text-fg-3">Draft</span>}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-fg-2">
          <span className="inline-flex items-center gap-[5px]">
            <img src={`https://github.com/${l.author}.png?size=36`} alt="" className="size-[18px] rounded-full bg-sunken" />
            {l.author}
          </span>
          <span className={`rounded border px-[7px] py-px text-[11px] font-semibold ${mode.cls}`}>{mode.label}</span>
          <StateChip state={l.state} />
          {(counts.length > 0 || l.across > 0) && (
            <span className="inline-flex items-center gap-[9px] font-mono text-[12px]">
              {counts.map((k) => (
                <span key={k} title={`${l.counts[k]} ${SEVERITY[k].label.toLowerCase()}`} className="inline-flex items-center gap-1 text-fg-2">
                  <span className="size-[7px] rounded-full" style={{ background: SEVERITY[k].c }} />
                  {l.counts[k]}
                </span>
              ))}
              {l.across > 0 && <span className="text-accent">+{l.across} across</span>}
            </span>
          )}
          <span className="font-mono text-[12px]">
            <span className="text-add">+{l.additions}</span> <span className="text-del">−{l.deletions}</span>
          </span>
        </div>
        {l.note && (
          <p className="m-0 text-[13px] leading-normal text-pretty" style={{ color: l.state === "failed" ? "var(--del)" : "var(--text-2)" }}>
            <Inline text={l.note} />
          </p>
        )}
        {l.line && RUNNING.includes(l.state) && (
          <div className="flex min-w-0 gap-2.5 font-mono text-[12px] text-fg-2">
            <span className="min-w-0 truncate">{l.line.text}</span>
          </div>
        )}
      </div>
      <div className="ml-auto flex flex-none gap-1.5">
        {actions.map((a) => (
          <button
            key={a.key}
            onClick={a.go}
            disabled={busy === a.key}
            className={`inline-flex h-[34px] cursor-pointer items-center gap-[5px] rounded-lg border px-[11px] text-[13px] font-medium whitespace-nowrap hover:brightness-[0.96] disabled:opacity-60 ${a.primary ? "border-accent bg-accent text-on-accent" : "border-line-strong bg-surface text-fg"}`}
          >
            {busy === a.key ? <Spinner size={13} /> : <Sym name={a.icon} size={16} />}
            {a.label}
          </button>
        ))}
        {(l.state === "scanning" || l.state === "reviewing") && l.reviewId && <LayerStop layer={l} pos={pos} size={stack.layers.length} busy={busy} act={act} />}
      </div>
    </div>
  );
}

// ---------- stop a layer, or Stop Review all ----------

/**
 * Stop one running layer. The others keep going; the across pass runs without it. The confirm sits
 * in the row itself (the layer list clips popovers).
 */
function LayerStop({ layer: l, pos, size, busy, act }: { layer: StackLayer; pos: number; size: number; busy: string | null; act: (k: string, fn: () => Promise<unknown>) => void }) {
  const [ask, setAsk] = useState(false);
  const key = `stop:${l.pr}`;
  if (ask)
    return (
      <span role="dialog" aria-label={`Stop layer ${pos} of ${size}?`} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface py-1 pr-1 pl-2.5 shadow-pop">
        <span className="text-[12.5px] text-fg-2">
          <b className="font-semibold text-fg">Stop layer {pos} of {size}?</b> Other layers keep going.
        </span>
        <button autoFocus onClick={() => setAsk(false)} className="h-[26px] cursor-pointer rounded-md border border-line-strong bg-surface px-2 text-[12px] font-medium text-fg hover:bg-hover">
          Keep running
        </button>
        <button
          onClick={() => {
            setAsk(false);
            act(key, () => api.cancel(l.reviewId!));
          }}
          className="h-[26px] cursor-pointer rounded-md border-0 bg-del px-2 text-[12px] font-medium text-on-accent"
        >
          Stop layer
        </button>
      </span>
    );
  return (
    <button
      onClick={() => setAsk(true)}
      disabled={busy === key}
      title="Stop this layer · the across-the-stack pass will skip it"
      aria-label={`Stop layer ${pos}`}
      className="grid size-[34px] cursor-pointer place-items-center rounded-lg border border-line-strong bg-surface text-fg-2 hover:border-del hover:bg-del-soft hover:text-del disabled:opacity-60"
    >
      {busy === key ? <Spinner size={13} /> : <Sym name="stop" size={18} />}
    </button>
  );
}

/** Stop Review all: stops running layers and the across pass. Keep finished layers, or throw it all away. */
function StopAll({ stack, busy, act, up }: { stack: StackDetail; busy: boolean; act: (k: string, fn: () => Promise<unknown>) => void; up?: boolean }) {
  const [ask, setAsk] = useState(false);
  const [keep, setKeep] = useState(true);
  const live = stack.layers.filter((l) => !l.skipped && l.state !== "merged");
  const runningN = live.filter((l) => RUNNING.includes(l.state)).length;
  const queued = stack.runState === "running" ? live.filter((l) => l.state === "waiting").length : 0;
  const finished = live.filter((l) => ["decide", "changed"].includes(l.state));
  const findings = finished.reduce((n, l) => n + l.total, 0);
  const parts = [runningN ? `Stops ${runningN} running` : null, queued ? `${queued} queued won't start` : null].filter(Boolean).join(", ");
  const radio = (on: boolean, title: string, sub: string, pick: () => void) => (
    <button
      role="radio"
      aria-checked={on}
      onClick={pick}
      className={`flex cursor-pointer gap-2.5 rounded-lg border-0 px-2 py-[7px] text-left ${on ? "bg-accent-soft" : "bg-transparent hover:bg-hover"}`}
    >
      <span className={`mt-[3px] size-3.5 flex-none rounded-full bg-surface ${on ? "border-4 border-accent" : "border-[1.5px] border-line-strong"}`} />
      <span className="flex flex-col">
        <span className="text-[13px] font-medium text-fg">{title}</span>
        <span className="text-[12px] text-fg-3">{sub}</span>
      </span>
    </button>
  );
  return (
    <span className="relative flex-none">
      <button
        onClick={() => setAsk(true)}
        disabled={busy}
        className="inline-flex h-[38px] cursor-pointer items-center gap-[5px] rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium text-fg-2 hover:border-del hover:bg-del-soft hover:text-del disabled:opacity-60"
      >
        <Sym name="stop_circle" size={16} />
        Stop Review all
      </button>
      {ask && (
        <ConfirmPop
          title="Stop Review all?"
          body={`${parts ? `${parts}. ` : ""}The across-the-stack pass won't run.`}
          cancel="Keep going"
          confirm="Stop all"
          up={up}
          width={320}
          onConfirm={() => {
            setAsk(false);
            act("stopall", () => api.stackStop(stack.id, keep).then((r) => r.stack));
          }}
          onClose={() => setAsk(false)}
        >
          <div role="radiogroup" className="flex flex-col gap-0.5">
            {radio(
              keep,
              "Keep finished layers",
              finished.length ? `${finished.length === 1 ? "Layer" : "Layers"} ${finished.map((l) => stack.layers.indexOf(l) + 1).join(", ")} · ${findings} ${findings === 1 ? "finding" : "findings"}` : "Nothing has finished yet",
              () => setKeep(true),
            )}
            {radio(!keep, "Throw it all away", "Start the stack from scratch next time. Posted reviews stay.", () => setKeep(false))}
          </div>
        </ConfirmPop>
      )}
    </span>
  );
}

/** A layer that isn't its parent's first child is a branch: indent it one step. */
function siblingsBefore(stack: StackDetail, l: StackLayer): number {
  if (l.parentPr === null) return 0;
  const siblings = stack.layers.filter((x) => x.parentPr === l.parentPr);
  return siblings.indexOf(l) > 0 ? 1 : 0;
}

// ---------- Findings ----------

interface QItem {
  key: string;
  /** The layer's PR, or null for an across-the-stack finding. */
  pr: number | null;
  finding?: Finding;
  reviewId?: number;
  cross?: StackFinding;
  severity: Severity;
  title: string;
  decision: "accepted" | "dismissed" | null;
}

function Findings(props: { stack: StackDetail; reviews: Record<number, ReviewDetail>; reload: () => Promise<void>; goSubmit: () => void; wide: boolean; stickyBottom: number }) {
  const { stack, reviews } = props;
  const [filter, setFilter] = useState<number | "across" | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const [askOpen, setAskOpen] = useState(false);
  const [q, setQ] = useState("");
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // One queue: each layer's findings in stack order, then the ones across the stack.
  const items: QItem[] = useMemo(() => {
    const out: QItem[] = [];
    for (const l of stack.layers) {
      const r = l.reviewId ? reviews[l.reviewId] : undefined;
      if (!r || l.skipped || l.state === "merged") continue;
      for (const f of r.findings.filter((x) => x.stackFindingId === null))
        out.push({ key: `f${f.id}`, pr: l.pr, finding: f, reviewId: r.id, severity: f.severity, title: f.title, decision: f.decision });
    }
    for (const c of stack.cross.findings) out.push({ key: `x${c.id}`, pr: null, cross: c, severity: c.severity, title: c.title, decision: c.decision });
    return out;
  }, [stack, reviews]);
  const visible = items.filter((i) => filter === null || (filter === "across" ? i.pr === null : i.pr === filter));
  const current = visible.find((i) => i.key === sel) ?? visible.find((i) => !i.decision) ?? visible[0];
  const layerOf = (pr: number | null) => stack.layers.find((l) => l.pr === pr) ?? null;
  const layer = current?.pr != null ? layerOf(current.pr) : null;
  const mine = current?.cross ? current.cross.placements.every((p) => layerOf(p.pr)?.mine) : Boolean(layer?.mine);
  const placementFinding = current?.cross
    ? (() => {
        const p = current.cross.placements[0];
        const r = p ? reviews[p.reviewId] : undefined;
        return r?.findings.find((f) => f.id === p!.findingId);
      })()
    : current?.finding;

  useEffect(() => {
    setComment(current?.cross ? (current.cross.placements[0]?.comment ?? "") : (current?.finding?.comment ?? ""));
    setDismissing(false);
    setReason("");
    setErr(null);
  }, [current?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const decided = items.filter((i) => i.decision).length;
  const move = (d: 1 | -1) => {
    if (!current) return;
    const i = visible.indexOf(current);
    const next = visible[Math.min(visible.length - 1, Math.max(0, i + d))];
    if (next) setSel(next.key);
  };
  const decide = async (decision: "accepted" | "dismissed" | null, opts: { soft?: boolean; reason?: string } = {}) => {
    if (!current) return;
    setErr(null);
    try {
      if (current.cross) await api.decideStackFinding(current.cross.id, decision, opts);
      else await api.decide(current.finding!.id, decision, opts.reason);
      setDismissing(false);
      await props.reload();
      if (decision) {
        const i = visible.indexOf(current);
        const next = visible.slice(i + 1).find((x) => !x.decision) ?? visible.find((x) => !x.decision && x.key !== current.key);
        if (next) setSel(next.key);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const onComment = (text: string) => {
    setComment(text);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (!current) return;
      if (current.cross) Promise.all(current.cross.placements.map((p) => api.stackComment(p.findingId, text))).catch(() => {});
      else api.comment(current.finding!.id, text).catch(() => {});
    }, 500);
  };
  const send = async () => {
    const target = placementFinding;
    if (!target || !q.trim()) return;
    setAsking(true);
    try {
      await api.ask(target.id, q.trim());
      setQ("");
      await props.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  };

  // Keyboard: J/K move (across PRs), A accept, D dismiss, U undo, Q ask. Not while typing.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j") move(1);
      else if (k === "k") move(-1);
      else if (k === "a") decide("accepted");
      else if (k === "d") setDismissing(true);
      else if (k === "u") decide(null);
      else if (k === "q") setAskOpen((v) => !v);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  if (!items.length)
    return (
      <div className="mx-auto w-full max-w-[1400px] px-[clamp(16px,3vw,32px)] py-5">
        <p className="m-0 rounded-xl border border-dashed border-line-strong p-7 text-center text-[15px] text-fg-3">No findings yet. They show up here as each layer's deep review finishes.</p>
      </div>
    );

  const chips: Array<{ key: number | "across" | null; label: string; count: number }> = [
    { key: null, label: "All", count: items.length },
    ...stack.layers.filter((l) => items.some((i) => i.pr === l.pr)).map((l) => ({ key: l.pr, label: `#${l.pr}`, count: items.filter((i) => i.pr === l.pr).length })),
    ...(stack.cross.findings.length ? [{ key: "across" as const, label: "Across the stack", count: stack.cross.findings.length }] : []),
  ];
  // Grouped list: a header per PR, then across the stack.
  const groups: Array<{ label: string; sub: string; color: string; items: QItem[] }> = [];
  for (const i of visible) {
    const label = i.pr === null ? "Across" : `#${i.pr}`;
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.items.push(i);
    else groups.push({ label, sub: i.pr === null ? "Across the stack" : plain(layerOf(i.pr)?.title ?? ""), color: i.pr === null ? "var(--accent)" : "var(--text-2)", items: [i] });
  }
  const pos = current ? items.indexOf(current) + 1 : 0;
  const f = current?.finding;
  const c = current?.cross;
  const sev = current ? SEVERITY[current.severity] : SEVERITY.low;
  const acceptLabel = mine ? "Fix" : "Accept";
  const dismissLabel = mine ? "Won't fix" : "Dismiss";
  const reasons = mine ? SELF_REASONS : DISMISS_REASONS;
  const whereLayer = c ? null : layer;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-4 px-[clamp(16px,3vw,32px)] pt-5 pb-6">
      <div className="flex items-center gap-2.5">
        <div role="group" aria-label="Filter by PR" className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-0.5">
          {chips.map((ch) => {
            const on = filter === ch.key;
            return (
              <button
                key={String(ch.key)}
                onClick={() => setFilter(ch.key)}
                aria-pressed={on}
                className={`inline-flex h-[34px] flex-none cursor-pointer items-center gap-[7px] rounded-full border px-3 text-[13px] font-medium whitespace-nowrap hover:border-line-strong ${on ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-fg-2"}`}
              >
                {ch.label}
                <span className="font-mono text-[11.5px] opacity-75">{ch.count}</span>
              </button>
            );
          })}
        </div>
        {decided === items.length && (
          <button onClick={props.goSubmit} className="h-9 flex-none cursor-pointer rounded-lg border-0 bg-accent px-3.5 text-[13px] font-semibold whitespace-nowrap text-on-accent">
            All decided, submit →
          </button>
        )}
      </div>
      <div className="grid items-start gap-4" style={{ gridTemplateColumns: props.wide ? "340px minmax(0,1fr)" : "minmax(0,1fr)" }}>
        {props.wide && (
          <aside className={`${card} sticky top-[68px] flex max-h-[calc(100vh-88px)] min-w-0 flex-col overflow-hidden`}>
            <div className="border-b border-line px-4 pt-3.5 pb-3">
              <div className="flex items-baseline justify-between">
                <span className="text-[14px] font-semibold">Findings</span>
                <span className="font-mono text-[12px] text-fg-3">
                  {decided}/{items.length} decided
                </span>
              </div>
              <div className="mt-2.5 flex h-1.5 gap-0.5">
                {items.map((i) => (
                  <span key={i.key} className="flex-1 rounded-[3px]" style={{ background: i.decision === "accepted" ? "var(--add)" : i.decision === "dismissed" ? "var(--line-strong)" : "var(--line)" }} />
                ))}
              </div>
            </div>
            <ol className="m-0 flex list-none flex-col gap-0.5 overflow-y-auto p-1.5">
              {groups.map((g, gi) => (
                <li key={`${g.label}-${gi}`}>
                  <div className="flex items-baseline gap-2 px-2.5 pt-2.5 pb-1 text-[12px]" style={{ marginTop: gi ? 6 : 0, borderTop: gi ? "1px solid var(--line)" : "none" }}>
                    <span className="flex-none font-mono font-semibold" style={{ color: g.color }}>
                      {g.label}
                    </span>
                    <span className="min-w-0 truncate text-fg-3">{g.sub}</span>
                    <span className="ml-auto flex-none font-mono text-fg-3">{g.items.length}</span>
                  </div>
                  <ol className="m-0 list-none p-0">
                    {g.items.map((i) => (
                      <li key={i.key}>
                        <button
                          onClick={() => setSel(i.key)}
                          className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg border-0 py-[9px] pr-2.5 pl-3 text-left hover:bg-hover"
                          style={{ background: i.key === current?.key ? "var(--accent-soft)" : "transparent" }}
                        >
                          <span className="mt-[7px] size-2 flex-none rounded-full" style={{ background: SEVERITY[i.severity].c }} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13.5px] leading-[1.4]" style={{ color: i.decision === "dismissed" ? "var(--text-3)" : "var(--text)", textDecoration: i.decision === "dismissed" ? "line-through" : "none" }}>
                              {plain(i.title)}
                            </span>
                            <span className="mt-[3px] block text-[12px] text-fg-3">
                              {SEVERITY[i.severity].label} · {i.cross ? i.cross.prs.map((p) => `#${p}`).join(" + ") : (i.finding?.path?.split("/").pop() ?? "general")}
                            </span>
                            {i.cross?.kind === "fixed" && i.cross.fixedIn && (
                              <span className="mt-1 inline-flex items-center gap-[3px] rounded bg-add-soft px-[7px] py-px text-[11.5px] font-semibold text-add">
                                <Sym name="healing" size={13} />
                                Fixed in #{i.cross.fixedIn}
                              </span>
                            )}
                          </span>
                          {i.decision && (
                            <span className="mt-px flex-none" style={{ color: i.decision === "accepted" ? "var(--add)" : "var(--text-3)" }}>
                              <Sym name={i.decision === "accepted" ? "check_circle" : "cancel"} size={18} />
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-x-3 gap-y-1.5 border-t border-line px-4 pt-2.5 pb-3.5 text-[11.5px] text-fg-3">
              <span>
                <Key>J</Key> <Key>K</Key> move across PRs
              </span>
              <span>
                <Key>U</Key> undo
              </span>
            </div>
          </aside>
        )}

        {current && (
          <article className="flex min-w-0 flex-col gap-3.5">
            {!props.wide && (
              <div className="flex items-center gap-2">
                <button onClick={() => move(-1)} aria-label="Previous finding" className="grid size-11 flex-none cursor-pointer place-items-center rounded-lg border border-line-strong bg-surface">
                  <Sym name="chevron_left" size={22} />
                </button>
                <div className="min-w-0 flex-1 text-center text-[13px] text-fg-2">
                  <span className="font-mono text-fg">
                    {pos} / {items.length}
                  </span>{" "}
                  · {decided} decided
                </div>
                <button onClick={() => move(1)} aria-label="Next finding" className="grid size-11 flex-none cursor-pointer place-items-center rounded-lg border border-line-strong bg-surface">
                  <Sym name="chevron_right" size={22} />
                </button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-[10px] border border-line bg-sunken px-3.5 py-2.5 text-[13px]">
              <span className="flex-none text-accent">
                <Sym name={c ? "stacks" : "call_split"} size={18} />
              </span>
              <span className="flex-none font-mono text-[12.5px] font-medium">{c ? c.prs.map((p) => `#${p}`).join(" + ") : `#${whereLayer?.pr}`}</span>
              <span className="min-w-0 flex-[1_1_180px] truncate text-fg-2">{c ? KIND[c.kind] : <Inline text={whereLayer?.title ?? ""} />}</span>
              {whereLayer && <span className="flex-none text-[12.5px] text-fg-3">Layer {stack.layers.indexOf(whereLayer) + 1} of {stack.layers.length}</span>}
              <span className={`flex-none rounded border px-[7px] py-px text-[11px] font-semibold ${modeBadge(mine).cls}`}>{modeBadge(mine).label}</span>
            </div>
            <div className={`${card} overflow-hidden`}>
              <header className="flex flex-col gap-2.5 px-[22px] pt-[18px] pb-4">
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <span className="font-mono text-fg-3">
                    {pos} / {items.length}
                  </span>
                  <span className="rounded-full px-[9px] py-0.5 font-semibold" style={{ background: sev.soft, color: sev.c }}>
                    {sev.label}
                  </span>
                  {(f?.lens ?? c?.lens) && <span className="rounded-full border border-line bg-sunken px-[9px] py-0.5 text-fg-2">{f?.lens ?? c?.lens}</span>}
                  {c && <span className="rounded-full bg-accent-soft px-[9px] py-0.5 font-semibold text-accent">{KIND[c.kind]}</span>}
                  {current.decision && (
                    <span className={`ml-auto rounded-full px-2.5 py-0.5 font-semibold ${current.decision === "accepted" ? "bg-add-soft text-add" : "bg-sunken text-fg-3"}`}>
                      {current.decision === "accepted" ? (c?.soft ? "Heads-up" : mine ? "Fixing" : "Accepted") : mine ? "Won't fix" : "Dismissed"}
                    </span>
                  )}
                </div>
                <h2 className="m-0 text-[20px] leading-[1.35] font-semibold tracking-[-0.005em] text-pretty">
                  <Inline text={current.title} />
                </h2>
                {c && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                    {c.prs.map((p, i) => (
                      <span key={p} className="contents">
                        {i > 0 && <span className="text-fg-3">{c.kind === "fixed" ? "→" : "+"}</span>}
                        <span className="inline-flex h-[26px] items-center gap-1.5 rounded-md border border-line bg-sunken px-[9px]">
                          <span className="font-mono font-medium">#{p}</span>
                          <span className="text-fg-3">{c.fixedIn === p ? "fixes it" : c.placements.some((x) => x.pr === p) ? "gets the comment" : "involved"}</span>
                        </span>
                      </span>
                    ))}
                  </div>
                )}
                {(placementFinding?.path ?? null) && (
                  <a
                    href={`https://github.com/${stack.repo}/pull/${c ? c.placements[0]?.pr : whereLayer?.pr}/files`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 self-start font-mono text-[12.5px] text-fg-2"
                  >
                    {placementFinding!.path}
                    {placementFinding!.line ? `:${placementFinding!.line}` : ""}
                    <Sym name="open_in_new" size={15} />
                  </a>
                )}
                {c && c.placements.length > 1 && (
                  <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-fg-2">
                    {c.placements.map((p) => (
                      <li key={p.findingId} className="flex items-center gap-1.5">
                        <span className="text-fg-3">
                          <Sym name="subdirectory_arrow_right" size={15} />
                        </span>
                        <span className="font-mono text-[12.5px]">
                          {p.path ?? "general"}
                          {p.line ? `:${p.line}` : ""}
                        </span>{" "}
                        in #{p.pr}
                      </li>
                    ))}
                  </ul>
                )}
              </header>
              {placementFinding && placementFinding.snippet.length > 0 && <Snippet lines={placementFinding.snippet} />}
              <div className="flex flex-col gap-[18px] px-[22px] pt-5 pb-[22px]">
                {c?.kind === "fixed" && c.fixedNote && (
                  <div className="flex flex-col gap-2.5 rounded-[10px] bg-add-soft px-4 py-3.5">
                    <div className="flex items-center gap-1.5 text-[13px] font-semibold text-add">
                      <Sym name="healing" size={17} />
                      Fixed in #{c.fixedIn}
                    </div>
                    <p className="m-0 text-[14.5px] leading-[1.55]">
                      <Inline text={c.fixedNote} />
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => decide("accepted", { soft: true })} className="h-9 cursor-pointer rounded-lg border-0 bg-add px-3 text-[13px] font-semibold text-surface">
                        Post as a heads-up
                      </button>
                      <button onClick={() => decide("dismissed", { reason: `Fixed in #${c.fixedIn}` })} className="h-9 cursor-pointer rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium hover:bg-hover">
                        Dismiss: fixed in #{c.fixedIn}
                      </button>
                    </div>
                  </div>
                )}
                <div>
                  <h3 className="m-0 mb-1.5 text-[13px] font-semibold text-fg-3">Why it matters</h3>
                  <p className="m-0 text-[15px] leading-[1.65] text-pretty">
                    <Inline text={f?.why ?? c?.why ?? ""} />
                  </p>
                </div>
                {(f?.fix ?? c?.fix) && (
                  <div>
                    <h3 className="m-0 mb-1.5 text-[13px] font-semibold text-fg-3">Suggested fix</h3>
                    <p className="m-0 text-[15px] leading-[1.65] text-pretty">
                      <Inline text={(f?.fix ?? c?.fix)!} />
                    </p>
                  </div>
                )}
              </div>
            </div>

            <section className={`${card} px-[22px] pt-[18px] pb-5`}>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                <h3 className="m-0 text-[14px] font-semibold">{mine ? "Prompt for your coding agent" : c && c.placements.length > 1 ? `Comment on ${c.placements.map((p) => `#${p.pr}`).join(" and ")}` : `Comment on #${c ? c.placements[0]?.pr : whereLayer?.pr}`}</h3>
                <span className="inline-flex items-center gap-[5px] text-[12.5px] text-fg-3">
                  <Sym name={mine ? "lock" : "edit"} size={16} />
                  {mine ? "Never posted" : "Posted if accepted. Edit freely."}
                </span>
              </div>
              {mine ? (
                <pre className="mt-2.5 mb-0 rounded-lg border border-line bg-code px-3.5 py-3 font-mono text-[13px] leading-[1.6] whitespace-pre-wrap">{f?.agentPrompt ?? c?.agentPrompt ?? comment}</pre>
              ) : (
                <textarea
                  value={comment}
                  onChange={(e) => onComment(e.target.value)}
                  rows={4}
                  className="mt-2.5 block min-h-[104px] w-full resize-y rounded-lg border border-line-strong bg-bg px-3.5 py-3 font-mono text-[13px] leading-[1.6] outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
                />
              )}
            </section>

            {askOpen && placementFinding && (
              <section className={`${card} overflow-hidden`}>
                <header className="px-[18px] pt-3.5 pb-2.5">
                  <div className="text-[14px] font-semibold">Ask about this finding</div>
                  <div className="text-[12.5px] text-fg-3">Continues {c ? `#${c.placements[0]?.pr}'s` : "this layer's"} review, with its full context</div>
                </header>
                {placementFinding.messages.length > 0 && (
                  <div className="flex flex-col gap-2.5 px-4 pt-1 pb-3">
                    {placementFinding.messages.map((m) => (
                      <div
                        key={m.id}
                        className="max-w-[92%] rounded-xl border px-3.5 py-2.5 text-[14px] leading-[1.55]"
                        style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", background: m.role === "user" ? "var(--accent-soft)" : "var(--surface)", borderColor: m.role === "user" ? "transparent" : "var(--line)" }}
                      >
                        <div className="mb-0.5 text-[11.5px] font-semibold text-fg-3">{m.role === "user" ? "You" : "Agent"}</div>
                        <Inline text={m.content} />
                      </div>
                    ))}
                  </div>
                )}
                {asking && (
                  <div className="flex items-center gap-2 px-[18px] pb-3 font-mono text-[12.5px] text-fg-3">
                    <Spinner size={13} />
                    Reading the layers…
                  </div>
                )}
                <div className="flex items-end gap-2 border-t border-line p-3">
                  <textarea
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
                    }}
                    rows={2}
                    placeholder="Does the later PR land before this ships? Is its fix enough?"
                    className="min-h-[52px] min-w-0 flex-1 resize-none rounded-lg border border-line-strong bg-bg px-3 py-2.5 text-[14px] leading-[1.45] outline-none focus:border-accent"
                  />
                  <button onClick={send} disabled={asking || !q.trim()} className="h-[52px] flex-none cursor-pointer rounded-lg border-0 bg-accent px-[18px] text-[14px] font-semibold text-on-accent disabled:opacity-50">
                    Send
                  </button>
                </div>
              </section>
            )}
            {err && <p className="m-0 rounded-lg bg-del-soft px-3.5 py-2.5 text-[13.5px] text-del">{err}</p>}

            <div className="sticky z-15 pb-3" style={{ bottom: props.stickyBottom }}>
              <div className={`${card} flex flex-wrap items-center gap-1.5 p-2 shadow-bar`}>
                {dismissing ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      decide("dismissed", { reason: reason.trim() || undefined });
                    }}
                    className="flex min-w-0 flex-[1_1_300px] flex-wrap items-center gap-2"
                  >
                    <span className="mr-1 text-[14px] font-semibold">{mine ? "Why not?" : "Why dismiss?"}</span>
                    {reasons.map((r) => (
                      <button key={r} type="button" onClick={() => decide("dismissed", { reason: r })} className="h-10 cursor-pointer rounded-full border border-line-strong bg-surface px-3.5 text-[13.5px] hover:border-del hover:text-del">
                        {r}
                      </button>
                    ))}
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      autoFocus
                      placeholder="Or type a reason, Enter to dismiss"
                      className="h-10 min-w-0 flex-[1_1_200px] rounded-lg border border-line-strong bg-bg px-3 text-[13.5px] outline-none focus:border-accent"
                    />
                    <button type="button" onClick={() => setDismissing(false)} className="h-10 cursor-pointer border-0 bg-transparent px-3 text-[13.5px] text-fg-2">
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="grid min-w-0 flex-[1_1_300px] grid-cols-3 gap-2">
                      <Action onClick={() => decide("accepted")} title={`${acceptLabel} (A)`} icon="check" cls="bg-add-soft text-add hover:bg-add-soft-2">
                        {acceptLabel}
                      </Action>
                      <Action onClick={() => setAskOpen((v) => !v)} title="Ask (Q)" icon="forum" cls="bg-accent-soft text-accent hover:bg-accent-soft-2">
                        Ask
                      </Action>
                      <Action onClick={() => setDismissing(true)} title={`${dismissLabel} (D)`} icon="close" cls="bg-del-soft text-del hover:bg-del-soft-2">
                        {dismissLabel}
                      </Action>
                    </div>
                    {current.decision && (
                      <button onClick={() => decide(null)} title="Undo (U)" className="flex h-[42px] flex-none cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-transparent px-3.5 text-[14px] text-fg-2 hover:bg-hover hover:text-fg">
                        <Sym name="undo" size={19} />
                        Undo
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </article>
        )}
      </div>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <span className="rounded border border-line-strong px-[5px] font-mono">{children}</span>;
}

function Action({ onClick, title, icon, cls, children }: { onClick: () => void; title: string; icon: string; cls: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} className={`flex h-[42px] min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border-0 text-[14px] font-semibold ${cls}`}>
      <Sym name={icon} size={18} />
      {children}
    </button>
  );
}

// ---------- Submit ----------

function Submit(props: { stack: StackDetail; reviews: Record<number, ReviewDetail>; reload: () => Promise<void>; goFindings: () => void; wide: boolean }) {
  const { stack } = props;
  const [subs, setSubs] = useState<StackSubmissionLayer[] | null>(null);
  const [summaryOn, setSummaryOn] = useState(stack.summaryOn);
  const [summary, setSummary] = useState(stack.summaryText);
  const [phase, setPhase] = useState<"idle" | "confirm" | "posting" | "done">("idle");
  const [results, setResults] = useState<Array<{ pr: number; ok: boolean; url?: string; error?: string }>>([]);
  const [copied, copy] = useCopy();
  const summaryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    api.stackSubmission(stack.id).then(setSubs, () => setSubs([]));
  }, [stack.id, stack.updatedAt]);
  const saveSummary = (on: boolean, text: string) => {
    if (summaryTimer.current) clearTimeout(summaryTimer.current);
    summaryTimer.current = setTimeout(() => api.stackSummary(stack.id, on, text).catch(() => {}), 400);
  };
  if (!subs) return <Centered><Spinner size={20} /></Centered>;

  const layerOf = (pr: number) => stack.layers.find((l) => l.pr === pr)!;
  const postable = subs.filter((s) => s.canPost);
  const undecided = subs.filter((s) => !s.mine).reduce((n, s) => n + s.undecided, 0);
  const mine = subs.filter((s) => s.mine);
  const top = [...stack.layers].reverse().find((l) => l.state !== "merged");
  const tally = (() => {
    const by = (e: ReviewEvent) => postable.filter((s) => s.event === e).length;
    const parts = [by("APPROVE") && `${by("APPROVE")} approve`, by("COMMENT") && `${by("COMMENT")} comment`, by("REQUEST_CHANGES") && `${by("REQUEST_CHANGES")} request changes`].filter(Boolean);
    return postable.length ? `${postable.length} review${postable.length === 1 ? "" : "s"}: ${parts.join(", ")}.` : "Nothing left to post.";
  })();
  const pick = async (pr: number, event: ReviewEvent) => setSubs(await api.stackLayerEvent(stack.id, pr, event));
  const post = async () => {
    setPhase("posting");
    try {
      setResults(await api.stackPost(stack.id));
    } catch (e) {
      setResults([{ pr: 0, ok: false, error: e instanceof Error ? e.message : String(e) }]);
    }
    setPhase("done");
    await props.reload();
    setSubs(await api.stackSubmission(stack.id).catch(() => []));
  };
  // Your layers: one combined prompt for your coding agent with everything still to fix.
  const minePrompt = mine
    .flatMap((s) => {
      const r = props.reviews[s.reviewId];
      const open = (r?.findings ?? []).filter((f) => f.resolvedRun == null && f.decision !== "dismissed" && f.agentPrompt);
      return open.length ? [`## #${s.pr} (${layerOf(s.pr).headRef})\n${open.map((f) => `- ${f.agentPrompt}`).join("\n")}`] : [];
    })
    .join("\n\n");

  return (
    <div className="mx-auto w-full max-w-[1400px] flex-1 px-[clamp(16px,3vw,32px)] pt-6 pb-12">
      <div className="grid items-start gap-5" style={{ gridTemplateColumns: props.wide ? "minmax(0,1fr) 360px" : "minmax(0,1fr)" }}>
        <div className="flex min-w-0 flex-col gap-3">
          {undecided > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 rounded-xl border border-warn-soft bg-warn-soft px-[18px] py-3.5">
              <span className="text-[14px]">
                <span className="font-semibold">{undecided}</span> undecided finding{undecided === 1 ? "" : "s"} won't be posted.
              </span>
              <button onClick={props.goFindings} className="h-9 cursor-pointer rounded-lg border border-line-strong bg-surface px-3 text-[13px]">
                Back to findings
              </button>
            </div>
          )}
          {subs.map((s) => {
            const l = layerOf(s.pr);
            const mode = modeBadge(s.mine);
            const done = l.state === "submitted" || l.state === "approved";
            return (
              <section key={s.pr} className={`${card} flex flex-col gap-2.5 px-5 py-4`} style={{ opacity: done ? 0.7 : 1 }}>
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                  <span className="flex-none font-mono text-[12.5px] text-fg-3">#{s.pr}</span>
                  <span className="min-w-0 flex-[1_1_220px] text-[15px] leading-[1.4] font-medium">
                    <Inline text={l.title} />
                  </span>
                  <span className={`flex-none rounded border px-[7px] py-px text-[11px] font-semibold ${mode.cls}`}>{mode.label}</span>
                  {(done || l.state === "changed") && <StateChip state={l.state} />}
                </div>
                {l.summary && (
                  <p className="m-0 text-[14px] leading-[1.55] text-pretty text-fg-2">
                    <Inline text={l.summary} />
                  </p>
                )}
                {s.canPost && (
                  <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
                    <div role="radiogroup" aria-label="Post as" className="flex max-w-full gap-0.5 overflow-x-auto rounded-lg border border-line bg-sunken p-0.5">
                      {EVENTS.map((e) => {
                        const on = s.event === e.key;
                        return (
                          <button
                            key={e.key}
                            onClick={() => pick(s.pr, e.key)}
                            role="radio"
                            aria-checked={on}
                            className={`h-8 flex-none cursor-pointer rounded-md border-0 px-3 text-[13px] font-semibold whitespace-nowrap ${on ? (e.key === "REQUEST_CHANGES" ? "bg-surface text-del shadow-seg" : e.key === "APPROVE" ? "bg-surface text-add shadow-seg" : "bg-surface text-fg shadow-seg") : "bg-transparent text-fg-2"}`}
                          >
                            {e.label}
                          </button>
                        );
                      })}
                    </div>
                    <span className="text-[13px] text-fg-2">
                      {s.comments} comment{s.comments === 1 ? "" : "s"}
                    </span>
                    {s.event === s.suggestedEvent && <span className="text-[12.5px] text-fg-3">Suggested</span>}
                  </div>
                )}
                {s.mine && <p className="m-0 text-[13px] text-fg-3">Self-reviewed: {s.openFindings ? `${s.openFindings} to fix` : "nothing left to fix"}. Never posted.</p>}
                {!s.mine && !s.canPost && !done && <p className="m-0 text-[13px] text-fg-3">{l.state === "changed" ? "Changed since your review: re-review it from Layers first." : "Not ready to post yet."}</p>}
              </section>
            );
          })}
        </div>
        <aside className="flex min-w-0 flex-col gap-3.5" style={{ position: props.wide ? "sticky" : "static", top: 68 }}>
          <section className={`${card} flex flex-col gap-3 p-[18px]`}>
            <div>
              <h2 className="m-0 text-[14px] font-semibold">Post to GitHub</h2>
              <p className="m-0 mt-[3px] text-[13px] text-fg-2">{tally}</p>
            </div>
            {top && postable.length > 0 && (
              <button
                onClick={() => {
                  setSummaryOn(!summaryOn);
                  saveSummary(!summaryOn, summary);
                }}
                role="switch"
                aria-checked={summaryOn}
                className="flex min-h-11 cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-left"
              >
                <span className="relative h-[22px] w-10 flex-none rounded-full transition-[background] duration-150" style={{ background: summaryOn ? "var(--accent)" : "var(--line-strong)" }}>
                  <span className="absolute top-[3px] size-4 rounded-full bg-surface transition-[left] duration-150" style={{ left: summaryOn ? 21 : 3 }} />
                </span>
                <span className="flex flex-col">
                  <span className="text-[14px] font-medium">Summary comment on #{top.pr}</span>
                  <span className="text-[12.5px] text-fg-3">Optional. One comment listing every layer's outcome.</span>
                </span>
              </button>
            )}
            {summaryOn && (
              <textarea
                value={summary}
                onChange={(e) => {
                  setSummary(e.target.value);
                  saveSummary(true, e.target.value);
                }}
                rows={8}
                className="block w-full resize-y rounded-lg border border-line-strong bg-bg px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] outline-none focus:border-accent"
              />
            )}
          </section>
          {phase === "idle" && (
            <button
              onClick={() => setPhase("confirm")}
              disabled={!postable.length}
              className={`h-14 rounded-[10px] border-0 text-[15.5px] font-semibold ${postable.length ? "cursor-pointer bg-accent text-on-accent" : "cursor-default bg-sunken text-fg-3"}`}
            >
              {postable.length ? `Post ${postable.length} review${postable.length === 1 ? "" : "s"}` : "Nothing to post"}
            </button>
          )}
          {phase === "confirm" && (
            <section className={`${card} flex flex-col gap-3 border-accent px-[18px] py-4`}>
              <p className="m-0 text-[14px] leading-[1.55]">
                Post {postable.map((s) => `#${s.pr}`).join(", ")} to GitHub as you{summaryOn && top ? `, plus a summary comment on #${top.pr}` : ""}? Each PR gets its own review.
              </p>
              <div className="flex gap-2">
                <button onClick={post} className="h-12 flex-1 cursor-pointer rounded-lg border-0 bg-accent text-[14.5px] font-semibold text-on-accent">
                  Yes, post {postable.length}
                </button>
                <button onClick={() => setPhase("idle")} className="h-12 cursor-pointer rounded-lg border border-line bg-transparent px-3.5 text-[14px] text-fg-2">
                  Cancel
                </button>
              </div>
            </section>
          )}
          {phase === "posting" && (
            <section className={`${card} flex items-center gap-2.5 px-[18px] py-4 text-[14px] font-medium`}>
              <Spinner size={15} />
              Posting…
            </section>
          )}
          {phase === "done" && (
            <section className={`${card} flex flex-col gap-2 px-5 py-[18px]`} style={{ borderColor: results.every((r) => r.ok) ? "var(--add)" : "var(--del)" }}>
              <p className="m-0 flex items-center gap-2 text-[16px] font-semibold">
                <span style={{ color: results.every((r) => r.ok) ? "var(--add)" : "var(--del)" }}>
                  <Sym name={results.every((r) => r.ok) ? "check_circle" : "error"} size={24} fill />
                </span>
                {results.filter((r) => r.ok).length} posted{results.some((r) => !r.ok) ? `, ${results.filter((r) => !r.ok).length} failed` : ""}
              </p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
                {results.map((r, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="font-mono">{r.pr ? `#${r.pr}` : ""}</span>
                    {r.ok ? (
                      <a href={r.url} target="_blank" rel="noreferrer">
                        View on GitHub
                      </a>
                    ) : (
                      <span className="text-del">{r.error}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {mine.length > 0 && (
            <section className={`${card} flex flex-col gap-2.5 p-[18px]`}>
              <div>
                <h2 className="m-0 text-[14px] font-semibold">Your layers: ready check</h2>
                <p className="m-0 mt-[3px] text-[12.5px] leading-normal text-fg-3">Self-reviewed. Nothing here is posted.</p>
              </div>
              <ul className="m-0 flex list-none flex-col p-0">
                {mine.map((s) => (
                  <li key={s.pr} className="flex items-start gap-2.5 border-t border-line py-2.5">
                    <span className="mt-px flex-none" style={{ color: s.openFindings ? "var(--warn)" : "var(--add)" }}>
                      <Sym name={s.openFindings ? "build" : "check_circle"} size={18} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-[13.5px] leading-[1.4] font-medium">
                        <span className="mr-1.5 font-mono text-[12px] text-fg-3">#{s.pr}</span>
                        {plain(layerOf(s.pr).title)}
                      </span>
                      <span className="text-[12.5px] text-fg-3">{s.openFindings ? `${s.openFindings} to fix, then re-run it` : "Ready"}</span>
                    </span>
                    <button onClick={() => navigate(`/review/${s.reviewId}`)} className="flex-none cursor-pointer border-0 bg-transparent text-[12.5px] font-medium text-accent">
                      Open
                    </button>
                  </li>
                ))}
              </ul>
              {minePrompt && (
                <button
                  onClick={() => copy(minePrompt, "mine")}
                  className="flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-surface text-[13.5px] font-medium text-fg hover:bg-hover"
                >
                  <Sym name={copied === "mine" ? "check" : "content_copy"} size={17} />
                  {copied === "mine" ? "Copied" : "Copy one prompt for all your fixes"}
                </button>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
