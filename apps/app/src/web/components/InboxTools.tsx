// Clearing the inbox: hide a PR "until it changes" or "for good" (one row or a selection), the
// Hidden tab to bring them back, and the empty inbox. Hiding is local state only: GitHub isn't told.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HiddenItem } from "../../shared/types";
import { api } from "../api";
import { BUNNY_FACES } from "./Bunny";
import { BunnyFace, type ToastSpec } from "./Tidy";
import { Sym, timeAgo } from "./ui";

export type HideMode = HiddenItem["mode"];

/** What a row needs to be hidden. `stamp` is its "last changed" time; newer than when hidden = back. */
export interface Hideable {
  hideKey: string;
  stamp?: string;
  title: string;
  meta: string;
}

const ms = (t: string) => Date.parse(t.includes("T") ? t : `${t.replace(" ", "T")}Z`);

/** Has the row changed since it was hidden "until it changes"? */
export const changedSince = (item: HiddenItem, stamp?: string) => item.mode === "change" && Boolean(stamp && item.stamp && ms(stamp) > ms(item.stamp));

/**
 * The hidden list, with hide/restore that update at once and toast with Undo. Items hidden "until
 * it changes" whose row has moved on are dropped (see `sweep`).
 */
export function useHidden(toast: (t: ToastSpec | null) => void) {
  const [items, setItems] = useState<HiddenItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    api.hidden().then(
      (h) => {
        setItems(h);
        setLoaded(true);
      },
      () => setLoaded(true),
    );
  }, []);
  const byKey = new Map(items.map((i) => [i.key, i]));

  const isHidden = (row: Hideable) => {
    const h = byKey.get(row.hideKey);
    return Boolean(h && !changedSince(h, row.stamp));
  };

  const hide = async (rows: Hideable[], mode: HideMode) => {
    if (!rows.length) return;
    const prev = items;
    const payload = rows.map((r) => ({ key: r.hideKey, mode, stamp: r.stamp ?? null, title: r.title, meta: r.meta }));
    try {
      setItems(await api.hide(payload));
    } catch (e) {
      toast({ msg: e instanceof Error ? e.message : String(e) });
      return;
    }
    const n = rows.length;
    const what = n === 1 ? "PR" : `${n} PRs`;
    toast({
      msg: mode === "good" ? `Hid ${what} for good` : `Hid ${what} until ${n === 1 ? "it changes" : "they change"}`,
      undo: async () => {
        setItems(await api.unhide(payload.map((p) => p.key)));
        // Keys that were already hidden before (e.g. switched mode) go back to how they were.
        const was = prev.filter((p) => payload.some((x) => x.key === p.key));
        if (was.length) setItems(await api.hide(was.map(({ hiddenAt, ...w }) => w)));
      },
    });
  };

  const restore = async (keys: string[]) => {
    const was = items.filter((i) => keys.includes(i.key));
    try {
      setItems(await api.unhide(keys));
    } catch (e) {
      toast({ msg: e instanceof Error ? e.message : String(e) });
      return;
    }
    toast({
      msg: keys.length === 1 ? "Restored to inbox" : `Restored ${keys.length} to the inbox`,
      undo: async () => setItems(await api.hide(was.map(({ hiddenAt, ...w }) => w))),
    });
  };

  /** Forget "until it changes" entries whose row has changed: they're back in the inbox for good. */
  const swept = useRef(new Set<string>());
  const sweep = (rows: Hideable[]) => {
    const back = rows.filter((r) => {
      const h = byKey.get(r.hideKey);
      return h && changedSince(h, r.stamp) && !swept.current.has(r.hideKey);
    });
    if (!back.length) return;
    back.forEach((r) => swept.current.add(r.hideKey));
    api.unhide(back.map((r) => r.hideKey)).then(setItems, () => {});
  };

  return { items, loaded, isHidden, hide, restore, sweep };
}

// ---------- pieces ----------

