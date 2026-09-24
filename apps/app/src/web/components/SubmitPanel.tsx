import { useEffect, useState } from "react";
import type { ReviewDetail, ReviewEvent } from "../../shared/types";
import { api, useAsync, useLayout } from "../api";
import { Markdown } from "./Markdown";
import { card, field, Spinner, Sym } from "./ui";

const EVENTS: Array<{ key: ReviewEvent; label: string; hint: string }> = [
  { key: "COMMENT", label: "Comment", hint: "Feedback without approving or blocking" },
  { key: "APPROVE", label: "Approve", hint: "Approve, with these comments" },
  { key: "REQUEST_CHANGES", label: "Request changes", hint: "Block merging until addressed" },
];

const page = "mx-auto w-full max-w-[1400px] flex-1 px-[clamp(16px,3vw,32px)] pt-6 pb-12";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function SubmitPanel({ review, onPosted, onGoFindings }: { review: ReviewDetail; onPosted: () => void; onGoFindings: () => void }) {
  if (review.phase === "submitted") return <Posted review={review} />;
  if (review.phase !== "walkthrough") {
    return (
      <div className={page}>
        <p className={`${card} m-0 max-w-[820px] px-[26px] py-6 text-[14px] text-fg-2`}>Submitting opens once the deep review has finished.</p>
      </div>
    );
  }
  return <Compose review={review} onPosted={onPosted} onGoFindings={onGoFindings} />;
}

