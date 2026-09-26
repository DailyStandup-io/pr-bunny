// Stop and tidy up: the Stop button with its light confirm, the "Stopping…" / "Stopped" states,
// the undo toast, and the small popover they share. Used by the review page, the review home
// cards, the inbox and the stack page. Everything they do is local: nothing is posted to GitHub.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ReviewDetail } from "../../shared/types";
import { api, navigate, useAgentLabel, useNow } from "../api";
import { BUNNY_FACES } from "./Bunny";
import { Kbd, RunMeta, Sym } from "./ui";

/** Runs younger than this stop without a confirm. */
export const CONFIRM_AFTER_MS = 30_000;
/** "Still going after 20 s? Force stop". */
export const FORCE_AFTER_MS = 20_000;

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return Boolean(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable));
};

/** A pixel bunny face, or nothing in builds without the (licensed, uncommitted) art. */
export function BunnyFace({ face, size }: { face: string | null; size: number }) {
  if (!face) return null;
  return <img src={face} alt="" className="block flex-none [image-rendering:pixelated]" style={{ width: size, height: size }} />;
}

/** Grey spinner for "winding down": no longer working, just stopping. */
export function GreySpinner({ size = 12 }: { size?: number }) {
  return <span className="pb-spin inline-block flex-none rounded-full border-2 border-line-strong border-t-fg-3" style={{ width: size, height: size }} />;
}

// ---------- confirm popover ----------

/**
 * A small confirm anchored under its trigger (not a modal). Focus lands on the safe button; Enter
 * still confirms, since you already asked once. Esc or a click outside closes it.
 */
export function ConfirmPop(props: {
  title: string;
  body: ReactNode;
  cancel: string;
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
  extra?: ReactNode;
  children?: ReactNode;
  align?: "left" | "right";
  up?: boolean;
  width?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    safe.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      } else if (e.key === "Enter" && !isTyping(e)) {
        e.preventDefault();
        props.onConfirm();
      }
    };
    const click = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener("keydown", key);
    const t = setTimeout(() => window.addEventListener("mousedown", click), 0);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", click);
      clearTimeout(t);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={props.title}
      className={`absolute z-40 flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-3.5 text-left shadow-pop ${props.align === "left" ? "left-0" : "right-0"} ${props.up ? "bottom-[calc(100%+8px)]" : "top-[calc(100%+8px)]"}`}
      style={{ width: props.width ?? 300 }}
    >
      <div className="flex flex-col gap-[3px]">
        <span className="text-[14px] font-semibold text-fg">{props.title}</span>
        <span className="text-[13px] leading-normal text-pretty text-fg-2">{props.body}</span>
      </div>
      {props.children}
      <div className="flex justify-end gap-2">
        <button
          ref={safe}
          onClick={props.onClose}
          title={`${props.cancel} · Esc`}
          className="h-[30px] cursor-pointer rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] font-medium text-fg hover:bg-hover"
        >
          {props.cancel}
        </button>
        <button
          onClick={props.onConfirm}
          title={`${props.confirm} · ↵`}
          className="h-[30px] cursor-pointer rounded-lg border-0 bg-del px-2.5 text-[13px] font-medium text-on-accent hover:shadow-[0_0_0_3px_var(--del-soft-2)]"
        >
          {props.confirm}
        </button>
      </div>
      {props.extra}
    </div>
  );
}

// ---------- Stop on the review page ----------

export interface StopTarget {
  reviewId: number;
  stage: "recon" | "review";
  /** When the running step started (ms), for "under 30 s: no confirm". */
  startedAt: number | null;
  /** Set when the review is a layer of a stack running Review all: "Stop layer 2 of 5". */
  layer?: { stackId: number; pos: number; size: number } | null;
  /** Deep review of a self-review re-run: its earlier findings are kept. */
  rerun?: boolean;
}

