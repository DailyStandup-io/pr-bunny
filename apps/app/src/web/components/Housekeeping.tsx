// Settings › Housekeeping additions: clearing finished reviews, keeping failed ones, and the full
// list of PRs hidden from the inbox. Saved as you change them (not through the Settings save bar).
// All local: clearing and hiding never touch GitHub.
import { useEffect, useState } from "react";
import type { HousekeepingPrefs } from "../../shared/types";
import { api } from "../api";
import { setHiddenItems, useHiddenItems } from "../hidden";
import { field, Sym } from "./ui";

const CLEAR_OPTIONS: Array<[number, string]> = [
  [0, "Never"],
  [1, "After 1 day"],
  [3, "After 3 days"],
  [7, "After 7 days"],
  [14, "After 14 days"],
  [30, "After 30 days"],
];
const SHOWN = 3;

function Line({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line px-[22px] py-[18px]">
      <div className="min-w-0 flex-[1_1_260px]">
        <p className="m-0 text-[14.5px] font-medium">{label}</p>
        <p className="mt-0.5 mb-0 text-[13px] leading-normal text-fg-3">{hint}</p>
      </div>
      {children}
    </div>
  );
}

export function HousekeepingExtras() {
  const [prefs, setPrefs] = useState<HousekeepingPrefs | null>(null);
  // The app-wide hidden list, so restoring here brings the PR back on the rail and the inbox too.
  const snap = useHiddenItems();
  const hidden = snap.loaded ? snap.items : null;
  const [all, setAll] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.housekeeping().then(setPrefs, (e) => setErr(String(e.message ?? e)));
  }, []);

  const save = async (patch: Partial<HousekeepingPrefs>) => {
    setErr(null);
    if (prefs) setPrefs({ ...prefs, ...patch });
    try {
      setPrefs(await api.saveHousekeeping(patch));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const restore = async (keys: string[]) => {
    try {
      setHiddenItems(await api.unhide(keys));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const list = hidden ?? [];
  const shown = all ? list : list.slice(0, SHOWN);
  return (
    <>
      <Line label="Clear finished reviews" hint="Posted and stopped reviews leave your lists after this long with no activity. Nothing on GitHub changes.">
        <select
          value={prefs?.clearFinishedDays ?? 0}
          disabled={!prefs}
          onChange={(e) => save({ clearFinishedDays: Number(e.target.value) })}
          className={`h-10 px-3 text-[14px] ${field}`}
        >
          {CLEAR_OPTIONS.map(([n, label]) => (
            <option key={n} value={n}>
              {label}
            </option>
          ))}
        </select>
      </Line>
      <Line label="Keep failed reviews" hint="Until you retry or remove them. Off clears them with the finished ones.">
        <button
          role="switch"
          aria-checked={prefs?.keepFailed ?? true}
          disabled={!prefs}
          onClick={() => prefs && save({ keepFailed: !prefs.keepFailed })}
          className={`relative h-[26px] w-11 flex-none cursor-pointer rounded-full border-0 ${prefs?.keepFailed ?? true ? "bg-accent" : "bg-line-strong"}`}
        >
          <span className="absolute top-[3px] size-5 rounded-full bg-surface shadow-seg transition-[left]" style={{ left: prefs?.keepFailed ?? true ? 21 : 3 }} />
        </button>
      </Line>
      <div className="flex flex-col py-[14px]">
        <div className="flex items-center gap-3.5 px-[22px] pb-1.5">
          <p className="m-0 flex-1 text-[14.5px] font-medium">Hidden from inbox</p>
          <span className="text-[13px] text-fg-3 tabular-nums">{list.length}</span>
        </div>
        {hidden && list.length === 0 && <p className="m-0 px-[22px] text-[13px] text-fg-3">Nothing hidden. Hide PRs from the inbox with E, or the eye icon on a row.</p>}
        {shown.map((h) => (
          <div key={h.key} className="flex items-center gap-2.5 px-[22px] py-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px]">
              {h.title} {h.meta && <span className="font-mono text-[11.5px] text-fg-3">{h.meta}</span>}
            </span>
            <span className="flex-none text-[12px] text-fg-3">{h.mode === "good" ? "For good" : "Until it changes"}</span>
            <button
              onClick={() => restore([h.key])}
              className="h-[26px] flex-none cursor-pointer rounded-md border border-line-strong bg-surface px-2 text-[12px] font-medium text-fg hover:border-accent hover:text-accent"
            >
              Restore
            </button>
          </div>
        ))}
        {list.length > 0 && (
          <div className="flex gap-4 px-[22px] pt-1.5">
            {list.length > SHOWN && (
              <button onClick={() => setAll(!all)} className="cursor-pointer border-0 bg-transparent p-0 text-[13px] font-medium text-accent">
                {all ? "Show fewer" : `Show all ${list.length}`}
              </button>
            )}
            {list.length > 1 && (
              <button onClick={() => restore(list.map((h) => h.key))} className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[13px] font-medium text-accent">
                <Sym name="undo" size={15} />
                Restore all
              </button>
            )}
          </div>
        )}
      </div>
      {err && <p className="m-0 border-t border-line px-[22px] py-3 text-[13px] text-del">{err}</p>}
    </>
  );
}
