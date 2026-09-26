// What a review needs from you next, in words: shared by "On you" and the review home cards.
import type { ActiveRun, ReviewSummary } from "../shared/types";
import { readPos, type ReviewPos } from "./api";
import { timeAgo } from "./components/ui";

export const shortRef = (r: { repo: string; prNumber: number; headRef: string }) =>
  r.prNumber ? `${r.repo.split("/")[1] ?? r.repo}#${r.prNumber}` : r.headRef;

export interface NextStep {
  status: string;
  color: string;
  /** One line on where things stand. */
  detail: string;
  /** Longer sentence for list rows ("Left off on finding 3 of 5. 2 of 5 findings decided."). */
  reason: string;
  /** "Left off on …", when you've been in it before. */
  sub: string | null;
  /** 0–1 for the walk-through progress bar, or null. */
  bar: number | null;
  action: string;
  /** The tab to open. */
  tab: ReviewPos["tab"];
  running: boolean;
}

function leftOff(r: ReviewSummary): string | null {
  const pos = readPos(r.id);
  if (!pos) return null;
  if (pos.tab === "submit") return r.mode === "self" ? "Left off on Ready check" : "Left off on Submit";
  if (pos.tab === "overview") return "Left off on the overview";
  if (pos.tab === "findings" && r.findingsTotal) return `Left off on finding ${Math.min(pos.idx, r.findingsTotal - 1) + 1} of ${r.findingsTotal}`;
  return null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function nextStep(r: ReviewSummary, run?: ActiveRun): NextStep {
  const base = { sub: null, bar: null, running: false };
  if (run || r.phase === "recon_running" || r.phase === "reviewing" || r.phase === "read") {
    const stage = run?.stage ?? (r.phase === "recon_running" ? "recon" : "review");
    return {
      ...base,
      running: true,
      status: stage === "recon" ? "Scanning" : r.mode === "self" && r.runNumber > 1 ? `Re-run ${r.runNumber + 1}` : "Deep review",
      color: "var(--accent)",
      detail: stage === "recon" ? "Overview pending" : "Findings pending",
      reason: stage === "recon" ? "Scanning the change." : "The deep review is running.",
      action: "Overview",
      tab: stage === "recon" ? "overview" : "findings",
    };
  }
  if (r.phase === "failed") {
    const why = (r.error ?? "").split("\n")[0]!.slice(0, 90);
    return { ...base, status: "Failed", color: "var(--del)", detail: why || "The last step failed", reason: `The last step failed${why ? `: ${why}` : "."}`, action: "Open", tab: "overview" };
  }
  if (r.phase === "cancelled") {
    return {
      ...base,
      status: "Stopped",
      color: "var(--text-3)",
      detail: r.hasOverview ? "Overview kept" : "Nothing kept",
      reason: r.hasOverview ? "You stopped the deep review. The overview is kept." : "You stopped the overview before it finished.",
      action: r.hasOverview ? "Resume" : "Start again",
      tab: r.hasOverview ? "findings" : "overview",
    };
  }
  if (r.phase === "recon_ready") {
    return { ...base, status: "Overview ready", color: "var(--accent)", detail: "Not read yet", reason: "The overview is ready. You haven't read it.", action: "Read", tab: "overview" };
  }
  const sub = leftOff(r);
  if (r.mode === "self") {
    const open = r.findingsOpen;
    const undecided = r.findingsTotal - r.findingsDecided;
    if (r.openedPrNumber) {
      return { ...base, status: `PR #${r.openedPrNumber} opened`, color: "var(--add)", detail: "Done", reason: `You opened #${r.openedPrNumber}.`, action: "View", tab: "submit" };
    }
    if (open === 0) {
      return { ...base, status: "Ready", color: "var(--add)", detail: `Run ${r.runNumber} · all closed`, reason: "All findings closed. Ready to open the PR.", action: "Open PR", tab: "submit" };
    }
    if (undecided === r.findingsTotal) {
      return { ...base, status: "Ready to walk through", color: "var(--add)", detail: plural(r.findingsTotal, "finding"), reason: `${plural(r.findingsTotal, "finding")} to go through.`, action: "Walk through", tab: "findings" };
    }
    return {
      ...base,
      sub,
      bar: r.findingsTotal ? (r.findingsTotal - open) / r.findingsTotal : null,
      status: `Self-review · run ${r.runNumber}`,
      color: "var(--warn)",
      detail: `${open} of ${r.findingsTotal} open`,
      reason: `${plural(open, "finding")} still open after run ${r.runNumber}.`,
      action: undecided ? "Continue" : "Ready check",
      tab: undecided ? (readPos(r.id)?.tab ?? "findings") : "submit",
    };
  }
  if (r.phase === "submitted") {
    return { ...base, status: "Submitted", color: "var(--add)", detail: "Posted", reason: "Posted.", action: "View", tab: "submit" };
  }
  if (r.findingsTotal === 0) {
    return { ...base, status: "No findings", color: "var(--add)", detail: "Nothing raised", reason: "Nothing was raised. Post a review to finish.", action: "Submit", tab: "submit" };
  }
  if (r.findingsDecided === 0 && !sub) {
    return {
      ...base,
      status: "Ready to walk through",
      color: "var(--add)",
      detail: plural(r.findingsTotal, "finding"),
      reason: `${plural(r.findingsTotal, "finding")} are ready. You haven't opened them.`,
      action: "Walk through",
      tab: "findings",
    };
  }
  if (r.findingsDecided === r.findingsTotal) {
    return {
      ...base,
      status: "Ready to submit",
      color: "var(--warn)",
      detail: `${plural(r.findingsAccepted, "comment")} to post`,
      reason: `All decided, ${plural(r.findingsAccepted, "comment")} to post. Not submitted.`,
      action: "Submit",
      tab: "submit",
    };
  }
  return {
    ...base,
    sub: sub ?? `${r.findingsDecided} of ${r.findingsTotal} decided`,
    bar: r.findingsDecided / r.findingsTotal,
    status: "Walking through",
    color: "var(--accent)",
    detail: `${r.findingsDecided} of ${r.findingsTotal} decided`,
    reason: `${sub ? `${sub}. ` : ""}${r.findingsDecided} of ${r.findingsTotal} findings decided.`,
    action: "Resume",
    tab: readPos(r.id)?.tab ?? "findings",
  };
}

/** Latest review per PR (or branch), newest first: older reviews of the same thing are superseded. */
export function latestPerPr(reviews: ReviewSummary[]): ReviewSummary[] {
  const seen = new Set<string>();
  return reviews.filter((r) => {
    const k = `${r.mode}:${r.repo}:${r.prNumber || r.headRef}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Reviews you haven't finished, touched in the last `days`. */
export function openReviews(reviews: ReviewSummary[], days = 14): ReviewSummary[] {
  const since = Date.now() - days * 86_400_000;
  return latestPerPr(reviews).filter((r) => {
    const t = Date.parse(r.updatedAt.includes("T") ? r.updatedAt : `${r.updatedAt.replace(" ", "T")}Z`);
    if (t < since) return false;
    if (r.mode === "self") return !r.openedPrNumber;
    return r.phase !== "submitted";
  });
}

/** "Approved", "Requested changes · 3 comments", "Self-review · PR opened". */
export function outcome(r: ReviewSummary): { text: string; color: string } {
  if (r.mode === "self") return { text: r.openedPrNumber ? `Self-review · opened #${r.openedPrNumber}` : "Self-review", color: "var(--add)" };
  const n = r.postedComments ? ` · ${plural(r.postedComments, "comment")}` : "";
  if (r.postedEvent === "APPROVE") return { text: `Approved${n}`, color: "var(--add)" };
  if (r.postedEvent === "REQUEST_CHANGES") return { text: `Requested changes${n}`, color: "var(--warn)" };
  return { text: `Commented${n}`, color: "var(--text-2)" };
}

export const ago = (iso: string) => timeAgo(iso);
