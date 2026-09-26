import { useEffect, useMemo, useRef, useState } from "react";
import type { Finding, MergeMethod, ReviewDetail, SelfPr } from "../../shared/types";
import { prSummary, type PrSummary } from "../../shared/pr";
import { api, readPrompt, useAsync, useCopy, useLayout } from "../api";
import type { SelfPrState } from "../selfPr";
import { SEVERITY } from "./Walkthrough";
import { card, field, Inline, plain, Spinner, Sym, timeAgo } from "./ui";

const locOf = (f: Finding) => (f.path ? `${f.path}${f.line ? `:${f.startLine ? `${f.startLine}-` : ""}${f.line}` : ""}` : "");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Item {
  icon: string;
  color: string;
  status: string;
  strike: boolean;
  titleColor: string;
  order: number;
}

function statusOf(f: Finding): Item {
  if (f.resolvedRun != null) return { icon: "check_circle", color: "var(--add)", status: `Resolved in run ${f.resolvedRun}`, strike: true, titleColor: "var(--text-3)", order: 3 };
  if (f.decision === "dismissed")
    return { icon: "do_not_disturb_on", color: "var(--text-3)", status: `Won’t fix${f.dismissReason ? `: ${f.dismissReason}` : ""}`, strike: false, titleColor: "var(--text-2)", order: 2 };
  if (f.decision === "accepted" && f.stillOpenRun != null)
    return { icon: "error", color: "var(--warn)", status: `Still open after run ${f.stillOpenRun}`, strike: false, titleColor: "var(--text)", order: 0 };
  if (f.decision === "accepted") return { icon: "build", color: "var(--accent)", status: "To fix", strike: false, titleColor: "var(--text)", order: 0 };
  return { icon: "radio_button_unchecked", color: "var(--text-3)", status: "Undecided", strike: false, titleColor: "var(--text)", order: 1 };
}

/** Chips under the hero headline. */
const TONE = {
  add: "bg-add-soft text-add",
  warn: "bg-warn-soft text-warn",
  del: "bg-del-soft text-del",
  mute: "bg-sunken text-fg-2",
  accent: "bg-accent-soft text-accent",
} as const;
type Chip = { label: string; tone: keyof typeof TONE };

const METHODS: Record<MergeMethod, { label: string; verb: string; past: string; hint: (pr: SelfPr) => string; ask: (ref: string, pr: SelfPr) => string }> = {
  merge: {
    label: "Create a merge commit",
    verb: "Merge",
    past: "a merge commit",
    hint: (pr) => `Keeps ${pr.commits === 1 ? "the commit" : `all ${pr.commits} commits`}, plus a merge commit`,
    ask: (ref, pr) => `Merge ${ref} into ${pr.base} with a merge commit?`,
  },
  squash: {
    label: "Squash and merge",
    verb: "Squash and merge",
    past: "squash and merge",
    hint: (pr) => `One commit on ${pr.base}`,
    ask: (ref, pr) => `Squash ${ref} into one commit on ${pr.base}?`,
  },
  rebase: {
    label: "Rebase and merge",
    verb: "Rebase and merge",
    past: "rebase and merge",
    hint: (pr) => `Replays the ${plural(pr.commits, "commit")} onto ${pr.base}`,
    ask: (ref, pr) => `Rebase ${ref}’s ${plural(pr.commits, "commit")} onto ${pr.base}?`,
  },
};

const REV_STATE = {
  requested: { label: "Requested", color: "var(--text-3)", icon: "schedule", fill: false },
  commented: { label: "Commented", color: "var(--text-2)", icon: "chat_bubble", fill: false },
  approved: { label: "Approved", color: "var(--add)", icon: "check_circle", fill: true },
  changes: { label: "Changes requested", color: "var(--del)", icon: "cancel", fill: true },
} as const;

/** Re-run the self-review; shared by the Re-run card and the hero's "new commits" nudge. */
function useRerun(review: ReviewDetail, onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.rerun(review.id);
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, go };
}

/**
 * Self-review's last tab: is it ready, one prompt for your agent, re-run, reviewers, and the PR on
 * GitHub once there is one (found for the branch): checks, reviews, merge, and Done once merged.
 */