function stopCopy(t: StopTarget): { title: string; body: string; confirm: string } {
  if (t.layer) return { title: `Stop layer ${t.layer.pos} of ${t.layer.size}?`, body: "Other layers keep going. The across-the-stack pass will skip this PR.", confirm: "Stop layer" };
  if (t.stage === "recon") return { title: "Stop the overview?", body: "It's not done yet, so nothing is kept.", confirm: "Stop" };
  if (t.rerun) return { title: "Stop this re-run?", body: "Your findings from the last run are kept.", confirm: "Stop" };
  return { title: "Stop this review?", body: "The overview is kept. You can resume where it stopped.", confirm: "Stop" };
}

/**
 * The Stop button that sits next to a run's progress: quiet at rest, red on hover or focus, ⌘. from
 * anywhere on the page. Under 30 s it stops at once; after that it asks in a small popover.
 */
export function StopControl({ target, stoppingAt, onStopping }: { target: StopTarget; stoppingAt: number | null; onStopping: (at: number) => void }) {
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const copy = stopCopy(target);
  const label = target.layer ? "Stop layer" : "Stop";

  const stop = async () => {
    setAsking(false);
    setErr(null);
    onStopping(Date.now());
    try {
      await api.cancel(target.reviewId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const request = () => {
    if (stoppingAt) return;
    if (target.startedAt != null && Date.now() - target.startedAt < CONFIRM_AFTER_MS) stop();
    else setAsking(true);
  };
  const latest = useRef(request);
  latest.current = request;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        latest.current();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  if (stoppingAt)
    return (
      <button disabled className="inline-flex h-[30px] flex-none items-center rounded-lg border border-line bg-sunken px-2.5 text-[13px] font-medium text-fg-3">
        Stopping…
      </button>
    );
  return (
    <span className="relative flex-none">
      <button
        onClick={request}
        title={`${target.layer ? "Stop this layer" : target.stage === "recon" ? "Stop the overview" : "Stop review"} · ⌘.`}
        aria-keyshortcuts="Meta+Period"
        className="inline-flex h-[30px] cursor-pointer items-center gap-[5px] rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] font-medium text-fg-2 hover:border-del hover:bg-del-soft hover:text-del focus-visible:border-del focus-visible:bg-del-soft focus-visible:text-del focus-visible:outline-none"
      >
        <Sym name="stop_circle" size={16} />
        {label}
      </button>
      {asking && (
        <ConfirmPop
          title={copy.title}
          body={copy.body}
          cancel="Keep running"
          confirm={copy.confirm}
          onConfirm={stop}
          onClose={() => setAsking(false)}
          extra={
            target.layer ? (
              <button onClick={() => navigate(`/stack/${target.layer!.stackId}`)} className="cursor-pointer self-start border-0 bg-transparent p-0 text-[12.5px] text-accent hover:underline">
                Stop the whole stack instead
              </button>
            ) : undefined
          }
        />
      )}
      {err && <span className="absolute top-[calc(100%+6px)] right-0 w-max max-w-[260px] text-[12px] text-del">{err}</span>}
    </span>
  );
}

/** Under a stopping run: after 20 s, offer Force stop (settles it now; the agent is killed). */
export function ForceStop({ reviewId, stoppingAt }: { reviewId: number; stoppingAt: number }) {
  const now = useNow(true);
  const [busy, setBusy] = useState(false);
  if (now - stoppingAt < FORCE_AFTER_MS) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line px-[18px] py-2.5 text-[12.5px] text-fg-3">
      Still going after 20 s?
      <button
        onClick={async () => {
          setBusy(true);
          try {
            await api.cancel(reviewId, true);
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
        className="cursor-pointer border-0 bg-transparent p-0 text-[12.5px] font-medium text-del hover:underline disabled:opacity-50"
      >
        Force stop
      </button>
      <span>· loses unsaved work</span>
    </div>
  );
}

// ---------- the stopped review ----------

/** A review you stopped: what was kept, and Resume / Start again. The bunny is neutral: you chose this. */
export function StoppedCard({ review, onChanged, children }: { review: ReviewDetail; onChanged: (r: ReviewDetail) => void; children?: ReactNode }) {
  const agent = useAgentLabel();
  const [busy, setBusy] = useState<"resume" | "restart" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const hasOverview = review.recon != null;
  const reviewRuns = review.runs.filter((r) => r.kind === "review").length;
  const canResume = hasOverview && reviewRuns > 0;
  const run = async (kind: "resume" | "restart") => {
    setBusy(kind);
    setErr(null);
    try {
      onChanged(kind === "resume" ? (await api.resume(review.id)).review : await api.restart(review.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex gap-3.5 p-4">
          <BunnyFace face={BUNNY_FACES.wink} size={40} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[14.5px] font-semibold">{hasOverview ? "Review stopped" : "Overview stopped"}</span>
            <span className="text-[13px] leading-normal text-pretty text-fg-2">
              {hasOverview
                ? `You stopped the deep review. The overview is kept${canResume ? `, and Resume picks up where ${agent} stopped` : ""}.`
                : "It hadn't finished, so nothing was kept."}
            </span>
            <span className="font-mono text-[11.5px] text-fg-3">stopped by you{review.error ? ` · ${review.error}` : ""}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3.5 sm:pl-[70px]">
          {canResume && (
            <button
              onClick={() => run("resume")}
              disabled={busy !== null}
              className="inline-flex h-8 cursor-pointer items-center gap-[5px] rounded-lg border-0 bg-accent px-3 text-[13px] font-medium text-on-accent disabled:opacity-60"
            >
              <Sym name="play_arrow" size={16} />
              {busy === "resume" ? "Resuming…" : "Resume"}
            </button>
          )}
          <button
            onClick={() => run("restart")}
            disabled={busy !== null}
            className="inline-flex h-8 cursor-pointer items-center gap-[5px] rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium hover:bg-hover disabled:opacity-60"
          >
            <Sym name="restart_alt" size={16} className="text-fg-3" />
            {busy === "restart" ? "Starting…" : "Start again"}
          </button>
          <span className="ml-1 text-[12px] text-fg-3">
            {canResume ? `Resume continues ${agent}'s session; Start again reviews from scratch` : hasOverview ? "Start again runs the deep review from scratch" : "Start again runs the overview from scratch"}
          </span>
        </div>
        {err && <p className="m-0 px-4 pb-3 text-[13px] text-del">{err}</p>}
      </section>
      {children}
      <RunMeta runs={review.runs} />
    </div>
  );
}

// ---------- undo toast ----------

export interface ToastSpec {
  msg: string;
  /** Undo (Z). */
  undo?: () => void | Promise<void>;
  /** Another action instead of Undo ("Start again"). */
  action?: { label: string; go: () => void };
}

/** One toast at a time, 6 s, with Undo on Z. Returns the element to render and `show`. */
export function useToast(): [ReactNode, (t: ToastSpec | null) => void] {
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = (t: ToastSpec | null) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(t);
    if (t) timer.current = setTimeout(() => setToast(null), 6000);
  };
  const current = useRef(toast);
  current.current = toast;
  const undo = () => {
    const t = current.current;
    if (!t?.undo) return;
    show(null);
    t.undo();
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "z" && current.current?.undo) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const node = toast ? (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-50 flex h-11 max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3.5 rounded-[10px] bg-fg py-0 pr-2 pl-4 whitespace-nowrap text-bg shadow-pop"
    >
      <span className="truncate text-[13px]">{toast.msg}</span>
      {toast.undo && (
        <button onClick={undo} className="inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[7px] border-0 bg-transparent px-2.5 text-[13px] font-semibold text-bg hover:bg-[oklch(0.5_0_0/0.25)]">
          Undo
          <span className="font-mono text-[11px] opacity-60">Z</span>
        </button>
      )}
      {toast.action && (
        <button
          onClick={() => {
            show(null);
            toast.action!.go();
          }}
          className="inline-flex h-[30px] cursor-pointer items-center rounded-[7px] border-0 bg-transparent px-2.5 text-[13px] font-semibold text-bg hover:bg-[oklch(0.5_0_0/0.25)]"
        >
          {toast.action.label}
        </button>
      )}
    </div>
  ) : null;
  return [node, show];
}

/** The keyboard hints row under a list. */
export function KeyHints({ keys }: { keys: Array<[string, string]> }) {
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 px-1 text-[12px] text-fg-3">
      {keys.map(([k, what]) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <Kbd>{k}</Kbd>
          {what}
        </span>
      ))}
    </div>
  );
}
