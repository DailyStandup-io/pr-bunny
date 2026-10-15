// A fix: a reviewer requested changes on your PR. Shows what they asked for, with Fix / Don't fix;
// while the agent works, its progress; then the diff it made, for you to Approve (commit + push to
// the PR branch, after a confirm) or Decline. Nothing reaches GitHub before Approve.
import { useEffect, useRef, useState } from "react";
import type { FixDetail, FixEvent, FixFile, FixRequest } from "../../shared/types";
import { api, useAgentLabel, useAsync } from "../api";
import { avatarUrl } from "../avatar";
import { Markdown } from "../components/Markdown";
import { Page } from "../components/Page";
import { ProgressFeed, type ProgressLine } from "../components/ProgressFeed";
import { card, cardLabel, field, fmtDuration, fmtTokens, Inline, Spinner, Sym, timeAgo } from "../components/ui";
import { Snippet } from "../components/Walkthrough";

/** Follows a fix's progress and state changes; `onState` reloads the page's copy. */
function useFixLive(id: number, onEvent: (ev: FixEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let delay = 500;
    const connect = () => {
      ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/fixes/${id}`);
      ws.onmessage = (m) => handler.current(JSON.parse(m.data));
      ws.onopen = () => (delay = 500);
      ws.onclose = () => {
        if (closed) return;
        setTimeout(connect, delay);
        delay = Math.min(delay * 2, 8000);
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [id]);
}

export function FixPage({ id }: { id: number }) {
  const { data, error, reload } = useAsync(() => api.fix(id), [id]);
  const [fix, setFix] = useState<FixDetail | null>(null);
  const [lines, setLines] = useState<ProgressLine[]>([]);
  const agent = useAgentLabel();

  useEffect(() => {
    if (!data) return;
    setFix(data);
    // A page opened mid-run starts from the server's backlog; the socket replays it too, so take whichever is longer.
    setLines((l) => (data.lines.length > l.length ? data.lines : l));
  }, [data]);
  useEffect(() => {
    setFix(null);
    setLines([]);
  }, [id]);
  useFixLive(id, (ev) => {
    if (ev.type === "progress") setLines((l) => (l.some((x) => x.at === ev.at && x.text === ev.text) ? l : [...l, { text: ev.text, tool: ev.tool, at: ev.at }]));
    else {
      if (ev.state === "running") setLines([]);
      reload();
    }
  });

  if (error && !fix) return <Page><p className="text-del">{error}</p></Page>;
  if (!fix) return <Page><Spinner size={20} /></Page>;

  const act = (p: Promise<FixDetail>) => p.then(setFix);
  const comments = fix.requests.reduce((n, r) => n + r.comments.length, 0);
  const who = [...new Set(fix.requests.map((r) => `@${r.author}`))].join(", ");

  return (
    <Page
      title={`Changes requested on #${fix.prNumber}`}
      sub={
        <>
          {fix.title} ·{" "}
          <a href={fix.url} target="_blank" rel="noreferrer" className="font-mono text-[13.5px] text-fg-2 hover:text-accent">
            {fix.repo} #{fix.prNumber}
          </a>
        </>
      }
    >
      <Status fix={fix} agent={agent} who={who} onChange={act} />

      {fix.state === "running" && (
        <ProgressFeed
          title={`${agent} is making the changes`}
          lines={lines}
          active
          action={
            <button onClick={() => api.stopFix(id).then(reload)} className="h-8 cursor-pointer rounded-[7px] border border-line-strong bg-surface px-3 text-[13px] text-fg-2 hover:bg-hover hover:text-fg">
              Stop
            </button>
          }
        />
      )}

      {(fix.state === "ready" || fix.state === "pushing" || fix.state === "pushed") && <Result fix={fix} agent={agent} onChange={act} />}

      {fix.state !== "running" && lines.length > 0 && fix.state !== "pushed" && <ProgressFeed title="What happened" lines={lines} active={false} />}

      <section className={card}>
        <header className="flex items-baseline gap-2 border-b border-line px-[22px] py-3.5">
          <h2 className={cardLabel}>What {who || "the reviewer"} asked for</h2>
          <span className="text-[12.5px] text-fg-3">
            {fix.requests.length ? `${comments} inline comment${comments === 1 ? "" : "s"}` : ""}
          </span>
        </header>
        {fix.requests.length === 0 && <p className="m-0 px-[22px] py-4 text-[13.5px] text-fg-3">Nobody is requesting changes on this PR right now.</p>}
        {fix.requests.map((r) => (
          <Request key={r.id} r={r} />
        ))}
      </section>
    </Page>
  );
}

/** The banner at the top: what's going on and the buttons for it. */
function Status({ fix, agent, who, onChange }: { fix: FixDetail; agent: string; who: string; onChange: (p: Promise<FixDetail>) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (key: string, p: () => Promise<FixDetail>) => {
    setBusy(key);
    setError(null);
    onChange(p())
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(null));
  };
  const fixBtn = (label: string) => (
    <button
      onClick={() => run("fix", () => api.startFix(fix.id))}
      disabled={busy != null}
      className="flex h-10 cursor-pointer items-center gap-2 rounded-lg border-0 bg-accent px-4 text-[13.5px] font-semibold text-on-accent disabled:cursor-default disabled:opacity-60"
    >
      {busy === "fix" ? <Spinner size={13} light /> : <Sym name="auto_fix_high" size={17} />}
      {label}
    </button>
  );

  const [icon, color, text, sub] =
    fix.state === "new"
      ? ["rule", "var(--del)", `${who || "A reviewer"} requested changes`, `${agent} can make them in PR Bunny's own checkout of the PR. You'll see the diff before anything is pushed.`]
      : fix.state === "running"
        ? ["auto_fix_high", "var(--accent)", `${agent} is on it`, "Nothing is pushed until you approve. Stop throws the work away."]
        : fix.state === "ready"
          ? ["rate_review", "var(--accent)", "Ready for you to look at", "Read the diff below. Approve commits it and pushes it to the PR branch; Decline throws it away."]
          : fix.state === "pushing"
            ? ["upload", "var(--accent)", `Pushing to ${fix.headRef}`, "Committing the diff you approved and pushing it to the PR."]
          : fix.state === "pushed"
            ? ["check_circle", "var(--add)", `Pushed to ${fix.headRef}`, `Commit ${fix.pushedSha?.slice(0, 8) ?? ""} is on the PR. Re-request a review on GitHub when you're ready.`]
            : fix.state === "declined"
              ? ["block", "var(--text-3)", "You declined this fix", "Nothing was pushed. Run it again if you change your mind."]
              : fix.state === "skipped"
                ? ["do_not_disturb_on", "var(--text-3)", "Not fixing this one", "You chose Don't fix. You can still fix it from here."]
                : ["error", "var(--warn)", "The fix didn't finish", fix.error ?? "Something went wrong."];

  return (
    <section className={`${card} flex flex-wrap items-center gap-x-4 gap-y-3 px-[22px] py-4`}>
      <span className="grid size-9 flex-none place-items-center rounded-[9px] bg-sunken" style={{ color }}>
        <Sym name={icon} size={20} fill />
      </span>
      <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-0.5">
        <span className="text-[14.5px] font-medium">{text}</span>
        <span className="text-[13px] text-pretty text-fg-2">{sub}</span>
        {error && <span className="text-[12.5px] text-del">{error}</span>}
      </div>
      <div className="flex flex-none gap-2">
        {fix.state === "new" && (
          <>
            {fixBtn(`Fix with ${agent}`)}
            <button
              onClick={() => run("skip", () => api.skipFix(fix.id))}
              disabled={busy != null}
              className="flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 text-[13.5px] text-fg-2 hover:bg-hover hover:text-fg"
            >
              {busy === "skip" && <Spinner size={13} />}
              Don't fix
            </button>
          </>
        )}
        {fix.state === "failed" && fixBtn("Try again")}
        {(fix.state === "declined" || fix.state === "skipped") && fixBtn(`Fix with ${agent}`)}
        {fix.state === "pushed" && (
          <a href={fix.url} target="_blank" rel="noreferrer" className="flex h-10 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3.5 text-[13.5px] text-fg no-underline hover:bg-hover">
            Open on GitHub
            <Sym name="open_in_new" size={16} />
          </a>
        )}
      </div>
    </section>
  );
}

/** What the agent did: its summary, the per-comment notes, the diff, and Approve / Decline. */
function Result({ fix, agent, onChange }: { fix: FixDetail; agent: string; onChange: (p: Promise<FixDetail>) => Promise<void> }) {
  const [message, setMessage] = useState(fix.commitMessage ?? "");
  const [step, setStep] = useState<"idle" | "confirm" | "pushing" | "declining">("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setMessage(fix.commitMessage ?? ""), [fix.commitMessage]);
  const pending = fix.state === "ready" || fix.state === "pushing";
  const adds = fix.files.reduce((n, f) => n + f.additions, 0);
  const dels = fix.files.reduce((n, f) => n + f.deletions, 0);

  const approve = () => {
    setStep("pushing");
    setError(null);
    onChange(api.approveFix(fix.id, { commitMessage: message, headSha: fix.headSha, diffHash: fix.diffHash }))
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setStep("idle"));
  };
  const decline = () => {
    setStep("declining");
    setError(null);
    onChange(api.declineFix(fix.id))
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setStep("idle"));
  };

  return (
    <>
      <section className={`${card} flex flex-col gap-3 px-[22px] py-4`}>
        <h2 className={cardLabel}>What {agent} did</h2>
        {fix.summary && <Markdown text={fix.summary} className="text-[14px] leading-[1.6]" />}
        {fix.addressed.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {fix.addressed.map((a, i) => (
              <li key={i} className="flex gap-2 text-[13.5px]">
                <span className="mt-0.5 flex-none text-add">
                  <Sym name="check_circle" size={16} fill />
                </span>
                <span>
                  <span className="text-fg-2"><Inline text={a.comment} /></span> — <Inline text={a.change} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {fix.notAddressed.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-lg bg-warn-soft px-3.5 py-2.5">
            <span className="text-[13px] font-semibold">Left for you</span>
            {fix.notAddressed.map((a, i) => (
              <p key={i} className="m-0 text-[13px]">
                <span className="text-fg-2"><Inline text={a.comment} /></span> — <Inline text={a.why} />
              </p>
            ))}
          </div>
        )}
        {fix.run && (
          <p className="m-0 font-mono text-[11.5px] text-fg-3">
            {fix.run.model} · {fmtDuration(fix.run.durationMs)} · {fmtTokens(fix.run.inputTokens)} in · {fmtTokens(fix.run.outputTokens)} out
          </p>
        )}
      </section>

      <section className={`${card} overflow-hidden`}>
        <header className="flex items-baseline gap-2 border-b border-line px-[22px] py-3.5">
          <h2 className={cardLabel}>The diff</h2>
          <span className="font-mono text-[12px] text-fg-3">
            {fix.files.length} file{fix.files.length === 1 ? "" : "s"} · <span className="text-add">+{adds}</span> <span className="text-del">−{dels}</span>
          </span>
        </header>
        {fix.files.map((f) => (
          <FileDiff key={f.path} f={f} />
        ))}
      </section>

      {pending && (
        <section className={`${card} flex flex-col gap-3 px-[22px] py-4`}>
          <label className="flex flex-col gap-1.5">
            <span className={cardLabel}>Commit message</span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={Math.min(8, Math.max(3, message.split("\n").length + 1))}
              className={`${field} px-3 py-2 font-mono text-[13px] leading-[1.55] text-fg`}
            />
          </label>
          {step === "confirm" ? (
            <div className="flex flex-col gap-3 rounded-[10px] border border-accent px-4 py-3.5">
              <p className="m-0 text-[14px] leading-[1.55]">
                <strong>
                  Commit and push to {fix.headRef}?
                </strong>{" "}
                <span className="text-fg-2">This writes to GitHub: the commit lands on #{fix.prNumber} and the reviewers see it.</span>
              </p>
              <div className="flex gap-2">
                <button onClick={approve} disabled={!message.trim()} className="h-11 flex-1 cursor-pointer rounded-lg border-0 bg-accent text-[14px] font-semibold text-on-accent disabled:opacity-60">
                  Yes, push it
                </button>
                <button onClick={() => setStep("idle")} className="h-11 cursor-pointer rounded-lg border border-line bg-transparent px-3.5 text-[14px] text-fg-2 hover:bg-hover">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => setStep("confirm")}
                disabled={step !== "idle" || fix.state !== "ready" || !message.trim()}
                className="flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border-0 bg-accent text-[14px] font-semibold text-on-accent disabled:cursor-default disabled:opacity-70"
              >
                {step === "pushing" || fix.state === "pushing" ? <Spinner light /> : <Sym name="check" size={18} />}
                {step === "pushing" || fix.state === "pushing" ? `Pushing to ${fix.headRef}…` : "Approve and push"}
              </button>
              <button
                onClick={decline}
                disabled={step !== "idle" || fix.state !== "ready"}
                className="flex h-11 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-[14px] text-fg-2 hover:bg-hover hover:text-fg disabled:cursor-default"
              >
                {step === "declining" && <Spinner />}
                Decline
              </button>
            </div>
          )}
          {error && <p className="m-0 text-[12.5px] text-del">{error}</p>}
          <p className="m-0 text-[12.5px] text-fg-3">The commit is yours: your git name and email, and the message exactly as you leave it. PR Bunny never force-pushes; if the branch moved on GitHub, it stops and asks you to run the fix again.</p>
        </section>
      )}
    </>
  );
}

function FileDiff({ f }: { f: FixFile }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-b border-line last:border-b-0">
      <button onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-[22px] py-2.5 text-left hover:bg-hover">
        <Sym name={open ? "expand_more" : "chevron_right"} size={18} className="text-fg-3" />
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{f.path}</span>
        <span className="font-mono text-[12px]">
          <span className="text-add">+{f.additions}</span> <span className="text-del">−{f.deletions}</span>
        </span>
      </button>
      {open && f.lines.length > 0 && <Snippet lines={f.lines} />}
    </div>
  );
}

function Request({ r }: { r: FixRequest }) {
  return (
    <div className="flex flex-col gap-3 border-b border-line px-[22px] py-4 last:border-b-0">
      <div className="flex items-center gap-2">
        <img src={avatarUrl(r.author)} alt="" className="size-6 rounded-full" />
        <span className="text-[13.5px] font-medium">@{r.author}</span>
        <span className="text-[12.5px] text-fg-3">requested changes {r.submittedAt ? timeAgo(r.submittedAt) : ""}</span>
        <span className="flex-1" />
        {r.url && (
          <a href={r.url} target="_blank" rel="noreferrer" className="text-[12.5px] text-fg-3 hover:text-accent">
            On GitHub
          </a>
        )}
      </div>
      {r.body.trim() && <Markdown text={r.body} className="text-[14px] leading-[1.6]" />}
      {r.comments.map((c) => (
        <div key={c.id} className="overflow-hidden rounded-lg border border-line">
          <div className="border-b border-line bg-sunken px-3 py-1.5 font-mono text-[12px] text-fg-2">
            {c.path}
            {c.line ? `:${c.line}` : ""}
          </div>
          <div className="px-3 py-2.5">
            <Markdown text={c.body} className="text-[13.5px] leading-[1.6]" />
          </div>
        </div>
      ))}
    </div>
  );
}
