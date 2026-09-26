// Where a self-review's PR stands: what blocks the merge, the checks line, the list indicator.
// Shared by the server (the snapshot the lists read) and the Ready check.
import type { PrSnapshot, SelfPr } from "./types";

export interface Blocker {
  key: "draft" | "conflicts" | "failed" | "running" | "checking" | "protected";
  title: string;
  sub: string;
  icon: string;
  color: string;
  spin?: boolean;
  links?: Array<{ label: string; action: string; url: string; color: string }>;
}

export interface PrSummary {
  ref: string;
  fails: SelfPr["checks"];
  runs: SelfPr["checks"];
  blocked: Blocker | null;
  /** "in review", "approved", "changes requested", "draft", "merged", "closed". */
  status: string;
  checksLine: string;
  /** The list pill's indicator: [icon, colour, tooltip]. */
  ind: [string, string, string];
  canMerge: boolean;
}

const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;

/**
 * Blockers, first match wins: draft, conflicts, failed checks, running checks, GitHub still
 * working out mergeability, branch protection. The review decision only blocks through protection.
 */
export function prSummary(p: SelfPr): PrSummary {
  const ref = `#${p.number}`;
  const fails = p.checks.filter((c) => c.state === "fail");
  const runs = p.checks.filter((c) => c.state === "running");
  const total = p.checks.length;
  const conflicting = p.mergeable === "CONFLICTING" || p.mergeStateStatus === "DIRTY";
  const blocked: Blocker | null =
    p.state !== "open"
      ? null
      : p.draft
        ? { key: "draft", icon: "edit_note", color: "var(--text-2)", title: "This PR is a draft", sub: "Mark it ready for review before merging. Anyone already requested gets notified." }
        : conflicting
          ? {
              key: "conflicts",
              icon: "call_split",
              color: "var(--del)",
              title: `Conflicts with ${p.base}`,
              sub: `Merge or rebase ${p.base} into ${p.head} locally, push, then re-run.`,
              links: [{ label: "Resolve conflicts", action: "On GitHub", url: `${p.url}/conflicts`, color: "var(--text-2)" }],
            }
          : fails.length
            ? {
                key: "failed",
                icon: "error",
                color: "var(--del)",
                title: `${n(fails.length, "check")} failed`,
                sub: "Fix them and push. Merging stays blocked until they pass.",
                links: fails.map((c) => ({ label: c.name, action: "Details", url: c.url ?? `${p.url}/checks`, color: "var(--del)" })),
              }
            : runs.length
              ? { key: "running", icon: "", spin: true, color: "var(--warn)", title: `Waiting for ${n(runs.length, "check")}`, sub: `${joinAnd(runs.map((c) => c.name))}. This updates on its own.` }
              : p.mergeable === "UNKNOWN"
                ? { key: "checking", icon: "", spin: true, color: "var(--warn)", title: "GitHub is checking the merge", sub: "It works out whether this can merge after each push. This updates on its own." }
                : p.protection
                  ? { key: "protected", icon: "lock", color: "var(--warn)", title: "Blocked by branch protection", sub: `${p.protection} on ${p.base}.` }
                  : null;
  const status =
    p.state === "merged"
      ? "merged"
      : p.state === "closed"
        ? "closed"
        : p.draft
          ? "draft"
          : p.decision === "APPROVED"
            ? "approved"
            : p.decision === "CHANGES_REQUESTED"
              ? "changes requested"
              : "in review";
  const passed = total - fails.length - runs.length;
  const checksLine = !total
    ? "No checks"
    : fails.length
      ? `${fails.length} of ${n(total, "check")} failed`
      : runs.length
        ? `Waiting for ${n(runs.length, "check")}`
        : `${passed} of ${n(total, "check")} passed`;
  const ind: [string, string, string] = fails.length
    ? ["cancel", "var(--del)", checksLine]
    : runs.length
      ? ["schedule", "var(--warn)", checksLine]
      : p.decision === "CHANGES_REQUESTED"
        ? ["cancel", "var(--del)", "Changes requested"]
        : p.decision === "APPROVED"
          ? ["check_circle", "var(--add)", `Approved · ${checksLine}`]
          : ["check_circle", "var(--text-3)", checksLine];
  return { ref, fails, runs, blocked, status, checksLine, ind, canMerge: p.state === "open" && !blocked };
}

export function snapshotOf(p: SelfPr): PrSnapshot {
  const s = prSummary(p);
  return { number: p.number, state: p.state, status: s.status, checksLine: s.checksLine, failing: s.fails.length, base: p.base, mergedAt: p.mergedAt, ind: s.ind };
}

export function parseSnapshot(json: string | null | undefined): PrSnapshot | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as PrSnapshot;
  } catch {
    return null;
  }
}

function joinAnd(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

/** The status pill for a self-review with a PR: "In review · #9" (+ indicator), "Done · merged", "Closed". */
export function pillOf(s: PrSnapshot): { status: string; bg: string; color: string; ind: PrSnapshot["ind"] | null } {
  if (s.state === "merged") return { status: "Done · merged", bg: "var(--add-soft)", color: "var(--add)", ind: null };
  if (s.state === "closed") return { status: "Closed", bg: "var(--sunken)", color: "var(--text-3)", ind: null };
  return { status: `In review · #${s.number}`, bg: "var(--accent-soft)", color: "var(--accent)", ind: s.ind };
}
