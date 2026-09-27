// A self-review's PR on GitHub, for the review page: fetched on open, then polled (faster while
// checks run or GitHub is still working out mergeability). Shared by the header, Ready check and
// the bunny.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewDetail, SelfPr } from "../shared/types";
import { prSummary } from "../shared/pr";
import { api } from "./api";

export interface SelfPrState {
  pr: SelfPr | null;
  /** First fetch not back yet. */
  loading: boolean;
  /** A fetch is in flight (the header shows "Checking GitHub…"). */
  syncing: boolean;
  /** When the last fetch came back (ms), for "Updated 20s ago". */
  syncedAt: number | null;
  error: string | null;
  refresh: () => void;
  /** Replace the PR with what a write returned (merge, mark ready). */
  set: (pr: SelfPr) => void;
}

export function useSelfPr(review: ReviewDetail | null): SelfPrState {
  const id = review?.mode === "self" ? review.id : null;
  const [pr, setPr] = useState<SelfPr | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    if (id == null || inFlight.current) return;
    inFlight.current = true;
    setSyncing(true);
    api.selfPr(id).then(
      (p) => {
        setPr(p);
        setError(null);
        setSyncedAt(Date.now());
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    ).finally(() => {
      inFlight.current = false;
      setSyncing(false);
      setLoading(false);
    });
  }, [id]);

  useEffect(() => {
    setPr(null);
    setLoading(true);
    setSyncedAt(null);
    setError(null);
    refresh();
  }, [id, refresh]);

  // Opening the PR from this page links it: fetch again.
  const linkedNumber = review?.openedPrNumber ?? null;
  useEffect(() => {
    if (linkedNumber && !pr) refresh();
  }, [linkedNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll: every 20 s while checks run or mergeability is unknown, else every minute. Only while
  // the PR is open (or not found yet) and the tab is visible.
  const busy = !!pr && pr.state === "open" && (pr.mergeable === "UNKNOWN" || prSummary(pr).runs.length > 0);
  const settled = !!pr && pr.state !== "open";
  useEffect(() => {
    if (id == null || settled) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, busy ? 20_000 : 60_000);
    return () => clearInterval(t);
  }, [id, busy, settled, refresh]);

  return { pr, loading, syncing, syncedAt, error, refresh, set: (p) => { setPr(p); setSyncedAt(Date.now()); } };
}

/** "Updated just now", "Updated 20s ago", "Updated 3m ago"; re-renders every 10 s. */
export function useSyncLabel(syncedAt: number | null, syncing: boolean): string {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);
  if (syncing) return "Checking GitHub…";
  if (syncedAt == null) return "Not checked yet";
  const s = Math.max(0, Math.round((Date.now() - syncedAt) / 1000));
  return s < 10 ? "Updated just now" : s < 60 ? `Updated ${Math.floor(s / 10) * 10}s ago` : `Updated ${Math.floor(s / 60)}m ago`;
}