/** "On you" / "Hidden" tabs. */
export function InboxTabs({ tab, onTab, counts }: { tab: "inbox" | "hidden"; onTab: (t: "inbox" | "hidden") => void; counts: { inbox: number; hidden: number } }) {
  const pill = (on: boolean) =>
    `inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full border px-[11px] text-[12.5px] font-medium ${
      on ? "border-fg bg-fg text-bg" : "border-line bg-surface text-fg-2 hover:border-line-strong"
    }`;
  return (
    <div role="tablist" className="-mt-4 flex items-center gap-1.5">
      <button role="tab" aria-selected={tab === "inbox"} onClick={() => onTab("inbox")} className={pill(tab === "inbox")}>
        On you
        <span className="tabular-nums opacity-70">{counts.inbox}</span>
      </button>
      <button role="tab" aria-selected={tab === "hidden"} onClick={() => onTab("hidden")} className={pill(tab === "hidden")}>
        <Sym name="visibility_off" size={15} />
        Hidden
        <span className="tabular-nums opacity-70">{counts.hidden}</span>
      </button>
    </div>
  );
}

/** The row checkbox: shows on hover or focus, and on every row once anything is selected. */
export function RowCheck({ on, visible, onToggle }: { on: boolean; visible: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-label={on ? "Deselect" : "Select"}
      aria-pressed={on}
      className={`ml-2.5 grid size-7 flex-none cursor-pointer place-items-center border-0 bg-transparent transition-opacity group-hover:opacity-100 focus-visible:opacity-100 ${visible ? "opacity-100" : "opacity-0"}`}
    >
      <span className={`grid size-4 place-items-center rounded border-[1.5px] ${on ? "border-accent bg-accent text-on-accent" : "border-line-strong bg-surface"}`}>
        {on && <Sym name="check" size={13} />}
      </span>
    </button>
  );
}

