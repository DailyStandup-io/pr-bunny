// Which agent runs are in flight, per review, so Stop can abort them. Each overview (recon) and
// deep review run claims an AbortController here; aborting it kills the spawned `claude`/`codex`
// process (see killOnAbort in claude.ts). No imports, so anything can use it without a cycle.

export type RunKind = "recon" | "review";

interface Run {
  ctrl: AbortController;
  kind: RunKind;
  startedAt: number;
}

const runs = new Map<number, Run>();

/** Registers a run for the review and returns its controller. A second claim replaces the first. */
export function claimRun(reviewId: number, kind: RunKind): AbortController {
  const ctrl = new AbortController();
  runs.set(reviewId, { ctrl, kind, startedAt: Date.now() });
  return ctrl;
}

/** Forgets the run, unless a newer one has claimed the review since. */
export function releaseRun(reviewId: number, ctrl: AbortController) {
  if (runs.get(reviewId)?.ctrl === ctrl) runs.delete(reviewId);
}

export function hasRun(reviewId: number, kind?: RunKind): boolean {
  const r = runs.get(reviewId);
  return Boolean(r && (!kind || r.kind === kind));
}

/** Aborts the review's run, if any. Returns whether there was one to abort. */
export function abortRun(reviewId: number): boolean {
  const r = runs.get(reviewId);
  if (!r) return false;
  r.ctrl.abort();
  return true;
}
