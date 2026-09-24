import type { ReactNode } from "react";
import type { ActiveRun } from "../../shared/types";
import { elapsed, useNow } from "../api";
import { RAIL_GAP, railTipClass, useRailPopover } from "./RailTip";
import { Sym } from "./ui";

const short = (repo: string) => repo.split("/")[1] ?? repo;
export const stageLabel = (r: ActiveRun) => (r.stage === "recon" ? (r.mode === "self" ? "Scanning your change" : "Scanning the PR") : "In-depth review in progress");
export const runRef = (r: ActiveRun) => (r.prNumber ? `${short(r.repo)}#${r.prNumber}` : r.headRef);

/**
 * Wraps the rail's Review button. While a scan or deep review runs it shows the live run (stage,
 * elapsed, last three steps); otherwise the plain "Review" tooltip. Shares the rail's
 * one-open-at-a-time state with the other popovers.
 */
export function RunCard({ children, runs, label, onOpen }: { children: ReactNode; runs: ActiveRun[]; label: string; onOpen: (r: ActiveRun) => void }) {
  const { open, show, hide } = useRailPopover("review");
  const run = runs[0];
  const now = useNow(open && !!run);
  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={() => hide(180)} onFocus={show} onBlur={() => hide()} onClickCapture={() => hide()}>
      {children}
      {open && !run && (
        <span role="tooltip" className={railTipClass}>
          {label}
        </span>
      )}
      {open && run && (
        <div className="absolute top-[3px] left-full z-45" style={{ paddingLeft: RAIL_GAP }}>
          <div role="dialog" aria-label={stageLabel(run)} className="w-[340px] overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
            <div className="flex flex-col gap-2.5 px-4 pt-3.5 pb-3">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-[13.5px] font-semibold">{stageLabel(run)}</span>
                <span className="font-mono text-[11.5px] text-fg-3 tabular-nums">{elapsed(run.startedAt, now)}</span>
              </div>
              <div className="flex min-w-0 flex-col gap-px">
                <span className="truncate text-[13.5px] font-medium">{run.title}</span>
                <span className="font-mono text-[11.5px] text-fg-3">
                  {runRef(run)} · {run.author}
                  {runs.length > 1 ? ` · +${runs.length - 1} more running` : ""}
                </span>
              </div>
            </div>
            <div className="border-t border-line bg-code px-4 py-2 font-mono text-[12px] leading-[1.7]">
              {run.lines.length === 0 && <div className="text-fg-3">Starting…</div>}
              {run.lines.map((l, i, arr) => (
                <div key={`${l.at}-${i}`} className="flex min-w-0 gap-2.5">
                  <span className="w-8 flex-none text-right text-fg-3 tabular-nums">{Math.max(0, Math.round((l.at - Date.parse(run.startedAt)) / 1000))}s</span>
                  <span className={`min-w-0 flex-1 truncate ${i === arr.length - 1 ? "text-fg" : "text-fg-3"}`}>{l.text}</span>
                </div>
              ))}
            </div>
            <button
              onClick={() => onOpen(run)}
              className="flex h-10 w-full cursor-pointer items-center justify-center gap-1 border-0 border-t border-line bg-sunken text-[13px] font-medium text-accent hover:bg-hover"
            >
              Open review
              <Sym name="arrow_forward" size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
