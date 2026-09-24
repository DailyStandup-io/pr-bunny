import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewDetail, RiskFlag } from "../../shared/types";
import { api, useAgentLabel, useLayout } from "../api";
import { AreaBars } from "./AreaBars";
import { Markdown } from "./Markdown";
import type { ProgressLine } from "./ProgressFeed";
import { StackRail } from "./StackRail";
import { card, cardLabel, field, Inline, RunMeta, Spinner, Sym } from "./ui";

const RISK: Record<RiskFlag["level"], { label: string; cls: string }> = {
  high: { label: "High", cls: "bg-del-soft text-del" },
  medium: { label: "Med", cls: "bg-warn-soft text-warn" },
  low: { label: "Low", cls: "border border-line bg-sunken text-fg-2" },
};

export function Overview({
  review,
  qaLines,
  onRead,
  onContinue,
}: {
  review: ReviewDetail;
  qaLines: ProgressLine[];
  onRead: () => Promise<void>;
  onContinue: () => void;
}) {
  const recon = review.recon!;
  const { wide, mid, stickyBottom } = useLayout();
  const [showFiles, setShowFiles] = useState(false);
  const [marking, setMarking] = useState(false);
  const isRead = review.readAt != null;
  const files = useMemo(() => [...review.files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions)), [review.files]);

  const markRead = async () => {
    setMarking(true);
    try {
      await onRead();
    } finally {
      setMarking(false);
    }
  };
  const action = () => (isRead ? onContinue() : markRead());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not from the PR chat box: ⌘↵ there shouldn't kick off the deep review.
      if (e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const estDelta = recon.estReviewMinutes - recon.heuristicMinutes;
  const hasFindings = review.phase === "walkthrough" || review.phase === "submitted";

  return (
    <>
      <div
        className="mx-auto grid w-full max-w-[1400px] flex-1 items-start gap-5 px-[clamp(16px,3vw,32px)] pt-6 pb-5"
        style={{ gridTemplateColumns: wide || mid ? "minmax(0,1fr) 340px" : "minmax(0,1fr)" }}
      >
        <div className="flex min-w-0 flex-col gap-5 self-stretch">
          <section className={`${card} px-[26px] py-6`}>
            <h2 className={`${cardLabel} mb-3`}>{review.mode === "self" ? "What this change does" : "What this PR does"}</h2>
            <p className="m-0 text-[19px] leading-[1.45] font-medium text-pretty">
              <Inline text={recon.headline} />
            </p>
            <p className="mt-3.5 mb-0 text-[15px] leading-[1.65] text-pretty text-fg-2">
              <Inline text={recon.summary} />
            </p>
            <div className="mt-[18px] rounded-[10px] border border-line bg-sunken px-4 py-3.5">
              <div className="mb-1 text-[13px] font-semibold text-fg-2">Why</div>
              <p className="m-0 text-[14.5px] leading-[1.6]">
                <Inline text={recon.intent} />
              </p>
            </div>
            {recon.diffTruncated && (
              <p className="mt-3.5 mb-0 text-[12.5px] text-warn">The diff was too large to include in full, so this overview may miss later files.</p>
            )}
            <AskPr review={review} qaLines={qaLines} />
          </section>

          {recon.focusPoints.length > 0 && (
            <section className={`${card} px-[26px] py-[22px]`}>
              <h2 className={`${cardLabel} mb-3.5`}>Where to look hardest</h2>
              <ol className="m-0 flex list-none flex-col gap-3 p-0">
                {recon.focusPoints.map((f, i) => (
                  <li key={i} className="flex gap-3 text-[14.5px] leading-[1.6]">
                    <span className="grid size-6 flex-none place-items-center rounded-md bg-accent-soft font-mono text-[12px] font-medium text-accent">{i + 1}</span>
                    <span>
                      <Inline text={f} />
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className={`${card} px-[26px] py-[22px]`}>
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className={cardLabel}>Where it touches</h2>
              <span className="font-mono text-[12px] text-fg-3">{recon.areas.length} {recon.areas.length === 1 ? "area" : "areas"}</span>
            </div>
            <AreaBars areas={recon.areas} />
            <button
              onClick={() => setShowFiles(!showFiles)}
              className="mt-[18px] inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-transparent px-3 text-[13px] text-fg-2 hover:bg-hover hover:text-fg"
            >
              {showFiles ? "Hide files" : `Show all ${files.length} files`}
              <Sym name={showFiles ? "expand_less" : "expand_more"} />
            </button>
            {showFiles && (
              <ul className="m-0 mt-3 flex list-none flex-col gap-0.5 border-t border-line p-0 pt-2.5">
                {files.map((f) => (
                  <li key={f.path} className="flex justify-between gap-4 py-[3px] font-mono text-[12px]">
                    <span className="truncate text-fg-2">{f.path}</span>
                    <span className="flex-none">
                      <span className="text-add">+{f.additions}</span> <span className="text-del">−{f.deletions}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="sticky z-15 mt-auto pb-3" style={{ bottom: stickyBottom }}>
            <div className={`${card} mx-auto flex w-full max-w-[720px] items-center gap-3 py-2 pr-2 pl-4 shadow-bar`}>
              {isRead ? (
                <p className="m-0 flex min-w-0 flex-1 items-center gap-1.5 text-[14px] text-fg-2">
                  <Sym name="check_circle" size={20} className="text-add" />
                  Read. The deep review {review.phase === "reviewing" || review.phase === "read" ? "is running" : "has run"}.
                </p>
              ) : (
                <p className="m-0 min-w-0 flex-1 text-[14px] text-fg-2">Read the overview, then start the in-depth review.</p>
              )}
              <button
                onClick={action}
                disabled={marking}
                title={isRead ? undefined : "⌘↵"}
                className="ml-auto flex h-[38px] flex-none cursor-pointer items-center justify-center gap-2 rounded-lg border-0 bg-accent px-3.5 text-[13.5px] font-semibold whitespace-nowrap text-on-accent disabled:opacity-60"
              >
                {marking ? "Starting…" : isRead ? "Go to findings →" : "I've read it, start deep review →"}
              </button>
            </div>
          </div>
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          {review.mode === "self" ? (
            <section className={`${card} px-[22px] py-5`}>
              <h2 className={`${cardLabel} mb-1`}>What reviewers will ask</h2>
              <p className="mt-0 mb-3.5 text-[12.5px] leading-normal text-fg-3">Answer these in the PR description and they won’t come up in review.</p>
              {review.reviewerQuestions.length === 0 ? (
                <p className="m-0 text-[13.5px] text-fg-3">Nothing obvious. The change and its commits explain themselves.</p>
              ) : (
                <ol className="m-0 flex list-none flex-col gap-3.5 p-0">
                  {review.reviewerQuestions.map((q, i) => (
                    <li key={i} className="flex flex-col gap-[3px]">
                      <span className="text-[14px] leading-[1.45] font-medium">
                        <Inline text={q.question} />
                      </span>
                      <span className="text-[13px] leading-normal text-fg-2">
                        <Inline text={q.hint} />
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ) : (
          <section className={`${card} px-[22px] py-5`}>
            <h2 className={`${cardLabel} mb-1.5`}>Estimated review time</h2>
            <div className="mt-2 grid grid-cols-2">
              <div className="border-r border-line pr-4">
                <div className="text-[12.5px] text-fg-3">On your own</div>
                <div className="flex items-baseline gap-[5px]">
                  <span className="text-[40px] leading-[1.15] font-semibold tracking-[-0.03em] text-fg-2 tabular-nums">{recon.estReviewMinutes}</span>
                  <span className="text-[14px] text-fg-3">min</span>
                </div>
              </div>
              <div className="pl-4">
                <div className="text-[12.5px] text-accent">With AI assist</div>
                <div className="flex items-baseline gap-[5px]">
                  <span className="text-[40px] leading-[1.15] font-semibold tracking-[-0.03em] tabular-nums">{recon.estAssistedMinutes ?? "—"}</span>
                  {recon.estAssistedMinutes != null && <span className="text-[14px] text-fg-2">min</span>}
                </div>
              </div>
            </div>
            <p className="mt-2 mb-0 text-[12.5px] text-fg-3">
              Line-count heuristic: {recon.heuristicMinutes} min
              {estDelta !== 0 && (
                <span className={estDelta > 0 ? "text-warn" : "text-add"}>
                  {" "}
                  ({estDelta > 0 ? "+" : ""}
                  {estDelta})
                </span>
              )}
              .
              {recon.estAssistedMinutes != null &&
                ` Assisted time covers reading the overview and deciding ${
                  hasFindings ? `${review.findings.length} ${review.findings.length === 1 ? "finding" : "findings"}` : "the findings"
                }.`}
            </p>
            <p className="mt-3 mb-0 text-[13.5px] leading-[1.55] text-fg-2">
              <Inline text={recon.estReasoning} />
            </p>
          </section>
          )}

          <section className={`${card} px-[22px] py-5`}>
            <h2 className={`${cardLabel} mb-3`}>Risk flags</h2>
            {recon.riskFlags.length === 0 ? (
              <p className="m-0 text-[13.5px] text-fg-3">Nothing obvious from the shape of the change.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                {recon.riskFlags.map((r, i) => (
                  <li key={i} className="flex gap-2.5 text-[13.5px] leading-normal">
                    <span className={`mt-0.5 h-fit flex-none rounded px-[7px] py-px text-[11px] font-semibold ${RISK[r.level].cls}`}>{RISK[r.level].label}</span>
                    <span>
                      <Inline text={r.text} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={`${card} px-[22px] py-5`}>
            <h2 className={`${cardLabel} mb-1`}>Stack</h2>
            {review.stack.length === 0 ? (
              <p className="m-0 text-[13.5px] text-fg-3">Standalone. Not part of a stack.</p>
            ) : (
              <StackRail stack={review.stack} self={{ number: review.prNumber, title: review.title, baseRef: review.baseRef }} repo={review.repo} />
            )}
          </section>

          <RunMeta runs={review.runs} />
        </aside>
      </div>

    </>
  );
}

const CHIPS = ["What's riskiest here?", "Which files should I read first?", "How is this tested?"];

/** "Ask <agent> about this PR": read-only Q&A in the checkout, independent of the deep review. */
function AskPr({ review, qaLines }: { review: ReviewDetail; qaLines: ProgressLine[] }) {
  const [q, setQ] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(0);
  const msgs = review.prMessages;
  const agent = useAgentLabel();

  const send = async (text = q) => {
    const question = text.trim();
    if (!question || asking) return;
    setAsking(true);
    setError(null);
    started.current = Date.now();
    setQ("");
    try {
      await api.askPr(review.id, question);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  };
  const live = asking ? qaLines.filter((l) => l.at >= started.current).at(-1)?.text : undefined;

  return (
    <div className="mt-5 flex flex-col gap-3 border-t border-line pt-[18px]">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="m-0 text-[14px] font-semibold">{review.mode === "self" ? `Ask ${agent} about your change` : `Ask ${agent} about this PR`}</h3>
        <span className="text-[12.5px] text-fg-3">Answers come from the checkout. This doesn't start the scan.</span>
      </div>
      {msgs.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {msgs.map((m) => (
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
        </div>
      )}
      {asking && (
        <div className="flex items-center gap-2 font-mono text-[12.5px] text-fg-3">
          <Spinner />
          {live ?? "Reading the checkout…"}
        </div>
      )}
      {msgs.length === 0 && !asking && (
        <div className="flex flex-wrap gap-2">
          {CHIPS.map((c) => (
            <button
              key={c}
              onClick={() => send(c)}
              className="h-[34px] cursor-pointer rounded-full border border-line bg-transparent px-3 text-[13px] text-fg-2 hover:border-line-strong hover:bg-hover hover:text-fg"
            >
              {c}
            </button>
          ))}
        </div>
      )}
      {error && <p className="m-0 text-[13px] text-del">{error}</p>}
      <div className="flex items-end gap-2">
        <textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder="What changed in retries? Is the backfill safe to run twice?"
          className={`min-h-[46px] min-w-0 flex-1 resize-none px-3.5 py-3 text-[14px] leading-[1.45] ${field}`}
        />
        <button
          onClick={() => send()}
          disabled={!q.trim() || asking}
          className="h-[46px] flex-none cursor-pointer rounded-lg border border-line-strong bg-surface px-[18px] text-[14px] font-medium text-fg hover:bg-hover disabled:cursor-default disabled:opacity-50"
        >
          Ask
        </button>
      </div>
    </div>
  );
}