function Compose({ review, onPosted, onGoFindings }: { review: ReviewDetail; onPosted: () => void; onGoFindings: () => void }) {
  const { wide, mid } = useLayout();
  // Re-fetch when decisions change so the preview always matches what will be posted.
  const decisionsKey = review.findings.map((f) => `${f.id}:${f.decision}:${f.comment.length}`).join(",");
  const { data: sub, error } = useAsync(() => api.submission(review.id), [review.id, decisionsKey]);
  const [event, setEvent] = useState<ReviewEvent | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  useEffect(() => {
    if (sub && body === null) setBody(sub.body);
    if (sub && event === null) setEvent(sub.suggestedEvent);
  }, [sub]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className={page}><p className="m-0 text-[14px] text-del">{error}</p></div>;
  if (!sub || body === null || event === null) return <div className={page}><Spinner /></div>;

  const post = async () => {
    setPosting(true);
    setPostError(null);
    try {
      await api.submit(review.id, event, body);
      onPosted();
    } catch (e) {
      setPostError(e instanceof Error ? e.message : String(e));
      setConfirming(false);
    } finally {
      setPosting(false);
    }
  };

  const label = EVENTS.find((e) => e.key === event)!.label;
  const side = wide || mid;

  return (
    <div className={page}>
      <div className="grid items-start gap-5" style={{ gridTemplateColumns: side ? "minmax(0,1fr) 340px" : "minmax(0,1fr)" }}>
        <div className="flex min-w-0 flex-col gap-4">
          {sub.undecided > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 rounded-xl border border-warn-soft bg-warn-soft px-[18px] py-3.5">
              <span className="text-[14px] text-fg">
                <span className="font-semibold">{sub.undecided} undecided.</span> Undecided findings aren't posted.
              </span>
              <button onClick={onGoFindings} className="h-9 cursor-pointer rounded-lg border border-line-strong bg-surface px-3 text-[13px]">
                Back to findings
              </button>
            </div>
          )}
          <section className={`${card} px-[22px] py-5`}>
            <h2 className="mt-0 mb-2.5 text-[14px] font-semibold">Review summary</h2>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={9}
              className={`block w-full resize-y px-3.5 py-3 font-mono text-[13px] leading-[1.6] ${field}`}
            />
            <p className="mt-2 mb-0 text-[12.5px] text-fg-3">Accepted findings that can't sit on a diff line are listed under "Other notes". Edit freely.</p>
          </section>
          <section className={`${card} px-[22px] py-5`}>
            <h2 className="mt-0 mb-3 text-[14px] font-semibold">
              Inline comments <span className="font-normal text-fg-3">({sub.comments.length})</span>
            </h2>
            {sub.comments.length === 0 && <p className="m-0 text-[14px] text-fg-3">None. Accept findings in the walkthrough to add them.</p>}
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {sub.comments.map((c) => (
                <li key={c.findingId} className="overflow-hidden rounded-[10px] border border-line">
                  <div className="border-b border-line bg-sunken px-3 py-[7px] font-mono text-[12px] text-fg-2">
                    {c.path}:{c.startLine ? `${c.startLine}-` : ""}
                    {c.line}
                    {c.side === "LEFT" ? " (removed line)" : ""}
                  </div>
                  <Markdown text={c.body} className="px-3.5 py-3 text-[14px] leading-[1.6]" />
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="top-[68px] flex min-w-0 flex-col gap-3.5" style={{ position: side ? "sticky" : "static" }}>
          <section className={`${card} p-[18px]`}>
            <h2 className="mt-0 mb-2.5 text-[14px] font-semibold">Post as</h2>
            <div className="flex flex-col gap-2">
              {EVENTS.map((e) => {
                const on = e.key === event;
                return (
                  <button
                    key={e.key}
                    onClick={() => {
                      setEvent(e.key);
                      setConfirming(false);
                    }}
                    className={`flex cursor-pointer items-start gap-3 rounded-[10px] border px-3.5 py-3 text-left ${on ? "border-accent bg-accent-soft" : "border-line bg-transparent"}`}
                  >
                    <span className={`mt-0.5 grid size-[18px] flex-none place-items-center rounded-full border-2 ${on ? "border-accent" : "border-line-strong"}`}>
                      <span className={`size-2 rounded-full ${on ? "bg-accent" : "bg-transparent"}`} />
                    </span>
                    <span>
                      <span className="block text-[14.5px] font-semibold">{e.label}</span>
                      <span className="block text-[12.5px] text-fg-3">{e.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {event === sub.suggestedEvent && <p className="mt-2.5 mb-0 text-[12px] text-fg-3">Suggested from the severity of what you accepted.</p>}
          </section>
          {postError && <p className="m-0 text-[13.5px] text-del">{postError}</p>}
          {!confirming ? (
            <button onClick={() => setConfirming(true)} className="h-14 cursor-pointer rounded-[10px] border-0 bg-accent text-[15.5px] font-semibold text-on-accent">
              Post review…
            </button>
          ) : (
            <section className="flex flex-col gap-3 rounded-xl border border-accent bg-surface px-[18px] py-4">
              <p className="m-0 text-[14px] leading-[1.55]">
                Post a <strong>{label}</strong> review to{" "}
                <span className="font-mono text-[12.5px]">
                  {review.repo}#{review.prNumber}
                </span>{" "}
                with {plural(sub.comments.length, "inline comment")}? The author will be notified.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={post}
                  disabled={posting}
                  className="h-12 flex-1 cursor-pointer rounded-lg border-0 bg-accent text-[14.5px] font-semibold text-on-accent disabled:opacity-60"
                >
                  {posting ? "Posting…" : `Yes, post ${label}`}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  disabled={posting}
                  className="h-12 cursor-pointer rounded-lg border border-line bg-transparent px-3.5 text-[14px] text-fg-2"
                >
                  Cancel
                </button>
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function Posted({ review }: { review: ReviewDetail }) {
  const posted = review.findings.filter((f) => f.posted);
  const label = EVENTS.find((e) => e.key === review.postedEvent)?.label ?? "Review";
  return (
    <div className={page}>
      <div className="flex max-w-[820px] flex-col gap-4">
        <section className={`${card} flex items-start gap-3.5 px-[26px] py-6`}>
          <Sym name="check_circle" size={28} fill className="text-add" />
          <div>
            <p className="m-0 text-[18px] font-semibold">Posted: {label}</p>
            <p className="mt-1 mb-0 text-[14px] text-fg-2">
              {plural(posted.length, "inline comment")} ·{" "}
              <a href={`${review.url}#pullrequestreview-${review.ghReviewId}`} target="_blank" rel="noreferrer">
                View on GitHub
              </a>
            </p>
          </div>
        </section>
        {review.postedBody && (
          <section className={`${card} px-[26px] py-5`}>
            <h2 className="mt-0 mb-2 text-[13px] font-semibold text-fg-3">Summary</h2>
            <Markdown text={review.postedBody} className="text-[14.5px] leading-[1.65]" />
          </section>
        )}
      </div>
    </div>
  );
}
