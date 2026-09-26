// The inbox's hidden list, shared by the whole app: the Inbox page, the rail's Inbox card and dot,
// and Settings › Housekeeping all read and update the same copy, so hiding a PR hides it everywhere.
import { useEffect, useSyncExternalStore } from "react";
import type { HiddenItem, InboxEntry } from "../shared/types";
import { api } from "./api";

type Snapshot = { items: HiddenItem[]; loaded: boolean };

let snap: Snapshot = { items: [], loaded: false };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const publish = (next: Snapshot) => {
  snap = next;
  listeners.forEach((l) => l());
};

/** Replace the list with what the server returned after a hide or restore. */
export const setHiddenItems = (items: HiddenItem[]) => publish({ items, loaded: true });

/** Fetch the list (concurrent callers share one request). */
export function loadHidden(): Promise<void> {
  loading ??= api
    .hidden()
    .then(setHiddenItems, () => publish({ ...snap, loaded: true }))
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** The hidden list, refetched whenever a component using it mounts. */
export function useHiddenItems(): Snapshot {
  useEffect(() => {
    loadHidden();
  }, []);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snap,
  );
}

const ms = (t: string) => Date.parse(t.includes("T") ? t : `${t.replace(" ", "T")}Z`);

/** Has the row changed since it was hidden "until it changes"? */
export const changedSince = (item: HiddenItem, stamp?: string) => item.mode === "change" && Boolean(stamp && item.stamp && ms(stamp) > ms(item.stamp));

/** Is the row with this key (last changed at `stamp`) hidden right now? */
export const isHiddenKey = (items: HiddenItem[], key: string, stamp?: string) => {
  const h = items.find((i) => i.key === key);
  return Boolean(h && !changedSince(h, stamp));
};

/** A PR from the inbox, keyed the way the Inbox page hides it. */
export const isHiddenPr = (items: HiddenItem[], p: InboxEntry) => isHiddenKey(items, `pr:${p.repo}#${p.number}`, p.updatedAt);
