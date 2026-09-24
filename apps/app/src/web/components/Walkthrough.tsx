import { useEffect, useRef, useState } from "react";
import type { Finding, ReviewDetail, Severity, SnippetLine } from "../../shared/types";
import { api, readPos, readPrompt, savePos, savePrompt, useAgentLabel, useCopy, useLayout } from "../api";
import { Markdown } from "./Markdown";
import type { ProgressLine } from "./ProgressFeed";
import { card, cardLabel, field, Inline, Kbd, plain, Spinner, Sym } from "./ui";

export const SEVERITY: Record<Severity, { label: string; c: string; soft: string }> = {
  critical: { label: "Critical", c: "var(--del)", soft: "var(--del-soft)" },
  high: { label: "High", c: "var(--high)", soft: "var(--high-soft)" },
  medium: { label: "Medium", c: "var(--warn)", soft: "var(--warn-soft)" },
  low: { label: "Low", c: "var(--text-3)", soft: "var(--sunken)" },
};

const VERDICT: Record<NonNullable<ReviewDetail["verdict"]>, { text: string; cls: string }> = {
  approve: { text: "Approve", cls: "bg-add-soft text-add" },
  merge_with_followups: { text: "Merge with follow-ups", cls: "bg-warn-soft text-warn" },
  address_before_merge: { text: "Address before merge", cls: "bg-del-soft text-del" },
};

export const DISMISS_REASONS = ["False positive", "Handled elsewhere", "Not worth raising", "Out of scope for this PR", "Intentional"];
export const SELF_REASONS = ["Intentional", "Follow-up PR", "False positive", "Will squash on merge", "Not worth it"];

const location = (f: Finding) => `${f.path}${f.line ? `:${f.startLine ? `${f.startLine}-` : ""}${f.line}` : ""}`;