/** Hide (until it changes), with a split arrow for "for good". */
export function HideButton({ onHide, className = "" }: { onHide: (mode: HideMode) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLSpanElement>(null);
  // The menu is portalled to <body> at fixed coordinates, so rounded lists with overflow-hidden
  // can't clip it. It opens below the button, or above when there's no room.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return setPos(null);
    const place = () => {
      const b = box.current?.getBoundingClientRect();
      if (!b) return;
      const h = menu.current?.offsetHeight ?? 120;
      const below = b.bottom + 4 + h <= window.innerHeight - 8;
      setPos({ top: below ? b.bottom + 4 : Math.max(8, b.top - 4 - h), right: Math.max(8, window.innerWidth - b.right) });
    };
    place();
    requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => [box.current, menu.current].some((el) => el?.contains(t as Node));
    const click = (e: MouseEvent) => !inside(e.target) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", click);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", click);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  const item = (mode: HideMode, icon: string, label: string, sub: string, k: string) => (
    <button
      role="menuitem"
      onClick={() => {
        setOpen(false);
        onHide(mode);
      }}
      className="flex cursor-pointer items-start gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-2 text-left hover:bg-hover"
    >
      <Sym name={icon} size={18} className="mt-px text-fg-3" />
      <span className="flex flex-1 flex-col">
        <span className="text-[13px] font-medium text-fg">{label}</span>
        <span className="text-[12px] text-fg-3">{sub}</span>
      </span>
      <span className="font-mono text-[11px] text-fg-3">{k}</span>
    </button>
  );
  return (
    <span ref={box} className={`relative flex flex-none items-center ${className}`}>
      <button
        onClick={() => onHide("change")}
        title="Hide until it changes · E"
        className="inline-flex h-[30px] cursor-pointer items-center gap-[5px] rounded-l-[7px] border border-line-strong bg-surface px-[9px] text-[12.5px] font-medium text-fg hover:bg-hover"
      >
        <Sym name="visibility_off" size={16} className="text-fg-3" />
        Hide
      </button>
      <button
        onClick={() => setOpen(!open)}
        aria-label="More hide options"
        aria-expanded={open}
        className="-ml-px grid h-[30px] w-[26px] cursor-pointer place-items-center rounded-r-[7px] border border-line-strong bg-surface text-fg-3 hover:bg-hover"
      >
        <Sym name="expand_more" size={16} />
      </button>
      {open &&
        createPortal(
          <span
            ref={menu}
            role="menu"
            style={pos ? { top: pos.top, right: pos.right } : { top: 0, right: 0, visibility: "hidden" }}
            className="fixed z-50 flex w-[280px] flex-col gap-0.5 rounded-xl border border-line bg-surface p-1.5 shadow-pop"
          >
            {item("change", "visibility_off", "Hide until it changes", "Back on new commits or comments", "E")}
            {item("good", "do_not_disturb_on", "Hide for good", "Only back if you restore it", "⇧E")}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** Shown in place of the list header once rows are selected. */
export function SelectionBar({ count, onHide, onClear }: { count: number; onHide: (mode: HideMode) => void; onClear: () => void }) {
  const btn = "inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[7px] border-0 bg-transparent px-2.5 text-[13px] font-medium text-bg hover:bg-[oklch(0.5_0_0/0.25)]";
  return (
    <div className="sticky top-2 z-30 flex h-11 items-center gap-2 rounded-[10px] bg-fg pr-2 pl-3.5 text-bg shadow-pop">
      <span className="text-[13px] font-medium">{count} selected</span>
      <span className="flex-1" />
      <button onClick={() => onHide("change")} className={btn}>
        Hide until {count === 1 ? "it changes" : "they change"}
        <span className="font-mono text-[11px] opacity-60">E</span>
      </button>
      <button onClick={() => onHide("good")} className={btn}>
        Hide for good
        <span className="font-mono text-[11px] opacity-60">⇧E</span>
      </button>
      <button onClick={onClear} aria-label="Clear selection" className={`${btn} w-[30px] justify-center px-0`}>
        <Sym name="close" size={17} />
      </button>
    </div>
  );
}

/** The Hidden tab: everything hidden, with how, and Restore. */
export function HiddenList({ items, onRestore }: { items: HiddenItem[]; onRestore: (keys: string[]) => void }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="m-0 text-[15px] font-semibold">Hidden</h2>
          <span className="text-[13px] text-fg-3">Only on this machine. Nothing changes on GitHub.</span>
        </div>
        {items.length > 1 && (
          <button onClick={() => onRestore(items.map((i) => i.key))} className="cursor-pointer border-0 bg-transparent p-0 text-[13px] font-medium text-accent">
            Restore all
          </button>
        )}
      </div>
      <ul className="m-0 list-none overflow-hidden rounded-xl border border-line bg-surface p-0">
        {items.map((h, i) => (
          <li key={h.key} className={`flex min-h-[64px] flex-wrap items-center gap-3 px-[18px] py-3 ${i ? "border-t border-line" : ""}`}>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[14.5px] font-medium">{h.title}</span>
              <span className="truncate font-mono text-[12px] text-fg-3">
                {h.meta ? `${h.meta} · ` : ""}hidden {timeAgo(h.hiddenAt)}
              </span>
            </span>
            <span className="flex-none rounded-full border border-line bg-sunken px-2 py-0.5 text-[11.5px] font-medium text-fg-3">
              {h.mode === "good" ? "For good" : "Until it changes"}
            </span>
            <button
              onClick={() => onRestore([h.key])}
              className="inline-flex h-[30px] flex-none cursor-pointer items-center gap-[5px] rounded-[7px] border border-line-strong bg-surface px-2.5 text-[12.5px] font-medium text-fg hover:border-accent hover:text-accent"
            >
              <Sym name="undo" size={16} />
              Restore
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The empty inbox (or empty Hidden tab). */
export function InboxEmpty({ hiddenTab, hiddenCount, onShowHidden }: { hiddenTab: boolean; hiddenCount: number; onShowHidden: () => void }) {
  return (
    <div className="flex min-h-[300px] flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed border-line-strong p-8 text-center">
      <BunnyFace face={hiddenTab ? BUNNY_FACES.smile : BUNNY_FACES.happy} size={64} />
      <span className="text-[17px] font-semibold">{hiddenTab ? "Nothing hidden" : "All clear"}</span>
      <span className="max-w-[340px] text-[13.5px] text-pretty text-fg-2">
        {hiddenTab
          ? "PRs you hide show up here."
          : hiddenCount
            ? `Nothing's waiting on you. ${hiddenCount} hidden ${hiddenCount === 1 ? "PR comes" : "PRs come"} back if ${hiddenCount === 1 ? "it changes" : "they change"}.`
            : "Nothing's waiting on you."}
      </span>
      {!hiddenTab && hiddenCount > 0 && (
        <button
          onClick={onShowHidden}
          className="mt-1 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium text-fg hover:border-accent hover:text-accent"
        >
          <Sym name="visibility_off" size={16} />
          Show hidden ({hiddenCount})
        </button>
      )}
    </div>
  );
}
