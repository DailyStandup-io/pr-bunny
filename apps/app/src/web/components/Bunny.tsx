// PR Bunny, the rail mascot. Its face and speech bubble follow what's going on: working while a
// review runs, a nudge when an update is out, how a self-review is going, what you just posted.
// Pages report their own mood with `useBunnyMood`; the app adds the global ones.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { navigate } from "../api";
import { face } from "@pr-bunny/brand";

/**
 * The expressions: 1 smile, 2 wink, 3 happy, 4 crying, 5 cross, 7 surprised, 8 hearts, 9 wobbly, 10 shades.
 * Null in builds without the (licensed, uncommitted) art; then the bunny is left out entirely.
 */
export const BUNNY_FACES = {
  smile: face(1),
  wink: face(2),
  happy: face(3),
  crying: face(4),
  cross: face(5),
  surprised: face(7),
  hearts: face(8),
  wobbly: face(9),
  shades: face(10),
};
const F = BUNNY_FACES;

export type Mood = "idle" | "working" | "issues" | "fixed" | "clean" | "rejected" | "approved" | "commented" | "update" | "caughtUp" | "error" | "stopped";

const MOODS: Record<Mood, { face: string | null; say: string }> = {
  idle: { face: F.smile, say: "Hi! Pick a PR and I'll take a look." },
  working: { face: F.wobbly, say: "Reading the diff…" },
  issues: { face: F.crying, say: "" },
  fixed: { face: F.shades, say: "All fixed. Ready to open the PR." },
  clean: { face: F.happy, say: "Nothing left to fix. Ready to open the PR." },
  rejected: { face: F.cross, say: "Changes requested." },
  approved: { face: F.hearts, say: "Approved." },
  commented: { face: F.happy, say: "Review posted." },
  update: { face: F.wink, say: "A new version is out. Update from Settings." },
  caughtUp: { face: F.surprised, say: "You're all caught up." },
  error: { face: F.crying, say: "Couldn't reach your coding agent. Check Settings." },
  // Neutral, not sad: you chose to stop it.
  stopped: { face: F.wink, say: "Stopped. Resume whenever you like." },
};

/** What a page wants the bunny to show. `go` runs when the bunny is clicked (a path, or a callback). */
export interface MoodReport {
  mood: Mood;
  say?: string;
  go?: string | (() => void);
}

// ---------- the page's mood (one at a time: the page you're on) ----------

let pageMood: MoodReport | null = null;
const listeners = new Set<() => void>();
const setPageMood = (m: MoodReport | null) => {
  pageMood = m;
  listeners.forEach((l) => l());
};

/** Report this page's mood while it's mounted. Pass null for "nothing to say". */
export function useBunnyMood(report: MoodReport | null) {
  const key = report ? `${report.mood}|${report.say ?? ""}` : "";
  const latest = useRef(report);
  latest.current = report;
  useEffect(() => {
    setPageMood(latest.current);
  }, [key]);
  useEffect(() => () => setPageMood(null), []);
}

export function usePageMood(): MoodReport | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => pageMood,
  );
}

// ---------- the mascot ----------

const REST_AFTER_MS = 20_000;
const CLOSE_AFTER_MS = 3_200;

/**
 * The bunny button. When its mood changes it types the new line into a speech bubble, then after a
 * while settles back to idle (except while working). Hover or focus shows the current line.
 */
export function Bunny({ report, compact = false }: { report: MoodReport; compact?: boolean }) {
  const base = MOODS[report.mood];
  const say = report.say ?? base.say;
  const sig = `${report.mood}|${say}`;
  const [rested, setRested] = useState<string | null>(null);
  const [typed, setTyped] = useState<{ sig: string; n: number } | null>(null);
  const [hover, setHover] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const isFirst = first.current;
    first.current = false;
    setRested(null);
    if (report.mood !== "working" && report.mood !== "idle") timers.push(setTimeout(() => setRested(sig), REST_AFTER_MS));
    // No speech on first load or for idle; otherwise type the line out like it's being said.
    if (isFirst || report.mood === "idle" || !say) {
      setTyped(null);
      return () => timers.forEach(clearTimeout);
    }
    let n = 0;
    setTyped({ sig, n: 0 });
    const step = () => {
      n++;
      setTyped({ sig, n });
      if (n >= say.length) {
        timers.push(setTimeout(() => setTyped(null), CLOSE_AFTER_MS));
        return;
      }
      const ch = say[n - 1]!;
      const d = /[.!?…]/.test(ch) ? 320 : ch === "," ? 180 : ch === " " ? 45 + Math.random() * 50 : 28 + Math.random() * 42;
      timers.push(setTimeout(step, d));
    };
    timers.push(setTimeout(step, 250));
    return () => timers.forEach(clearTimeout);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const isRested = rested === sig && report.mood !== "working";
  const face = isRested ? MOODS.idle.face : base.face;
  const line = isRested ? MOODS.idle.say : say;
  const go = isRested ? undefined : report.go;
  const speaking = typed?.sig === sig;
  const shown = speaking ? say.slice(0, typed!.n) : line;
  const onClick = () => {
    if (typeof go === "string") navigate(go);
    else go?.();
  };

  if (!face) return null; // a build without the bunny art

  if (compact) {
    return (
      <button
        onClick={onClick}
        aria-label={`PR Bunny: ${line}`}
        className="grid flex-1 cursor-pointer place-items-center border-0 bg-transparent"
      >
        <img src={face} alt="" className="block size-9 [image-rendering:pixelated]" />
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      aria-label={`PR Bunny: ${line}`}
      className={`relative grid h-14 w-[60px] place-items-center rounded-[10px] border-0 bg-transparent p-0 hover:bg-hover ${go ? "cursor-pointer" : "cursor-default"}`}
    >
      <img src={face} alt="" className="block size-[38px] [image-rendering:pixelated]" />
      {(hover || speaking) && line && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-2.5 left-[calc(100%+12px)] z-[42] w-max max-w-[240px] rounded-[10px] bg-fg px-3 py-2 text-left text-[13px] leading-[1.45] whitespace-normal text-bg shadow-tip"
        >
          <span className="absolute bottom-3.5 -left-1 size-[9px] rotate-45 bg-fg" />
          {/* The full line sits invisibly underneath so the bubble doesn't resize while typing. */}
          <span className="relative grid">
            <span aria-hidden className="invisible [grid-area:1/1]">
              {speaking ? say : line}
            </span>
            <span className="[grid-area:1/1]">
              {shown}
              {speaking && typed!.n < say.length && <span className="ml-px inline-block h-[1em] w-0.5 bg-current align-[-2px] opacity-70" />}
            </span>
          </span>
        </span>
      )}
    </button>
  );
}
