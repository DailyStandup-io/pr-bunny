import type { ReactNode } from "react";
import type { InboxEntry } from "../../shared/types";
import { RAIL_GAP, railTipClass, useRailPopover } from "./RailTip";
import { PHASE_LABEL, Sym, timeAgo } from "./ui";

const short = (repo: string) => repo.split("/")[1] ?? repo;

/**
 * Wraps the rail's Inbox button: hovering shows the reviews waiting on you, current repo first,
 * or the plain "Inbox" tooltip when nothing is. Shares the rail's one-open-at-a-time state, so it
 * opens instantly and closes as soon as another rail button is hovered; on leave it lingers briefly
 * so the pointer can cross the gap into the card.
 */
export function InboxCard({
  children,
  pending,
  repo,
  onOpenPr,
  onOpenInbox,
}: {
  children: ReactNode;
  pending: InboxEntry[];
  repo: string | null;
  onOpenPr: (p: InboxEntry) => void;
  onOpenInbox: () => void;
}) {
  const { open, show, hide } = useRailPopover("inbox");
  const items = [...pending].sort((a, b) => Number(b.repo === repo) - Number(a.repo === repo));

  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={() => hide(180)} onFocus={show} onBlur={() => hide()} onClickCapture={() => hide()}>
      {children}
      {open && items.length === 0 && (
        <span role="tooltip" className={railTipClass}>
          Inbox
        </span>
      )}
      {open && items.length > 0 && (
        <div className="absolute top-[3px] left-full z-45" style={{ paddingLeft: RAIL_GAP }}>
          <div role="dialog" aria-label="Waiting on you" className="w-[340px] overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
            <div className="flex items-baseline gap-2 px-4 pt-3.5 pb-2.5">
              <span className="text-[22px] leading-none font-semibold">{items.length}</span>
              <span className="text-[13.5px] text-fg-2">{items.length === 1 ? "review waiting on you" : "reviews waiting on you"}</span>
            </div>
            <ul className="m-0 flex list-none flex-col gap-0.5 px-1.5 pt-0 pb-1.5">
              {items.slice(0, 5).map((p) => {
                const phase = p.review ? PHASE_LABEL[p.review.phase] : null;
                return (
                  <li key={p.url}>
                    <button
                      onClick={() => onOpenPr(p)}
                      className="flex min-h-[52px] w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-2 text-left hover:bg-hover"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-px">
                        <span className="truncate text-[13.5px] font-medium">{p.title}</span>
                        <span className="truncate font-mono text-[11.5px] text-fg-3">
                          {short(p.repo)}#{p.number} · {timeAgo(p.updatedAt)}
                          {phase ? ` · ${phase}` : ""}
                        </span>
                      </span>
                      {phase && <span title={phase} className="size-2 flex-none rounded-full bg-accent" />}
                    </button>
                  </li>
                );
              })}
            </ul>
            <button
              onClick={onOpenInbox}
              className="flex h-10 w-full cursor-pointer items-center justify-center gap-1 border-0 border-t border-line bg-sunken text-[13px] font-medium text-accent hover:bg-hover"
            >
              Open Inbox
              <Sym name="arrow_forward" size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