export function Walkthrough({
  review,
  qaLines,
  onChanged,
  onGoSubmit,
}: {
  review: ReviewDetail;
  qaLines: ProgressLine[];
  onChanged: () => void;
  onGoSubmit: () => void;
}) {
  const { wide, mid, narrow, stickyBottom } = useLayout();
  const findings = review.findings;
  const self = review.mode === "self";
  const agent = useAgentLabel();
  const locked = !self && review.phase === "submitted";
  const firstUndecided = findings.findIndex((f) => !f.decision && f.resolvedRun == null);
  const saved = readPos(review.id);
  const [index, setIndexState] = useState(
    saved?.tab === "findings" && saved.idx < findings.length ? saved.idx : firstUndecided >= 0 ? firstUndecided : 0,
  );
  const setIndex = (next: number | ((i: number) => number)) =>
    setIndexState((i) => {
      const v = typeof next === "function" ? next(i) : next;
      savePos(review.id, { tab: "findings", idx: v });
      return v;
    });
  const [copied, copy] = useCopy();
  const [showSummary, setShowSummary] = useState(false);
  const f = findings[Math.min(index, findings.length - 1)];

  const [comment, setComment] = useState(f?.comment ?? "");
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const [tip, setTip] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const askRef = useRef<HTMLTextAreaElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const askStart = useRef(0);

  // Reset per-finding drafts when moving to another finding (or it's edited server-side).
  useEffect(() => {
    setComment(f?.comment ?? "");
    setDismissing(false);
    setReason("");
    setError(null);
  }, [f?.id, f?.comment]);

  const decided = findings.filter((x) => x.decision).length;
  const accepted = findings.filter((x) => x.decision === "accepted").length;
  const allDone = findings.length > 0 && findings.every((x) => x.decision || x.resolvedRun != null);
  // Self-review counts: resolved in a re-run, marked Fix and not yet resolved, marked won't fix.
  const resolved = findings.filter((x) => x.resolvedRun != null).length;
  const toFix = findings.filter((x) => x.decision === "accepted" && x.resolvedRun == null).length;
  const wont = findings.filter((x) => x.decision === "dismissed").length;
  const selfReady = findings.every((x) => x.resolvedRun != null || x.decision === "dismissed");
  const [prompt, setPrompt] = useState("");
  useEffect(() => setPrompt((f && readPrompt(f.id)) ?? f?.agentPrompt ?? ""), [f?.id, f?.agentPrompt]);

  const go = (d: number) => setIndex((i) => Math.max(0, Math.min(findings.length - 1, i + d)));
  const nextUndecided = () => {
    const after = findings.findIndex((x, i) => i > index && !x.decision);
    const any = findings.findIndex((x, i) => i !== index && !x.decision);
    const target = after >= 0 ? after : any;
    if (target >= 0) setIndex(target);
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const saveComment = () => (f && comment !== f.comment && comment.trim() ? api.comment(f.id, comment) : Promise.resolve());
  const accept = () =>
    f &&
    act(async () => {
      await saveComment();
      await api.decide(f.id, "accepted");
      nextUndecided();
    });
  const dismiss = (why: string) =>
    f &&
    act(async () => {
      await api.decide(f.id, "dismissed", why || undefined);
      setDismissing(false);
      setReason("");
      nextUndecided();
    });
  const undo = () => f?.decision && act(() => api.decide(f.id, null));
  const startDismiss = () => {
    setDismissing(true);
    setTimeout(() => reasonRef.current?.focus(), 0);
  };
  const focusAsk = () => {
    const el = askRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: Math.max(0, window.scrollY + r.top - (window.innerHeight - r.height) / 2), behavior: reduce ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
  };
  const send = async () => {
    if (!f || !question.trim() || asking) return;
    setAsking(true);
    askStart.current = Date.now();
    const q = question;
    setQuestion("");
    await act(() => api.ask(f.id, q));
    setAsking(false);
  };

  // Keyboard: j/k move · a accept · d dismiss · q ask · u undo. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if ((t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j") go(1);
      else if (k === "k") go(-1);
      else if (locked) return;
      else if (k === "a") accept();
      else if (k === "d") {
        e.preventDefault();
        startDismiss();
      } else if (k === "q") {
        e.preventDefault();
        focusAsk();
      } else if (k === "u") undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const liveQa = asking ? qaLines.filter((l) => l.at >= askStart.current) : [];
  const ghUrl =
    f?.path && `https://github.com/${review.repo}/blob/${review.headSha}/${f.path}${f.line ? `#L${f.startLine ?? f.line}${f.startLine ? `-L${f.line}` : ""}` : ""}`;

  const wtCols = wide ? "260px minmax(0,1fr) 360px" : mid ? "250px minmax(0,1fr)" : "minmax(0,1fr)";
  const wtAreas = wide ? '"list main chat"' : mid ? '"list main" "list chat"' : '"list" "main" "chat"';

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-4 px-[clamp(16px,3vw,32px)] pt-5 pb-6">
      <section className={`${card} py-3 pr-4 pl-[18px]`}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          {self ? (
            <span className={`inline-flex h-7 items-center rounded-full px-3 text-[13px] font-semibold ${selfReady ? "bg-add-soft text-add" : "bg-warn-soft text-warn"}`}>
              {selfReady ? "Ready to open" : "Fix before opening"}
            </span>
          ) : (
            review.verdict && (
              <span className={`inline-flex h-7 items-center rounded-full px-3 text-[13px] font-semibold ${VERDICT[review.verdict].cls}`}>
                {agent}: {VERDICT[review.verdict].text}
              </span>
            )
          )}
          <span className="text-[13.5px] text-fg-2">
            {self
              ? `${findings.length} findings · ${resolved} resolved · ${toFix} to fix · ${wont} won’t fix`
              : `${findings.length} findings · ${decided} decided · ${accepted} to post`}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            {(review.reviewSummary || review.coverage || review.priorStatus.length > 0) && (
              <button
                onClick={() => setShowSummary(!showSummary)}
                className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-lg border border-line bg-transparent px-3 text-[13px] text-fg-2 hover:bg-hover hover:text-fg"
              >
                {showSummary ? "Hide summary" : "Summary & coverage"}
                <Sym name={showSummary ? "expand_less" : "expand_more"} />
              </button>
            )}
            {allDone && !locked && (
              <button onClick={onGoSubmit} className="h-9 cursor-pointer rounded-lg border-0 bg-accent px-3.5 text-[13px] font-semibold text-on-accent">
                {self ? "All decided, ready check →" : "All decided, submit →"}
              </button>
            )}
          </div>
        </div>
        <div
          aria-hidden={!showSummary}
          className="grid transition-[grid-template-rows,opacity] duration-[280ms,200ms] ease-[cubic-bezier(0.2,0,0,1),ease]"
          style={{ gridTemplateRows: showSummary ? "1fr" : "0fr", opacity: showSummary ? 1 : 0 }}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-x-7 gap-y-3 border-t border-line pt-3">
              {review.reviewSummary && (
                <div>
                  <div className={`${cardLabel} mb-1`}>Summary</div>
                  <Markdown text={review.reviewSummary} className="text-[14.5px] leading-[1.6]" />
                </div>
              )}
              {review.coverage && (
                <div>
                  <div className={`${cardLabel} mb-1`}>What was covered</div>
                  <Markdown text={review.coverage} className="text-[14px] leading-[1.6] text-fg-2" />
                </div>
              )}
              {review.priorStatus.length > 0 && (
                <div>
                  <div className={`${cardLabel} mb-1`}>Since your last review</div>
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13.5px] leading-normal">
                    {review.priorStatus.map((p) => (
                      <li key={p.findingId}>
                        <span className={p.status === "addressed" ? "text-add" : p.status === "still_present" ? "text-warn" : "text-fg-3"}>
                          {p.status === "addressed" ? "Addressed" : p.status === "still_present" ? "Still present" : "Unclear"}
                        </span>{" "}
                        · {p.title} <span className="text-fg-3">· <Inline text={p.note} /></span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {!f ? (
        <section className={`${card} px-6 py-10 text-center`}>
          <Sym name="task_alt" size={32} className="text-add" />
          <p className="mt-2 mb-0 text-[17px] font-semibold">No findings</p>
          <p className="mt-1 mb-0 text-[14px] text-fg-2">{agent} didn't find anything worth raising. Check the coverage note, then head to Submit.</p>
          <button onClick={onGoSubmit} className="mt-4 h-10 cursor-pointer rounded-lg border-0 bg-accent px-4 text-[14px] font-semibold text-on-accent">
            Go to submit →
          </button>
        </section>
      ) : (
        <div className="grid items-start gap-4" style={{ gridTemplateColumns: wtCols, gridTemplateAreas: wtAreas }}>
          <aside className={`${card} top-[68px] min-w-0 overflow-hidden [grid-area:list]`} style={{ position: narrow ? "static" : "sticky" }}>
            <div className="border-b border-line px-4 pt-3.5 pb-3">
              <div className="flex items-baseline justify-between">
                <span className="text-[14px] font-semibold">Findings</span>
                <span className="font-mono text-[12px] text-fg-3">
                  {decided}/{findings.length} decided
                </span>
              </div>
              <div className="mt-2.5 flex h-1.5 gap-[3px]">
                {findings.map((x) => (
                  <span key={x.id} className={`flex-1 rounded-[3px] ${x.decision === "accepted" ? "bg-add" : x.decision === "dismissed" ? "bg-line-strong" : "bg-sunken"}`} />
                ))}
              </div>
            </div>
            <ol className="m-0 flex max-h-[calc(100vh-240px)] list-none flex-col gap-0.5 overflow-y-auto p-1.5">
              {findings.map((x, i) => {
                const mark =
                  x.resolvedRun != null ? "check_circle" : x.decision === "accepted" ? (self ? "build" : "check") : x.decision === "dismissed" ? "close" : x.messages.length ? "forum" : "";
                return (
                  <li key={x.id}>
                    <button
                      onClick={() => setIndex(i)}
                      className={`flex w-full cursor-pointer items-start gap-2.5 rounded-lg border-0 py-2.5 pr-2.5 pl-3 text-left hover:bg-hover ${i === index ? "bg-accent-soft" : "bg-transparent"}`}
                    >
                      <span className="mt-[7px] size-2 flex-none rounded-full" style={{ background: SEVERITY[x.severity].c }} />
                      <span className="min-w-0 flex-1">
                        <span className={`block text-[13.5px] leading-[1.4] ${x.decision === "dismissed" || x.resolvedRun != null ? "text-fg-3 line-through" : "text-fg"}`}>{plain(x.title)}</span>
                        <span className="mt-[3px] block text-[12px] text-fg-3">
                          {SEVERITY[x.severity].label}
                          {x.lens ? ` · ${x.lens}` : ""}
                        </span>
                      </span>
                      {mark && (
                        <Sym name={mark} className={`mt-px ${mark === "check" || mark === "check_circle" ? "text-add" : mark === "close" ? "text-fg-3" : "text-accent"}`} />
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
            {!narrow && (
              <div className="flex flex-wrap gap-x-3 gap-y-1.5 border-t border-line px-4 pt-2.5 pb-3.5 text-[11.5px] text-fg-3">
                <span>
                  <Kbd>J</Kbd> <Kbd>K</Kbd> move
                </span>
                {!locked && (
                  <span>
                    <Kbd>U</Kbd> undo
                  </span>
                )}
              </div>
            )}
          </aside>

          <article className="flex min-w-0 flex-col gap-4 [grid-area:main]">
            <div className={`${card} overflow-hidden`}>
              <header className="flex flex-col gap-2.5 px-[22px] pt-[18px] pb-4">
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <span className="font-mono text-fg-3">
                    {index + 1} / {findings.length}
                  </span>
                  <span className="rounded-full px-[9px] py-0.5 font-semibold" style={{ background: SEVERITY[f.severity].soft, color: SEVERITY[f.severity].c }}>
                    {SEVERITY[f.severity].label}
                  </span>
                  {f.lens && <span className="rounded-full border border-line bg-sunken px-[9px] py-0.5 text-fg-2">{f.lens}</span>}
                  {f.confidence && f.confidence !== "high" && <span className="text-fg-3">{f.confidence} confidence</span>}
                  {f.decision && (
                    <span className={`ml-auto rounded-full px-2.5 py-0.5 font-semibold ${f.decision === "accepted" ? "bg-add-soft text-add" : "bg-sunken text-fg-2"}`}>
                      {self
                        ? f.decision === "accepted"
                          ? "Fix"
                          : `Won’t fix${f.dismissReason ? `: ${f.dismissReason}` : ""}`
                        : f.decision === "accepted"
                          ? f.posted
                            ? "Posted"
                            : "Accepted"
                          : `Dismissed${f.dismissReason ? `: ${f.dismissReason}` : ""}`}
                    </span>
                  )}
                </div>
                <h2 className="m-0 text-[20px] leading-[1.35] font-semibold tracking-[-0.005em] text-pretty">
                  <Inline text={f.title} />
                </h2>
                {f.path && (
                  <a
                    href={ghUrl || undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 self-start font-mono text-[12.5px] break-all text-fg-2"
                  >
                    {location(f)}
                    <Sym name="open_in_new" size={15} />
                  </a>
                )}
              </header>
              {/* A resolved finding's lines have moved on; the old snippet would point at the wrong code. */}
              {f.snippet.length > 0 && f.resolvedRun == null && <Snippet lines={f.snippet} />}
              <div className="flex flex-col gap-[18px] px-[22px] pt-5 pb-[22px]">
                <div>
                  <h3 className={`${cardLabel} mb-1.5`}>Why it matters</h3>
                  <Markdown text={f.why} className="text-[15px] leading-[1.65] text-pretty" />
                </div>
                {f.fix && (
                  <div>
                    <h3 className={`${cardLabel} mb-1.5`}>Suggested fix</h3>
                    <Markdown text={f.fix} className="text-[15px] leading-[1.65] text-pretty" />
                  </div>
                )}
                {self && f.stillOpenRun != null && f.resolvedRun == null && (
                  <div className="rounded-[10px] bg-warn-soft px-3.5 py-3 text-[14.5px] leading-[1.55]">
                    <div className="mb-0.5 text-[12.5px] font-semibold text-warn">Still open after run {f.stillOpenRun}</div>
                    <Markdown text={f.stillNote || "Still present in the latest run."} />
                  </div>
                )}
              </div>
            </div>

            {self ? (
              <section className={`${card} px-[22px] pt-[18px] pb-5`}>
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                  <h3 className="m-0 text-[14px] font-semibold">Prompt for your coding agent</h3>
                  <button
                    onClick={() => copy(prompt, "one")}
                    className="inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium text-fg hover:bg-hover"
                  >
                    <Sym name={copied === "one" ? "check" : "content_copy"} size={17} />
                    {copied === "one" ? "Copied" : "Copy prompt"}
                  </button>
                </div>
                <textarea
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    savePrompt(f.id, e.target.value === f.agentPrompt ? null : e.target.value);
                  }}
                  rows={4}
                  style={{ background: "var(--code)" }}
                  className={`mt-2.5 block min-h-28 w-full resize-y px-3.5 py-3 font-mono text-[13px] leading-[1.6] ${field}`}
                />
                <p className="mt-2 mb-0 text-[12.5px] text-fg-3">Findings you mark Fix are combined into one prompt on Ready check.</p>
              </section>
            ) : (
            <section className={`${card} px-[22px] pt-[18px] pb-5`}>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                <h3 className="m-0 text-[14px] font-semibold">Comment to post</h3>
                <span className="inline-flex items-center gap-[5px] text-[12.5px] text-fg-3">
                  <Sym name={f.anchorable ? "subdirectory_arrow_right" : "notes"} size={16} />
                  {f.anchorable ? "Posted inline on the line" : "Line isn't in the diff, so this goes in the review body"}
                </span>
              </div>
              <textarea
                value={comment}
                disabled={locked}
                onChange={(e) => setComment(e.target.value)}
                onBlur={() => act(saveComment)}
                rows={4}
                className={`mt-2.5 block min-h-28 w-full resize-y px-3.5 py-3 font-mono text-[13px] leading-[1.6] disabled:opacity-70 ${field}`}
              />
            </section>
            )}

            {error && <p className="m-0 text-[14px] text-del">{error}</p>}

            <div className="sticky z-15 pb-3" style={{ bottom: stickyBottom }}>
              <div className={`${card} flex flex-wrap items-center gap-1.5 p-2 shadow-bar`}>
                {locked ? (
                  <span className="ml-auto px-2 py-2.5 text-[14px] text-fg-2">This review has been posted.</span>
                ) : self && f.resolvedRun != null ? (
                  <span className="flex min-h-[42px] flex-1 items-center gap-2 px-2 text-[14px] text-fg-2">
                    <Sym name="check_circle" size={20} fill className="text-add" />
                    Resolved in run {f.resolvedRun}. Nothing left to do here.
                  </span>
                ) : dismissing ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      dismiss(reason.trim());
                    }}
                    className="flex min-w-0 flex-[1_1_300px] flex-wrap items-center gap-2"
                  >
                    <span className="mr-1 pl-1 text-[14px] font-semibold">{self ? "Why not fix it?" : "Why dismiss?"}</span>
                    {(self ? SELF_REASONS : DISMISS_REASONS).map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => dismiss(r)}
                        className="h-10 cursor-pointer rounded-full border border-line-strong bg-surface px-3.5 text-[13.5px] hover:border-del hover:text-del"
                      >
                        {r}
                      </button>
                    ))}
                    <input
                      ref={reasonRef}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      onKeyDown={(e) => e.key === "Escape" && setDismissing(false)}
                      placeholder="Or type a reason, Enter to dismiss"
                      className={`h-10 min-w-0 flex-[1_1_200px] px-3 text-[13.5px] ${field}`}
                    />
                    <button type="button" onClick={() => setDismissing(false)} className="h-10 cursor-pointer border-0 bg-transparent px-3 text-[13.5px] text-fg-2">
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="grid min-w-0 flex-[1_1_300px] grid-cols-3 gap-2">
                      <DecisionButton label={self ? "Fix" : "Accept"} icon="check" tip={self ? "Fix it (A)" : "Accept (A)"} tipKey="a" tip_={tip} setTip={setTip} onClick={accept} cls="bg-add-soft text-add hover:bg-add-soft-2" />
                      <DecisionButton label="Ask" icon="forum" tip={`Ask ${agent} (Q)`} tipKey="q" tip_={tip} setTip={setTip} onClick={focusAsk} cls="bg-accent-soft text-accent hover:bg-accent-soft-2" />
                      <DecisionButton label={self ? "Won’t fix" : "Dismiss"} icon="close" tip={self ? "Won’t fix (D)" : "Dismiss (D)"} tipKey="d" tip_={tip} setTip={setTip} onClick={startDismiss} cls="bg-del-soft text-del hover:bg-del-soft-2" />
                    </div>
                    {f.decision && (
                      <button
                        onClick={undo}
                        onMouseEnter={() => setTip("u")}
                        onMouseLeave={() => setTip(null)}
                        onFocus={() => setTip("u")}
                        onBlur={() => setTip(null)}
                        className="relative flex h-[42px] flex-none cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-transparent px-3.5 text-[14px] text-fg-2 hover:bg-hover hover:text-fg"
                      >
                        <Sym name="undo" size={19} />
                        Undo
                        {tip === "u" && <Tip>Undo (U)</Tip>}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </article>

          <section
            className={`${card} top-[68px] flex min-w-0 flex-col overflow-hidden [grid-area:chat]`}
            style={{ position: wide ? "sticky" : "static", maxHeight: wide ? "calc(100vh - 176px)" : "none" }}
          >
            <header className="border-b border-line px-[18px] pt-3.5 pb-3">
              <div className="text-[14px] font-semibold">Ask {agent}</div>
              <div className="text-[12.5px] text-fg-3">Keeps the full review context for this finding</div>
            </header>
            <div className="flex min-h-[180px] flex-1 flex-col gap-3 overflow-y-auto p-4">
              {f.messages.length === 0 && !asking && (
                <p className="m-0 text-[13.5px] leading-[1.55] text-fg-3">Ask whether it's reachable, whether the line is right, or what you'd do instead.</p>
              )}
              {f.messages.map((m) => (
                <div
                  key={m.id}
                  className={`max-w-[92%] rounded-xl border px-3.5 py-2.5 text-[14px] leading-[1.55] ${
                    m.role === "user" ? "self-end border-transparent bg-accent-soft" : "self-start border-line bg-sunken"
                  }`}
                >
                  <div className="mb-0.5 text-[11.5px] font-semibold text-fg-3">{m.role === "user" ? "You" : agent}</div>
                  {m.role === "user" ? <div className="whitespace-pre-wrap">{m.content}</div> : <Markdown text={m.content} />}
                </div>
              ))}
              {asking && (
                <div className="flex items-center gap-2 font-mono text-[12.5px] text-fg-3">
                  <Spinner />
                  {liveQa.at(-1)?.text ?? "Reading the checkout…"}
                </div>
              )}
            </div>
            {!locked && (
              <div className="flex items-end gap-2 border-t border-line p-3">
                <textarea
                  ref={askRef}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                    if (e.key === "Escape") (e.target as HTMLElement).blur();
                  }}
                  rows={2}
                  placeholder="Is this reachable? Is the line right?"
                  className={`min-h-[52px] min-w-0 flex-1 resize-none px-3 py-2.5 text-[14px] leading-[1.45] ${field}`}
                />
                <button
                  onClick={send}
                  disabled={!question.trim() || asking}
                  className="h-[52px] flex-none cursor-pointer rounded-lg border-0 bg-accent px-[18px] text-[14px] font-semibold text-on-accent disabled:cursor-default disabled:opacity-45"
                >
                  Send
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <span className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-30 -translate-x-1/2 rounded-md border border-tooltip-line bg-tooltip px-[9px] py-[5px] text-[12px] font-medium whitespace-nowrap text-tooltip-fg shadow-tip">
      {children}
    </span>
  );
}

function DecisionButton(props: {
  label: string;
  icon: string;
  tip: string;
  tipKey: string;
  tip_: string | null;
  setTip: (k: string | null) => void;
  onClick: () => void;
  cls: string;
}) {
  const on = () => props.setTip(props.tipKey);
  const off = () => props.setTip(null);
  return (
    <button
      onClick={props.onClick}
      onMouseEnter={on}
      onMouseLeave={off}
      onFocus={on}
      onBlur={off}
      className={`relative flex h-[42px] min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border-0 text-[14px] font-semibold ${props.cls}`}
    >
      <Sym name={props.icon} />
      {props.label}
      {props.tip_ === props.tipKey && <Tip>{props.tip}</Tip>}
    </button>
  );
}

export function Snippet({ lines }: { lines: SnippetLine[] }) {
  return (
    <div className="overflow-x-auto border-y border-line bg-code py-2 font-mono text-[12.5px] leading-[1.75]">
      {lines.map((l, i) =>
        l.kind === "gap" ? (
          <div key={i} className="flex min-w-max pr-5 text-fg-3 select-none">
            <span className="w-[5ch] flex-none pr-2.5 text-right">⋯</span>
          </div>
        ) : (
          <div
            key={i}
            className={`flex min-w-max pr-5 ${l.target ? "bg-code-target" : l.kind === "add" ? "bg-code-add" : l.kind === "del" ? "bg-code-del" : ""}`}
          >
            <span className="w-[5ch] flex-none pr-2.5 text-right text-fg-3 select-none">{l.oldNo ?? ""}</span>
            <span className="w-[5ch] flex-none pr-2.5 text-right text-fg-3 select-none">{l.newNo ?? ""}</span>
            <span className={`w-[2.5ch] flex-none select-none ${l.kind === "add" ? "text-add" : l.kind === "del" ? "text-del" : "text-fg-3"}`}>
              {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
            </span>
            <span className="whitespace-pre text-fg">{l.text}</span>
          </div>
        ),
      )}
    </div>
  );
}