export function ReadyCheck({ review, gh, onChanged, onGoFinding }: { review: ReviewDetail; gh: SelfPrState; onChanged: () => void; onGoFinding: (idx: number) => void }) {
  const { wide, mid } = useLayout();
  const side = wide || mid;
  const findings = review.findings;
  const running = review.phase === "reviewing" || review.phase === "read";
  const open = findings.filter((f) => f.resolvedRun == null && f.decision !== "dismissed");
  const toFix = findings.filter((f) => f.decision === "accepted" && f.resolvedRun == null);
  const undecided = findings.filter((f) => !f.decision && f.resolvedRun == null);
  const closed = findings.length - open.length;
  const ready = open.length === 0 && !running;
  const run = review.runNumber;
  const [copied, copy] = useCopy();
  const rerun = useRerun(review, onChanged);

  const pr = gh.pr;
  const S = pr ? prSummary(pr) : null;
  const prOpen = pr?.state === "open";
  const done = pr?.state === "merged" || pr?.state === "closed";
  // Set when you merge from here, so the merged hero can say how.
  const [mergedWith, setMergedWith] = useState<MergeMethod | null>(null);

  // Result of the latest re-run, as chips.
  const delta: Chip[] =
    run > 1
      ? [
          { label: `Run ${run}: ${findings.filter((f) => f.resolvedRun === run).length} resolved`, tone: "add" },
          ...(findings.some((f) => f.stillOpenRun === run && f.resolvedRun == null)
            ? [{ label: `${findings.filter((f) => f.stillOpenRun === run && f.resolvedRun == null).length} still open`, tone: "warn" as const }]
            : []),
        ]
      : [];

  const scope = `\`${review.headRef}\` against \`${review.baseRef}\`${review.dirtyFiles ? ", including uncommitted changes" : ""}`;
  const combined = useMemo(
    () =>
      `Fix these findings from a self-review of ${scope}. Keep each change minimal, leave unrelated code alone, and run the test suite when you are done.\n\n` +
      toFix
        .map((f, i) => `${i + 1}. ${plain(f.title)}${locOf(f) ? ` (${locOf(f)})` : ""}\n${(readPrompt(f.id) ?? f.agentPrompt ?? f.fix ?? f.why).trim()}${f.stillNote ? `\nStill open after run ${f.stillOpenRun}: ${f.stillNote}` : ""}`)
        .join("\n\n"),
    [toFix.map((f) => `${f.id}:${f.stillOpenRun}`).join(","), scope], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [prompt, setPrompt] = useState(combined);
  useEffect(() => setPrompt(combined), [combined]);

  const items = findings
    .map((f, i) => ({ f, i, ...statusOf(f) }))
    .sort((a, b) => a.order - b.order);

  const hero = heroOf({ review, pr, S, running, ready, openCount: open.length, toFix: toFix.length, undecided: undecided.length, delta, mergedWith, loading: gh.loading });

  return (
    <div className="mx-auto w-full max-w-[1400px] flex-1 px-[clamp(16px,3vw,32px)] pt-6 pb-12">
      <div className="grid items-start gap-5" style={{ gridTemplateColumns: side ? "minmax(0,1fr) 340px" : "minmax(0,1fr)" }}>
        <div className="flex min-w-0 flex-col gap-4">
          {gh.error && (
            <p className="m-0 flex flex-wrap items-center gap-x-2 rounded-lg border border-line bg-surface px-4 py-2.5 text-[13px] text-fg-2">
              <Sym name="cloud_off" size={17} className="text-fg-3" />
              Couldn’t check GitHub: {gh.error}
              <button onClick={gh.refresh} className="cursor-pointer border-0 bg-transparent p-0 text-[13px] font-medium text-accent hover:underline">
                Try again
              </button>
            </p>
          )}
          <Hero hero={hero} pr={pr} S={S} rerun={rerun} running={running} />

          {toFix.length > 0 && !done && (
            <section className={`${card} px-[22px] py-5`}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
                <div>
                  <h2 className="m-0 text-[14px] font-semibold">Prompt for your coding agent</h2>
                  <p className="mt-0.5 mb-0 text-[12.5px] text-fg-3">{plural(toFix.length, "finding")} marked Fix, in one prompt</p>
                </div>
                <button
                  onClick={() => copy(prompt, "all")}
                  className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-accent px-3.5 text-[13.5px] font-semibold text-on-accent"
                >
                  <Sym name={copied === "all" ? "check" : "content_copy"} />
                  {copied === "all" ? "Copied" : "Copy prompt"}
                </button>
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={12}
                style={{ background: "var(--code)" }}
                className={`block w-full resize-y px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] ${field}`}
              />
              <p className="mt-2 mb-0 text-[12.5px] text-fg-3">Paste it into your agent, then re-run. Edits here don’t change the findings.</p>
            </section>
          )}

          <section className={`${card} overflow-hidden`}>
            <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 pt-4 pb-3">
              <h2 className="m-0 text-[14px] font-semibold">Checklist</h2>
              <span className="font-mono text-[12px] text-fg-3">
                {closed}/{findings.length} closed
              </span>
            </div>
            {findings.length === 0 && <p className="m-0 px-5 py-4 text-[14px] text-fg-3">No findings. Nothing to fix.</p>}
            <ul className="m-0 flex list-none flex-col gap-0.5 p-1.5">
              {items.map(({ f, i, ...it }) => (
                <li key={f.id}>
                  <button
                    onClick={() => onGoFinding(i)}
                    className="flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-lg border-0 bg-transparent px-3 py-2.5 text-left hover:bg-hover"
                  >
                    <span className="flex flex-none" style={{ color: it.color }}>
                      <Sym name={it.icon} size={20} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-[14px] leading-[1.4] font-medium" style={{ color: it.titleColor, textDecoration: it.strike ? "line-through" : "none" }}>
                        {plain(f.title)}
                      </span>
                      <span className="truncate font-mono text-[11.5px] text-fg-3">
                        {SEVERITY[f.severity].label}
                        {f.lens ? ` · ${f.lens}` : ""}
                        {locOf(f) ? ` · ${locOf(f)}` : ""}
                      </span>
                    </span>
                    <span className="max-w-[40%] flex-none text-right text-[12.5px] font-medium" style={{ color: it.color }}>
                      {it.status}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* On one column with an open PR, the PR's cards come first. */}
        <aside className="top-[68px] flex min-w-0 flex-col gap-4" style={{ position: side ? "sticky" : "static", order: !side && prOpen ? -1 : 0 }}>
          {pr && done && <DoneCard pr={pr} />}
          {pr && prOpen && S && pr.viewer && pr.author === pr.viewer && <MergeCard review={review} pr={pr} S={S} gh={gh} onMerged={(m) => { setMergedWith(m); onChanged(); }} />}
          {!done && (
            <Rerun
              review={review}
              rerun={rerun}
              running={running}
              head={pr && prOpen && pr.newCommits !== 0 ? `${pr.newCommits > 0 ? plural(pr.newCommits, "new commit") : "New commits"} since run ${run}` : null}
            />
          )}
          {!done && <Reviewers review={review} pr={pr} S={S} ready={ready} openCount={open.length} loading={gh.loading} onChanged={onChanged} onRequested={gh.refresh} />}
        </aside>
      </div>
    </div>
  );
}

// ---------- the hero ----------

interface HeroModel {
  tone: "add" | "warn" | "del" | "accent" | "mute";
  icon: string | null;
  headline: string;
  sub: string;
  chips: Chip[];
  meta: Array<{ label: string; mono: string; url: string }>;
  link: { label: string; url: string } | null;
  checks: boolean;
  nudge: string | null;
}

const TONE_COLOR = { add: "var(--add)", warn: "var(--warn)", del: "var(--del)", accent: "var(--accent)", mute: "var(--text-3)" } as const;

function heroOf(c: {
  review: ReviewDetail;
  pr: SelfPr | null;
  S: PrSummary | null;
  running: boolean;
  ready: boolean;
  openCount: number;
  toFix: number;
  undecided: number;
  delta: Chip[];
  mergedWith: MergeMethod | null;
  loading: boolean;
}): HeroModel {
  const base = { chips: [] as Chip[], meta: [], link: null, checks: false, nudge: null };
  const { pr, S } = c;
  if (pr && S && pr.state === "open") {
    const good = S.canMerge;
    const bad = S.blocked?.color === "var(--del)";
    const requested = pr.reviews.some((r) => r.st === "requested");
    const who = pr.viewer && pr.author === pr.viewer ? "You" : pr.author;
    return {
      ...base,
      tone: good ? "add" : bad ? "del" : "accent",
      icon: good ? "check_circle" : bad ? "error" : "rate_review",
      headline: `PR ${S.ref} is open · ${S.status}`,
      sub:
        `Found automatically for ${pr.head}. ${who} opened it ${timeAgo(pr.createdAt)} into ${pr.base}.` +
        (good ? (requested ? " Reviews are optional here, so nothing blocks the merge." : " Nothing blocks the merge.") : ""),
      chips: [
        pr.draft ? { label: "Draft", tone: "mute" } : { label: "Ready for review", tone: "accent" },
        pr.decision === "APPROVED"
          ? { label: "Approved", tone: "add" }
          : pr.decision === "CHANGES_REQUESTED"
            ? { label: "Changes requested", tone: "del" }
            : pr.decision === "REVIEW_REQUIRED"
              ? { label: "Review required", tone: "warn" }
              : requested
                ? { label: "Review requested", tone: "mute" }
                : { label: "No review required", tone: "mute" },
        ...(c.openCount ? [{ label: `${plural(c.openCount, "finding")} open`, tone: "warn" as const }] : []),
      ],
      checks: pr.checks.length > 0,
      nudge:
        pr.newCommits !== 0
          ? `${pr.newCommits > 0 ? plural(pr.newCommits, "new commit") : "New commits"} since run ${c.review.runNumber}. Re-run so the checklist matches what’s on GitHub.`
          : null,
    };
  }
  if (pr && S && pr.state === "merged") {
    const who = pr.mergedBy && pr.mergedBy === pr.viewer ? "You" : (pr.mergedBy ?? "Someone");
    const repoUrl = pr.url.split("/pull/")[0];
    return {
      ...base,
      tone: "add",
      icon: "merge",
      headline: `Merged into ${pr.base}`,
      sub: `${who} merged ${S.ref} ${pr.mergedAt ? timeAgo(pr.mergedAt) : ""}${c.mergedWith ? ` with ${METHODS[c.mergedWith].past}` : ""}.`.replace(" .", "."),
      meta: [
        ...(pr.mergeCommit ? [{ label: "Merge commit", mono: pr.mergeCommit.slice(0, 7), url: `${repoUrl}/commit/${pr.mergeCommit}` }] : []),
        ...(pr.branchDeleted != null ? [{ label: pr.branchDeleted ? "Deleted" : "Kept", mono: pr.head, url: pr.url }] : []),
      ],
    };
  }
  if (pr && S && pr.state === "closed") {
    return {
      ...base,
      tone: "mute",
      icon: "do_not_disturb_on",
      headline: `PR ${S.ref} was closed without merging`,
      sub: `It was closed ${pr.closedAt ? timeAgo(pr.closedAt) : "on GitHub"}. The branch is still there, and your findings haven’t changed.`,
      link: { label: "Reopen on GitHub", url: pr.url },
    };
  }
  if (c.running)
    return { ...base, tone: "accent", icon: null, headline: "Re-running…", sub: "Reviewing your current working tree. Each finding will be marked resolved or still open." };
  if (c.loading && (c.review.openedPrNumber || c.review.prNumber))
    return { ...base, tone: "mute", icon: null, headline: `Checking #${c.review.openedPrNumber || c.review.prNumber} on GitHub…`, sub: "Checks, reviews and whether it can merge." };
  if (c.ready)
    return {
      ...base,
      tone: "add",
      icon: "check_circle",
      headline: "Ready to open a PR",
      sub: "Every finding is resolved or marked won’t fix. Reviewers can spend their time on the change itself.",
      chips: c.delta,
    };
  return {
    ...base,
    tone: "warn",
    icon: "error",
    headline: `${plural(c.openCount, "finding")} still open`,
    sub: `${[c.toFix ? `${c.toFix} to fix` : "", c.undecided ? `${c.undecided} still to decide` : ""].filter(Boolean).join(", ")}. Hand the fixes to your agent, then re-run to confirm.`,
    chips: c.delta,
  };
}

function Hero({ hero, pr, S, rerun, running }: { hero: HeroModel; pr: SelfPr | null; S: PrSummary | null; rerun: ReturnType<typeof useRerun>; running: boolean }) {
  const color = TONE_COLOR[hero.tone];
  const border = hero.tone === "accent" || hero.tone === "mute" ? "var(--line)" : color;
  return (
    <section className="flex items-start gap-3.5 rounded-xl border bg-surface px-6 py-[22px]" style={{ borderColor: border }}>
      {hero.icon ? (
        <span className="flex flex-none" style={{ color }}>
          <Sym name={hero.icon} size={30} fill />
        </span>
      ) : (
        <span className="grid size-[30px] flex-none place-items-center">
          <Spinner size={22} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="m-0 text-[21px] leading-[1.3] font-semibold tracking-[-0.01em] text-pretty">{hero.headline}</p>
        <p className="m-0 text-[14.5px] leading-[1.6] text-pretty text-fg-2">{hero.sub}</p>
        {hero.meta.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            {hero.meta.map((m) => (
              <a
                key={m.label}
                href={m.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-sunken px-2.5 text-[12.5px] text-fg-2 hover:border-line-strong hover:text-fg hover:no-underline"
              >
                {m.label}
                <span className="font-mono text-fg">{m.mono}</span>
              </a>
            ))}
          </div>
        )}
        {hero.link && (
          <a href={hero.link.url} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center gap-1 self-start text-[14px] font-medium text-accent">
            {hero.link.label}
            <Sym name="open_in_new" size={16} />
          </a>
        )}
        {hero.chips.length > 0 && !running && (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {hero.chips.map((d) => (
              <span key={d.label} className={`rounded-full px-2.5 py-[3px] text-[12.5px] font-medium ${TONE[d.tone]}`}>
                {d.label}
              </span>
            ))}
          </div>
        )}
        {hero.checks && pr && S && <Checks pr={pr} S={S} />}
        {hero.nudge && (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-lg bg-warn-soft px-3 py-2.5">
            <Sym name="update" size={20} className="text-warn" />
            <span className="min-w-0 flex-[1_1_220px] text-[13.5px] leading-normal text-pretty text-fg">{hero.nudge}</span>
            <button
              onClick={rerun.go}
              disabled={rerun.busy || running}
              className="inline-flex h-9 flex-none cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-[13.5px] font-medium text-fg hover:bg-hover disabled:cursor-default"
            >
              {(rerun.busy || running) && <Spinner />}
              {rerun.busy || running ? "Re-running…" : "Re-run"}
            </button>
          </div>
        )}
        {hero.nudge && rerun.error && <p className="m-0 text-[12.5px] text-del">{rerun.error}</p>}
      </div>
    </section>
  );
}

/** The checks line under an open PR's hero, with a row per check that hasn't passed. */
function Checks({ pr, S }: { pr: SelfPr; S: PrSummary }) {
  const color = S.fails.length ? "var(--del)" : S.runs.length ? "var(--text)" : "var(--add)";
  return (
    <div className="mt-2.5 flex flex-col gap-0.5 border-t border-line pt-3">
      <div className="flex min-h-7 items-center gap-2 text-[14px] font-medium" style={{ color }}>
        {!S.fails.length && S.runs.length > 0 ? <Spinner /> : <Sym name={S.fails.length ? "error" : "check_circle"} fill />}
        {S.checksLine}
      </div>
      {pr.checks
        .filter((c) => c.state !== "pass")
        .map((c) => (
          <a
            key={c.name}
            href={c.url ?? `${pr.url}/checks`}
            target="_blank"
            rel="noreferrer"
            className="-mx-2 flex min-h-9 items-center gap-2 rounded-md py-0 pr-2 pl-[26px] text-[13px] text-fg-2 hover:bg-hover hover:text-fg hover:no-underline"
          >
            <Sym name={c.state === "fail" ? "cancel" : "schedule"} size={16} className={c.state === "fail" ? "text-del" : "text-warn"} />
            <span className="font-mono text-[12.5px] text-fg">{c.name}</span>
            <span className="min-w-0 flex-1 truncate text-fg-3">{c.state === "fail" ? (c.took ? `Failed after ${c.took}` : "Failed") : "Running"}</span>
            <span className="inline-flex flex-none items-center gap-[3px] text-[12.5px]">
              Details
              <Sym name="open_in_new" size={14} />
            </span>
          </a>
        ))}
    </div>
  );
}

// ---------- aside cards ----------

/** Merged or closed: what's left to say, in place of the Re-run and Reviewers cards. */
function DoneCard({ pr }: { pr: SelfPr }) {
  const merged = pr.state === "merged";
  const reviews = pr.reviews.length ? pr.reviews.map((r) => `${r.h} ${REV_STATE[r.st].label.toLowerCase()}`).join(", ") : "None requested";
  const rows: Array<[string, string]> = [
    ["Reviews", reviews],
    ...(merged ? [["Re-run", "Not needed after merge"] as [string, string]] : []),
    ["Branch", `${pr.head}${merged && pr.branchDeleted ? " deleted" : " kept"}`],
  ];
  return (
    <section className={`${card} px-5 py-4`}>
      <h2 className="mt-0 mb-1.5 text-[13px] font-semibold text-fg-3">{merged ? "Done" : "Closed"}</h2>
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map(([label, value], i) => (
          <li key={label} className={`flex items-baseline gap-3 py-2 text-[13.5px] ${i ? "border-t border-line" : ""}`}>
            <span className="w-16 flex-none text-fg-3">{label}</span>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere] text-fg-2">{value}</span>
          </li>
        ))}
      </ul>
      <a href={pr.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex min-h-9 items-center gap-1 text-[13.5px] font-medium text-fg-2 hover:text-fg hover:no-underline">
        View #{pr.number} on GitHub
        <Sym name="open_in_new" size={15} />
      </a>
    </section>
  );
}

/**
 * Merging your own PR: what blocks it, the method, deleting the branch, and a confirm step. The
 * merge itself only runs from "Yes, …" and merges exactly the commit shown here.
 */
function MergeCard({ review, pr, S, gh, onMerged }: { review: ReviewDetail; pr: SelfPr; S: PrSummary; gh: SelfPrState; onMerged: (m: MergeMethod) => void }) {
  const allowed = pr.methods;
  const [method, setMethod] = useState<MergeMethod>(allowed.includes("squash") ? "squash" : (allowed[0] ?? "squash"));
  useEffect(() => {
    if (!allowed.includes(method) && allowed[0]) setMethod(allowed[0]);
  }, [allowed.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const [del, setDel] = useState(true);
  const [step, setStep] = useState<"idle" | "confirm" | "merging">("idle");
  const [readying, setReadying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const B = S.blocked;
  const canMerge = S.canMerge && allowed.length > 0;
  const M = METHODS[method];
  const locked = step !== "idle";

  // Something changed on GitHub while confirming (a push, a failing check): back to the start.
  useEffect(() => {
    if (!canMerge && step === "confirm") setStep("idle");
  }, [canMerge]); // eslint-disable-line react-hooks/exhaustive-deps

  const merge = async () => {
    setStep("merging");
    setError(null);
    try {
      const after = await api.mergePr(review.id, { method, deleteBranch: del && !pr.crossRepo, headSha: pr.headSha });
      gh.set(after);
      onMerged(method);
    } catch (e) {
      setError(errText(e));
      gh.refresh();
    } finally {
      setStep("idle");
    }
  };
  const markReady = async () => {
    setReadying(true);
    setError(null);
    try {
      gh.set(await api.markReady(review.id));
    } catch (e) {
      setError(errText(e));
    } finally {
      setReadying(false);
    }
  };

  const note = pr.draft
    ? "Marks the PR ready on GitHub. Your findings stay private."
    : canMerge
      ? `Merges on GitHub as ${pr.viewer}, after you confirm. Your findings stay private.`
      : !allowed.length
        ? "This repo doesn’t allow merging from here. Your findings stay private."
        : "Unlocks once nothing blocks the merge. Your findings stay private.";

  return (
    <section className={`${card} flex flex-col gap-3 px-[22px] py-5`} style={{ borderColor: canMerge ? "var(--add)" : undefined }}>
      <h2 className="m-0 text-[13px] font-semibold text-fg-3">Merge</h2>
      {B && (
        <>
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 grid size-5 flex-none place-items-center">
              {B.spin ? (
                <Spinner />
              ) : (
                <span className="flex" style={{ color: B.color }}>
                  <Sym name={B.icon} size={20} fill />
                </span>
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[14.5px] leading-[1.4] font-semibold">{B.title}</span>
              <span className="text-[13px] leading-normal text-pretty text-fg-2">{B.sub}</span>
            </div>
          </div>
          {B.links && B.links.length > 0 && (
            <div className="-mt-1 ml-[30px] flex flex-col">
              {B.links.map((l) => (
                <a key={l.label + l.url} href={l.url} target="_blank" rel="noreferrer" className="flex min-h-9 items-center gap-1.5 text-[13px]" style={{ color: l.color }}>
                  <span className="font-mono text-[12.5px]">{l.label}</span>
                  <span className="flex-1" />
                  {l.action}
                  <Sym name="open_in_new" size={14} />
                </a>
              ))}
            </div>
          )}
        </>
      )}
      {canMerge && (
        <>
          <div role="radiogroup" aria-label="Merge method" className="flex flex-col gap-1.5">
            {allowed.map((k) => {
              const on = k === method;
              return (
                <button
                  key={k}
                  onClick={() => setMethod(k)}
                  role="radio"
                  aria-checked={on}
                  disabled={locked}
                  className="flex cursor-pointer items-start gap-3 rounded-[10px] border px-3 py-2.5 text-left disabled:cursor-default"
                  style={{ borderColor: on ? "var(--accent)" : "var(--line)", background: on ? "var(--accent-soft)" : "transparent" }}
                >
                  <span className="mt-0.5 grid size-[18px] flex-none place-items-center rounded-full border-2" style={{ borderColor: on ? "var(--accent)" : "var(--line-strong)" }}>
                    <span className="size-2 rounded-full" style={{ background: on ? "var(--accent)" : "transparent" }} />
                  </span>
                  <span>
                    <span className="block text-[14px] font-semibold">{METHODS[k].label}</span>
                    <span className="block text-[12.5px] text-fg-3">{METHODS[k].hint(pr)}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {!pr.crossRepo && (
            <button
              onClick={() => setDel(!del)}
              role="checkbox"
              aria-checked={del}
              disabled={locked}
              className="flex min-h-11 w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-0.5 py-1 text-left disabled:cursor-default"
            >
              <span
                className="grid size-[18px] flex-none place-items-center overflow-hidden rounded border-2 text-on-accent"
                style={{ borderColor: del ? "var(--accent)" : "var(--line-strong)", background: del ? "var(--accent)" : "transparent" }}
              >
                {del && <Sym name="check" size={14} />}
              </span>
              <span className="text-[13.5px]">
                Delete branch <span className="font-mono text-[12.5px] text-fg-2">{pr.head}</span> after merging
              </span>
            </button>
          )}
        </>
      )}
      {pr.draft && (
        <button
          onClick={markReady}
          disabled={readying}
          className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-0 bg-accent text-[14.5px] font-semibold text-on-accent disabled:cursor-default disabled:opacity-70"
        >
          {readying && <Spinner light />}
          {readying ? "Marking ready…" : "Mark ready for review"}
        </button>
      )}
      {!pr.draft && step === "idle" && (
        <button
          onClick={() => canMerge && setStep("confirm")}
          disabled={!canMerge}
          className="h-12 w-full rounded-lg text-[14.5px] font-semibold"
          style={
            canMerge
              ? { border: 0, background: "var(--accent)", color: "var(--on-accent)", cursor: "pointer" }
              : { border: "1px solid var(--line)", background: "var(--surface)", color: "var(--text-3)", cursor: "default" }
          }
        >
          Merge pull request
        </button>
      )}
      {step === "confirm" && canMerge && (
        <div className="flex flex-col gap-3 rounded-[10px] border border-accent px-4 py-3.5">
          <p className="m-0 text-[14px] leading-[1.55]">
            <strong>{M.ask(S.ref, pr)}</strong>{" "}
            <span className="text-fg-2">
              {del && !pr.crossRepo ? `${pr.head} will be deleted afterwards. ` : ""}This writes to GitHub and can’t be undone from here.
            </span>
          </p>
          <div className="flex gap-2">
            <button onClick={merge} className="h-12 flex-1 cursor-pointer rounded-lg border-0 bg-accent text-[14.5px] font-semibold text-on-accent">
              Yes, {M.verb.toLowerCase()}
            </button>
            <button onClick={() => setStep("idle")} className="h-12 cursor-pointer rounded-lg border border-line bg-transparent px-3.5 text-[14px] text-fg-2 hover:bg-hover">
              Cancel
            </button>
          </div>
        </div>
      )}
      {step === "merging" && (
        <button disabled className="flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface text-[14.5px] font-medium text-fg-2">
          <Spinner />
          Merging into {pr.base}…
        </button>
      )}
      {error && <p className="m-0 text-[12.5px] leading-normal text-del">{error}</p>}
      <p className="m-0 text-[12.5px] leading-normal text-fg-3">{note}</p>
    </section>
  );
}

function Rerun({ review, rerun, running, head }: { review: ReviewDetail; rerun: ReturnType<typeof useRerun>; running: boolean; head: string | null }) {
  const spinning = rerun.busy || running;
  return (
    <section className={`${card} px-[22px] py-5`}>
      <h2 className={`mt-0 mb-1.5 text-[13px] font-semibold ${head ? "text-warn" : "text-fg-3"}`}>{head ?? "Re-run after fixing"}</h2>
      <p className="m-0 text-[13.5px] leading-[1.55] text-fg-2">
        {review.localPath
          ? "Reviews your current working tree and marks each finding resolved or still open. Won’t-fix decisions carry over."
          : "Reviews the PR's latest commits and marks each finding resolved or still open. Won’t-fix decisions carry over."}
      </p>
      <button
        onClick={rerun.go}
        disabled={spinning}
        className="mt-3.5 flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface text-[14px] font-medium text-fg hover:bg-hover disabled:cursor-default"
      >
        {spinning && <Spinner />}
        {spinning ? (review.localPath ? "Reviewing your working tree…" : "Reviewing the latest commits…") : "Re-run review"}
      </button>
      {rerun.error && <p className="mt-2 mb-0 text-[12.5px] text-del">{rerun.error}</p>}
      {review.localPath && (
        <p className="mt-2.5 mb-0 font-mono text-[11.5px] text-fg-3">
          or <span className="text-fg-2">bunny review --rerun</span>
        </p>
      )}
    </section>
  );
}

const HANDLE = /^@?[\w.-]+(\/[\w.-]+)?$/;

/**
 * Reviewers: who's already on the PR, suggestions (CODEOWNERS, recent committers) and anyone you
 * add. Before there's a PR this opens it; after, it requests reviews from the people checked.
 */
function Reviewers({
  review,
  pr,
  S,
  ready,
  openCount,
  loading,
  onChanged,
  onRequested,
}: {
  review: ReviewDetail;
  pr: SelfPr | null;
  S: PrSummary | null;
  ready: boolean;
  openCount: number;
  loading: boolean;
  onChanged: () => void;
  onRequested: () => void;
}) {
  const { data: suggested, error: loadError, loading: suggesting } = useAsync(() => api.reviewers(review.id), [review.id, review.headSha]);
  const [collabs, setCollabs] = useState<Array<{ h: string; sub: string; team: boolean }> | null>(null);
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const onPr = pr?.reviews ?? [];
  const onSet = new Set(onPr.map((r) => r.h.toLowerCase()));
  const me = pr?.viewer?.toLowerCase() ?? "";
  const sugg = (suggested ?? []).filter((r) => !onSet.has(r.handle.toLowerCase()) && !added.includes(r.handle));
  // With no PR yet, suggestions start checked; once the PR exists, you pick who to add.
  const isOn = (h: string) => (pr ? on[h] === true : on[h] !== false);
  const rows = [
    ...sugg.map((r) => ({ handle: r.handle, why: r.why, on: isOn(r.handle), toggle: () => setOn({ ...on, [r.handle]: !isOn(r.handle) }) })),
    ...added.map((h) => {
      const c = collabs?.find((x) => x.h === h);
      return { handle: h, why: c?.team ? `${c.sub} · added by you` : "Added by you", on: true, toggle: () => setAdded(added.filter((x) => x !== h)) };
    }),
  ];
  const pending = rows.filter((r) => r.on).map((r) => r.handle);

  const qq = q.trim().replace(/^@/, "").toLowerCase();
  const cand = (collabs ?? [])
    .filter(
      (x) =>
        x.h.toLowerCase() !== me &&
        !onSet.has(x.h.toLowerCase()) &&
        !added.includes(x.h) &&
        !(sugg.some((r) => r.handle === x.h) && isOn(x.h)) &&
        `${x.h} ${x.sub}`.toLowerCase().includes(qq),
    )
    .slice(0, 6);
  // Nothing matches but it looks like a handle: offer it as typed.
  const typed = qq && !cand.length && HANDLE.test(q.trim()) && !added.includes(q.trim()) ? q.trim() : null;
  const add = (h: string) => {
    if (sugg.some((r) => r.handle === h)) setOn({ ...on, [h]: true });
    else setAdded([...added, h]);
    setQ("");
    setFlash("");
  };
  const loadCollabs = () => {
    if (collabs) return;
    setCollabs([]);
    api.collaborators(review.id).then(setCollabs, () => setCollabs([]));
  };
  const listOpen = focus && (cand.length > 0 || !!qq);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.openPr(review.id, pending);
      setOn({});
      setAdded([]);
      if (pr) setFlash(`Requested ${pending.join(", ")} just now.`);
      onChanged();
      onRequested();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const canMerge = !!S?.canMerge;
  const primary = pr ? pending.length > 0 && !canMerge : ready;
  const disabled = busy || loading || (!!pr && pending.length === 0);
  const cta = busy
    ? pr
      ? "Requesting…"
      : "Opening…"
    : loading
      ? "Checking GitHub…"
      : pr
        ? pending.length
          ? `Request review from ${pending.length === 1 ? pending[0] : `${pending.length} people`}`
          : "Request review"
        : ready
          ? `Open PR${pending.length ? ` with ${plural(pending.length, "reviewer")}` : ""}`
          : "Open PR anyway";
  const note = pr
    ? flash
      ? `${flash} Your findings stay private.`
      : pending.length
        ? "Only the people checked above get a request. Your findings stay private."
        : "Check or add someone to request a review."
    : ready
      ? `Runs gh pr create for ${review.headRef}. Reviewers are optional. Your findings stay private.`
      : `${plural(openCount, "finding")} ${openCount === 1 ? "is" : "are"} still open. Your findings stay private either way.`;

  return (
    <section className={`${card} px-[22px] py-5`}>
      <h2 className="mt-0 mb-2 text-[13px] font-semibold text-fg-3">Reviewers</h2>
      {onPr.length > 0 && S && (
        <>
          <p className="m-0 text-[12px] font-semibold text-fg-3">On {S.ref}</p>
          <ul className="m-0 mb-1.5 flex list-none flex-col p-0">
            {onPr.map((o) => {
              const v = REV_STATE[o.st];
              return (
                <li key={o.h} className="flex min-h-11 items-center gap-3 px-0.5 py-1">
                  <span className="grid w-[18px] flex-none place-items-center" style={{ color: v.color }}>
                    <Sym name={v.icon} size={18} fill={v.fill} />
                  </span>
                  <span className="min-w-0 flex-1 font-mono text-[13px]">{o.h}</span>
                  <span className="flex-none text-[12.5px] font-medium" style={{ color: v.color }}>
                    {v.label}
                  </span>
                </li>
              );
            })}
          </ul>
          {rows.length > 0 && <p className="mt-1 mb-0 border-t border-line pt-2.5 text-[12px] font-semibold text-fg-3">Not requested yet</p>}
        </>
      )}
      {suggesting && !suggested && (
        <p className="m-0 flex items-center gap-2 py-2 text-[13px] text-fg-3">
          <Spinner size={11} /> Checking CODEOWNERS and recent history…
        </p>
      )}
      {loadError && <p className="m-0 text-[12.5px] text-del">{loadError}</p>}
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map((r) => (
          <li key={r.handle}>
            <button
              onClick={r.toggle}
              role="checkbox"
              aria-checked={r.on}
              className="flex min-h-[52px] w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-0.5 py-1.5 text-left"
            >
              <span
                className="grid size-[18px] flex-none place-items-center overflow-hidden rounded border-2 text-on-accent"
                style={{ borderColor: r.on ? "var(--accent)" : "var(--line-strong)", background: r.on ? "var(--accent)" : "transparent" }}
              >
                {r.on && <Sym name="check" size={14} />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="font-mono text-[13px]">{r.handle}</span>
                <span className="text-[12.5px] leading-[1.45] text-fg-3">
                  <Inline text={r.why} />
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {suggested && rows.length === 0 && onPr.length === 0 && (
        <p className="m-0 text-[13.5px] leading-[1.55] text-pretty text-fg-2">No one suggested. Add a reviewer{pr ? ", or merge it yourself" : ""}.</p>
      )}
      <div className="relative mt-2.5">
        <Sym name="person_add" size={18} className="pointer-events-none absolute top-[13px] left-[11px] text-fg-3" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setFocus(true);
          }}
          onFocus={() => {
            setFocus(true);
            loadCollabs();
          }}
          onBlur={() => setFocus(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && qq && (cand[0] || typed)) {
              e.preventDefault();
              add(cand[0]?.h ?? typed!);
            } else if (e.key === "Escape") {
              setQ("");
              setFocus(false);
              inputRef.current?.blur();
            }
          }}
          placeholder="Add a collaborator or team"
          aria-label="Add a collaborator or team"
          role="combobox"
          aria-expanded={listOpen}
          className={`block h-11 w-full pr-3 pl-9 text-[14px] ${field}`}
        />
        {listOpen && (
          <ul
            role="listbox"
            className="absolute top-12 right-0 left-0 z-20 m-0 list-none rounded-[10px] border border-line bg-surface p-1 shadow-[0_8px_24px_oklch(0.2_0.02_80/0.16)]"
          >
            {cand.map((m, i) => (
              <li key={m.h}>
                <button
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(m.h);
                  }}
                  role="option"
                  aria-selected={i === 0 && !!qq}
                  className={`flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-md border-0 px-2.5 py-1.5 text-left hover:bg-hover ${i === 0 && qq ? "bg-hover" : "bg-transparent"}`}
                >
                  <Sym name={m.team ? "groups" : "person"} className="text-fg-3" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-mono text-[13px] text-fg">{m.h}</span>
                    {m.sub && <span className="text-[12px] text-fg-3">{m.sub}</span>}
                  </span>
                </button>
              </li>
            ))}
            {typed && (
              <li>
                <button
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(typed);
                  }}
                  role="option"
                  aria-selected
                  className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-hover px-2.5 py-1.5 text-left"
                >
                  <Sym name="person_add" className="text-fg-3" />
                  <span className="text-[13px] text-fg-2">
                    Add <span className="font-mono text-fg">{typed}</span>
                  </span>
                </button>
              </li>
            )}
            {!cand.length && !typed && qq && <li className="p-2.5 text-[13px] text-fg-3">No collaborator or team matches “{q.trim()}”.</li>}
          </ul>
        )}
      </div>
      <button
        onClick={go}
        disabled={disabled}
        className="mt-3 h-12 w-full rounded-lg text-[14.5px] font-semibold disabled:cursor-default"
        style={{
          border: primary && !disabled ? 0 : "1px solid var(--line-strong)",
          background: primary && !disabled ? "var(--accent)" : "var(--surface)",
          color: primary && !disabled ? "var(--on-accent)" : disabled ? "var(--text-3)" : "var(--text)",
          cursor: disabled ? "default" : "pointer",
        }}
      >
        {cta}
      </button>
      <p className="mt-2 mb-0 text-[12.5px] leading-normal text-fg-3">{note}</p>
      {error && <p className="mt-1.5 mb-0 text-[12.5px] text-del">{error}</p>}
    </section>
  );
}
