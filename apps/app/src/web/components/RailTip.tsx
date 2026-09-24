import { useEffect, useSyncExternalStore, type ReactNode } from "react";

/**
 * One popover open on the rail at a time: tooltips and the Inbox card share this, so hovering any
 * rail button closes whatever else was showing, instantly (including the Inbox card's linger).
 */
let active: string | null = null;
let closing: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const set = (id: string | null) => {
  if (closing) clearTimeout(closing);
  closing = null;
  if (active === id) return;
  active = id;
  listeners.forEach((l) => l());
};

export function useRailPopover(id: string) {
  const open = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => active === id,
  );
  useEffect(() => () => void (active === id && set(null)), [id]);
  return {
    open,
    show: () => set(id),
    /** `linger` keeps it open briefly so the pointer can cross into a card; another show() cancels it. */
    hide: (linger = 0) => {
      if (active !== id) return;
      if (!linger) return set(null);
      if (closing) clearTimeout(closing);
      closing = setTimeout(() => active === id && set(null), linger);
    },
  };
}

/** Gap between the rail button and anything that pops out of it, shared by tooltips and cards. */
export const RAIL_GAP = 10;

/** Pill to the right of a rail button. Colours come from --tooltip-* (the popover surface), so it follows the theme. */
export const railTipClass =
  "pointer-events-none absolute top-1/2 left-[calc(100%+10px)] z-42 -translate-y-1/2 rounded-[7px] border border-tooltip-line bg-tooltip px-2.5 py-1.5 text-[12.5px] whitespace-nowrap text-tooltip-fg shadow-tip";

/** Shows `label` beside the wrapped rail button, instantly on hover or keyboard focus. */
export function RailTip({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const { open, show, hide } = useRailPopover(id);
  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={() => hide()} onFocus={show} onBlur={() => hide()} onClick={() => hide()}>
      {children}
      {open && (
        <span role="tooltip" className={railTipClass}>
          {label}
        </span>
      )}
    </div>
  );
}
