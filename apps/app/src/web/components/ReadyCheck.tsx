import { useEffect, useMemo, useState } from "react";
import type { Finding, ReviewDetail } from "../../shared/types";
import { api, readPrompt, useAsync, useCopy, useLayout } from "../api";
import { SEVERITY } from "./Walkthrough";
import { card, field, Inline, plain, Spinner, Sym } from "./ui";

const locOf = (f: Finding) => (f.path ? `${f.path}${f.line ? `:${f.startLine ? `${f.startLine}-` : ""}${f.line}` : ""}` : "");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

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

/** Self-review's last tab: is it ready, one prompt for your agent, re-run, reviewers, open the PR. */
export function ReadyCheck({ review, onChanged, onGoFinding }: { review: ReviewDetail; onChanged: () => void; onGoFinding: (idx: number) => void }) {
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

  // Result of the latest re-run, as chips.
  const delta =
    run > 1
      ? [
          { label: `Run ${run}: ${findings.filter((f) => f.resolvedRun === run).length} resolved`, cls: "bg-add-soft text-add" },
          ...(findings.some((f) => f.stillOpenRun === run && f.resolvedRun == null)
            ? [{ label: `${findings.filter((f) => f.stillOpenRun === run && f.resolvedRun == null).length} still open`, cls: "bg-warn-soft text-warn" }]
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

  const headline = running ? "Re-running…" : ready ? "Ready to open a PR" : "Not ready yet";
  const sub = running
    ? "Reviewing your current working tree. Each finding will be marked resolved or still open."
    : ready
      ? "Every finding is resolved or marked won’t fix. Reviewers can spend their time on the change itself."
      : `${[toFix.length ? `${toFix.length} to fix` : "", undecided.length ? `${undecided.length} still to decide` : ""].filter(Boolean).join(", ")}. Hand the fixes to your agent, then re-run to confirm.`;

  return (
    <div className="mx-auto w-full max-w-[1400px] flex-1 px-[clamp(16px,3vw,32px)] pt-6 pb-12">
      <div className="grid items-start gap-5" style={{ gridTemplateColumns: side ? "minmax(0,1fr) 340px" : "minmax(0,1fr)" }}>
        <div className="flex min-w-0 flex-col gap-4">
          <section className="flex items-start gap-3.5 rounded-xl border bg-surface px-6 py-[22px]" style={{ borderColor: ready ? "var(--add)" : "var(--line)" }}>
            {running ? (
              <span className="grid size-[30px] flex-none place-items-center">
                <Spinner size={22} />
              </span>
            ) : (
              <Sym name={ready ? "check_circle" : "pending"} size={30} fill className={ready ? "text-add" : "text-warn"} />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="m-0 text-[21px] leading-[1.3] font-semibold tracking-[-0.01em]">{headline}</p>
              <p className="m-0 text-[14.5px] leading-[1.6] text-pretty text-fg-2">{sub}</p>
              {delta.length > 0 && !running && (
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {delta.map((d) => (
                    <span key={d.label} className={`rounded-full px-2.5 py-[3px] text-[12.5px] font-medium ${d.cls}`}>
                      {d.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </section>

          {toFix.length > 0 && (
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

        <aside className="top-[68px] flex min-w-0 flex-col gap-4" style={{ position: side ? "sticky" : "static" }}>
          <Rerun review={review} running={running} onChanged={onChanged} />
          <Reviewers review={review} ready={ready} openCount={open.length} onChanged={onChanged} />
        </aside>
      </div>
    </div>
  );
}

function Rerun({ review, running, onChanged }: { review: ReviewDetail; running: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.rerun(review.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const spinning = busy || running;
  return (
    <section className={`${card} px-[22px] py-5`}>
      <h2 className="mt-0 mb-1.5 text-[13px] font-semibold text-fg-3">Re-run after fixing</h2>
      <p className="m-0 text-[13.5px] leading-[1.55] text-fg-2">
        {review.localPath
          ? "Reviews your current working tree and marks each finding resolved or still open. Won’t-fix decisions carry over."
          : "Reviews the PR's latest commits and marks each finding resolved or still open. Won’t-fix decisions carry over."}
      </p>
      <button
        onClick={go}
        disabled={spinning}
        className="mt-3.5 flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface text-[14px] font-medium text-fg hover:bg-hover disabled:cursor-default"
      >
        {spinning && <Spinner />}
        {spinning ? (review.localPath ? "Reviewing your working tree…" : "Reviewing the latest commits…") : "Re-run review"}
      </button>
      {error && <p className="mt-2 mb-0 text-[12.5px] text-del">{error}</p>}
      {review.localPath && (
        <p className="mt-2.5 mb-0 font-mono text-[11.5px] text-fg-3">
          or <span className="text-fg-2">bunny review --rerun</span>
        </p>
      )}
    </section>
  );
}

function Reviewers({ review, ready, openCount, onChanged }: { review: ReviewDetail; ready: boolean; openCount: number; onChanged: () => void }) {
  const { data: suggested, error: loadError, loading } = useAsync(() => api.reviewers(review.id), [review.id, review.headSha]);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pr = review.prNumber || review.openedPrNumber;
  const picked = (suggested ?? []).filter((r) => !off[r.handle]).map((r) => r.handle);
  const n = picked.length;

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.openPr(review.id, picked);
      onChanged();
      window.open(res.url, "_blank", "noreferrer");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const opened = review.openedPrNumber != null && !review.prNumber;
  const cta = opened
    ? `Opened #${review.openedPrNumber}`
    : pr
      ? `Request review from ${plural(n, "reviewer")}`
      : ready
        ? `Open PR with ${plural(n, "reviewer")}`
        : "Open PR anyway";
  const note = opened
    ? "Opened on GitHub with the reviewers above."
    : pr
      ? `Adds them to #${pr}. Your findings stay private.`
      : ready
        ? `Runs gh pr create for ${review.headRef}. Your findings stay private.`
        : `${plural(openCount, "finding")} ${openCount === 1 ? "is" : "are"} still open. They stay private either way.`;
  const primary = ready && !opened;

  return (
    <section className={`${card} px-[22px] py-5`}>
      <h2 className="mt-0 mb-2 text-[13px] font-semibold text-fg-3">Suggested reviewers</h2>
      {loading && !suggested && (
        <p className="m-0 flex items-center gap-2 py-2 text-[13px] text-fg-3">
          <Spinner size={11} /> Checking CODEOWNERS and recent history…
        </p>
      )}
      {loadError && <p className="m-0 text-[12.5px] text-del">{loadError}</p>}
      {suggested && suggested.length === 0 && <p className="m-0 py-1 text-[13px] text-fg-3">No CODEOWNERS or recent committers to suggest.</p>}
      <ul className="m-0 flex list-none flex-col p-0">
        {(suggested ?? []).map((r) => {
          const on = !off[r.handle];
          return (
            <li key={r.handle}>
              <button
                onClick={() => setOff({ ...off, [r.handle]: on })}
                role="checkbox"
                aria-checked={on}
                disabled={opened}
                className="flex min-h-[52px] w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-0.5 py-1.5 text-left disabled:cursor-default"
              >
                <span
                  className="grid size-[18px] flex-none place-items-center overflow-hidden rounded border-2 text-on-accent"
                  style={{ borderColor: on ? "var(--accent)" : "var(--line-strong)", background: on ? "var(--accent)" : "transparent" }}
                >
                  {on && <Sym name="check" size={14} />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="font-mono text-[13px]">{r.handle}</span>
                  <span className="text-[12.5px] leading-[1.45] text-fg-3">
                    <Inline text={r.why} />
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        onClick={opened ? () => window.open(`https://github.com/${review.repo}/pull/${review.openedPrNumber}`, "_blank", "noreferrer") : go}
        disabled={busy || (!!pr && !opened && n === 0)}
        className="mt-3 h-12 w-full cursor-pointer rounded-lg text-[14.5px] font-semibold disabled:cursor-default disabled:opacity-60"
        style={{
          border: primary ? 0 : "1px solid var(--line-strong)",
          background: primary ? "var(--accent)" : "var(--surface)",
          color: primary ? "var(--on-accent)" : "var(--text)",
        }}
      >
        {busy ? "Opening…" : cta}
      </button>
      <p className="mt-2 mb-0 text-[12.5px] leading-normal text-fg-3">{note}</p>
      {error && <p className="mt-1.5 mb-0 text-[12.5px] text-del">{error}</p>}
    </section>
  );
}
