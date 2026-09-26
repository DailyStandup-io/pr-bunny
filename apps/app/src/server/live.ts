import type { Server } from "bun";
import type { LiveEvent } from "../shared/types";

/** Recent events per review, replayed to sockets that subscribe mid-run. */
const BACKLOG_LIMIT = 300;
const backlog = new Map<number, LiveEvent[]>();
let server: Server<unknown> | null = null;

export function attachServer(s: Server<unknown>) {
  server = s;
}

export const topic = (reviewId: number) => `review:${reviewId}`;
/** Every review's events, for the rail spinner and the review home's live cards. */
export const ACTIVITY = "activity";

/** Server-side listeners (notifications watch phase changes). */
const listeners = new Set<(ev: LiveEvent) => void>();
export function onEmit(fn: (ev: LiveEvent) => void) {
  listeners.add(fn);
}

/** Pushes a message to every socket subscribed to `topicName` (not kept in any backlog). */
export function publish(topicName: string, data: unknown) {
  server?.publish(topicName, JSON.stringify(data));
}

export function emit(ev: LiveEvent) {
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch (e) {
      console.warn("live listener failed:", e);
    }
  }
  const list = backlog.get(ev.reviewId) ?? [];
  list.push(ev);
  if (list.length > BACKLOG_LIMIT) list.splice(0, list.length - BACKLOG_LIMIT);
  backlog.set(ev.reviewId, list);
  const msg = JSON.stringify(ev);
  server?.publish(topic(ev.reviewId), msg);
  server?.publish(ACTIVITY, msg);
}

export function getBacklog(reviewId: number): LiveEvent[] {
  return backlog.get(reviewId) ?? [];
}

/** The last few progress lines for a review's current run kind. */
export function recentProgress(reviewId: number, kind: "recon" | "review", n = 3): Array<{ text: string; tool?: string; at: number }> {
  return (backlog.get(reviewId) ?? [])
    .filter((e): e is Extract<LiveEvent, { type: "progress" }> => e.type === "progress" && e.runKind === kind)
    .slice(-n)
    .map((e) => ({ text: e.text, tool: e.tool, at: e.at }));
}
