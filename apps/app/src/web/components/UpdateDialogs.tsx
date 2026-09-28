// The update popup and What's new. The popup asks once per version at a calm moment (opening PR
// Bunny or coming back to it, never over another dialog) and updates in place: download, restart,
// done. After the restart, What's new shows the notes for every version since the last one seen;
// a release with only fixes gets a small note by the bunny instead. Settings › About can turn
// both off, and brings either back (updatePrefs.showPopupAgain / openNotes).
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { NoteItem, ReleaseNotes, UpdateState, WhatsNewState } from "../../shared/types";
import { fixesOnly } from "../../shared/changelog";
import { currentUpdate, onUpdateDialog, updatePrefs, updates, useLayout, useUpdate, useWhatsNew } from "../api";
import { BUNNY_FACES } from "./Bunny";
import { Inline, Spinner, Sym } from "./ui";

/** Newer than, for "x.y.z" (and the server's "dev"). */
function newer(a: string, b: string) {
  const p = (v: string) => v.split("-")[0]!.split(".").map((n) => Number(n) || 0);
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

const quoted = (n: { version: string; name: string }) => `${n.version}${n.name ? ` “${n.name}”` : ""}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const shortDate = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
const otherDialogOpen = () => Boolean(document.querySelector('[role="dialog"]'));

export function UpdateDialogs() {
  const u = useUpdate();
  const w = useWhatsNew();
  const [popup, setPopup] = useState(false);
  const [notes, setNotes] = useState<{ versions: string[]; from: string | null; auto: boolean } | null>(null);
  const [fixNote, setFixNote] = useState<ReleaseNotes | null>(null);
  const autoShown = useRef(false);

  // What's new, once, when this version hasn't been seen yet. Fix-only releases get the small note.
  useEffect(() => {
    if (!w?.pending || autoShown.current || !w.pending.versions.length) return;
    autoShown.current = true;
    const list = w.pending.versions.map((v) => w.notes.find((n) => n.version === v)).filter((n): n is ReleaseNotes => !!n);
    if (list.every(fixesOnly)) {
      setFixNote(list[0]!);
      updatePrefs.seen();
    } else setNotes({ versions: w.pending.versions, from: w.pending.from, auto: true });
  }, [w]);

  // The popup: when PR Bunny opens and whenever you come back to it.
  const offer = () => {
    const up = currentUpdate();
    const prefs = w?.prefs;
    if (!up || !prefs || up.status !== "available" || !up.latest) return;
    if (!prefs.updatePopup || prefs.dismissedUpdate === up.latest.version) return;
    if (notes || w?.pending || otherDialogOpen()) return;
    setPopup(true);
  };
  const offerRef = useRef(offer);
  offerRef.current = offer;
  useEffect(() => {
    offerRef.current();
  }, [u?.status, u?.latest?.version, w?.prefs.updatePopup, Boolean(w?.pending)]);
  useEffect(() => {
    const back = () => document.visibilityState === "visible" && offerRef.current();
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, []);

  // Settings › About: Show it again, Read the notes.
  useEffect(
    () =>
      onUpdateDialog((r) => {
        if (r.kind === "popup") setPopup(true);
        else setNotes({ versions: r.versions, from: null, auto: false });
      }),
    [],
  );

  const closeNotes = () => {
    if (notes?.auto) updatePrefs.seen();
    setNotes(null);
  };

  return (
    <>
      {popup && u && w && <UpdatePopup u={u} w={w} onClose={() => setPopup(false)} />}
      {notes && w && <WhatsNew w={w} versions={notes.versions} from={notes.auto ? notes.from : undefined} onClose={closeNotes} />}
      {fixNote && !notes && (
        <FixNote
          n={fixNote}
          onOpen={() => {
            setFixNote(null);
            setNotes({ versions: [fixNote.version], from: null, auto: false });
          }}
          onClose={() => setFixNote(null)}
        />
      )}
    </>
  );
}

// ---------- shared dialog frame ----------

function Modal({ label, width, onEsc, children }: { label: string; width: number; onEsc: () => void; children: ReactNode }) {
  const escRef = useRef(onEsc);
  escRef.current = onEsc;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      escRef.current();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4">
      <div role="dialog" aria-modal aria-label={label} className="flex max-h-[calc(100vh-32px)] w-full flex-col overflow-hidden rounded-[14px] border border-line bg-surface shadow-dialog" style={{ maxWidth: width }}>
        {children}
      </div>
    </div>
  );
}

function Head({ face, eyebrow, eyebrowColor = "var(--accent)", title, sub, onClose, border }: {
  face: string | null;
  eyebrow: string;
  eyebrowColor?: string;
  title: string;
  sub: string;
  onClose?: () => void;
  border?: boolean;
}) {
  return (
    <div className={`flex items-start gap-3.5 pt-[22px] pr-3.5 pl-6 ${border ? "border-b border-line pb-[18px]" : ""}`}>
      {face && <img src={face} alt="" className="size-[52px] flex-none rounded-xl bg-accent-soft [image-rendering:pixelated]" />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[12.5px] font-semibold" style={{ color: eyebrowColor }}>{eyebrow}</span>
        <h2 className="m-0 text-[18px] leading-[1.3] font-semibold tracking-[-0.01em]">{title}</h2>
        <p className="mt-0.5 mb-0 text-[13.5px] text-pretty text-fg-2">{sub}</p>
      </div>
      {onClose && (
        <button onClick={onClose} aria-label="Close" className="grid size-8 flex-none cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-fg-3 hover:bg-hover hover:text-fg">
          <Sym name="close" size={20} />
        </button>
      )}
    </div>
  );
}

const primaryBtn = "flex h-10 flex-none items-center gap-2 rounded-lg border-0 bg-accent px-4 text-[13.5px] font-semibold whitespace-nowrap text-on-accent enabled:cursor-pointer enabled:hover:brightness-[0.97] disabled:opacity-80";
const quietBtn = "h-10 flex-none cursor-pointer rounded-lg border-0 bg-transparent px-3.5 text-[13.5px] text-fg-2 hover:bg-hover hover:text-fg";

// ---------- the update popup ----------

type Phase = "available" | "downloading" | "ready" | "restarting" | "error";

function UpdatePopup({ u, w, onClose }: { u: UpdateState; w: WhatsNewState; onClose: () => void }) {
  const latest = u.latest;
  const phase: Phase | null =
    u.status === "available" || u.status === "downloading" || u.status === "ready" || u.status === "restarting" || u.status === "error" ? u.status : null;
  // Nothing to show any more (checked again and it's gone, or it was installed elsewhere).
  useEffect(() => {
    if (!phase || !latest) onClose();
  }, [phase, latest]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!phase || !latest) return null;

  const to = latest.version;
  // Not now, ✕ and Esc hide it for this version; Hide and Later only close it.
  const dismiss = () => {
    updatePrefs.save({ dismissedUpdate: to });
    onClose();
  };
  const close = phase === "available" || phase === "error" ? dismiss : phase === "restarting" ? () => {} : onClose;
  const tryAgain = async () => {
    await updates.check();
    if (currentUpdate()?.status === "available") updates.install();
  };

  // Everything between here and the latest, newest first (latest.json from 0.4.2 on has notes).
  const between = latest.notes.filter((n) => newer(n.version, u.current.version) && !newer(n.version, to));
  const skipped = between.filter((n) => n.version !== to);
  const added = between.flatMap((n) => n.added);
  const changed = between.flatMap((n) => n.changed);
  const fixed = between.flatMap((n) => n.fixed);
  // Lead with the biggest additions; a release without any leads with its changes, then fixes.
  const hl: NoteItem[] = (added.length ? added : [...changed, ...fixed]).slice(0, 3);
  const moreChanges = added.length ? changed.length + Math.max(0, added.length - 3) : Math.max(0, changed.length - 3);
  const moreFixes = added.length ? fixed.length : Math.max(0, fixed.length - Math.max(0, 3 - changed.length));
  const meta = [moreChanges && plural(moreChanges, "change", "changes"), moreFixes && plural(moreFixes, "fix", "fixes")].filter(Boolean).join(" and ");

  const dismissedSkipped = skipped.find((n) => n.version === w.prefs.dismissedUpdate);
  const sub = skipped.length
    ? `You're on ${u.current.version}. It also brings ${skipped.map(quoted).join(", ")}${dismissedSkipped ? ", which you skipped" : ""}.`
    : `You're on ${u.current.version}. Takes about a minute.`;

  const failed = phase === "error";
  const box: { bg: string; icon: string; color: string; text: string; progress?: boolean } | null =
    phase === "downloading"
      ? { bg: "var(--sunken)", icon: "downloading", color: "var(--accent)", text: `Downloading ${to}… ${u.progress}%`, progress: true }
      : phase === "ready"
        ? { bg: "var(--add-soft)", icon: "check_circle", color: "var(--add)", text: `${to} is installed. Restart PR Bunny to finish. Reviews in progress pick up where they left off.` }
        : phase === "restarting"
          ? { bg: "var(--sunken)", icon: "restart_alt", color: "var(--text-3)", text: "Restarting… this page reloads on its own." }
          : failed
            ? { bg: "var(--del-soft)", icon: "error", color: "var(--del)", text: u.error ?? "Something went wrong. Nothing was changed." }
            : null;
  const primary = {
    available: { label: `Update to ${to}`, onClick: updates.install },
    downloading: { label: "Updating" },
    ready: { label: "Restart now", onClick: updates.restart },
    restarting: { label: "Restarting" },
    error: { label: "Try again", onClick: tryAgain },
  }[phase] as { label: string; onClick?: () => void };
  const secondary = { available: "Not now", downloading: "Hide", ready: "Later", restarting: "", error: "Not now" }[phase];
  const foot = {
    available: "Not now hides this until the next version.",
    downloading: "Hide keeps it going in the background.",
    ready: "Later: restart from Settings › About.",
    restarting: "",
    error: "Not now hides this until the next version.",
  }[phase];

  return (
    <Modal label="Update available" width={520} onEsc={close}>
      <Head
        face={failed ? BUNNY_FACES.crying : phase === "ready" ? BUNNY_FACES.happy : BUNNY_FACES.shades}
        eyebrow={{ available: "Update available", downloading: "Updating", ready: "Ready to restart", restarting: "Restarting", error: "Update failed" }[phase]}
        eyebrowColor={failed ? "var(--del)" : phase === "ready" ? "var(--add)" : "var(--accent)"}
        title={`PR Bunny ${quoted(latest)} is out`}
        sub={sub}
        onClose={phase === "restarting" ? undefined : close}
      />
      <div className="min-h-0 overflow-auto">
        {box && (
          <div className="mx-6 mt-4 flex flex-col gap-[9px] rounded-lg px-3.5 py-[11px]" style={{ background: box.bg }}>
            <div className="flex items-start gap-2.5">
              <span className="flex flex-none leading-[1.3]" style={{ color: box.color }}>
                <Sym name={box.icon} size={18} fill />
              </span>
              <span className="text-[13.5px] text-pretty">{box.text}</span>
            </div>
            {box.progress && (
              <div className="h-1 overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-accent transition-[width] duration-150 ease-linear" style={{ width: `${u.progress}%` }} />
              </div>
            )}
          </div>
        )}
        {hl.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-3.5 px-6 pt-[18px] pb-1.5">
            {hl.map((h, i) => (
              <li key={i} className="flex min-w-0 flex-col gap-px">
                {h.title ? (
                  <>
                    <span className="text-[14px] font-medium"><Inline text={h.title} /></span>
                    <span className="text-[13px] text-pretty text-fg-2"><Inline text={h.text} /></span>
                  </>
                ) : (
                  <span className="text-[13.5px] text-pretty"><Inline text={h.text} /></span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-6 pt-1.5 pb-[18px] text-[13px]">
          {meta && <span className="text-fg-3">+ {meta}</span>}
          {latest.notesUrl && (
            <a href={latest.notesUrl} target="_blank" rel="noreferrer" className="flex items-center gap-[3px] font-medium text-accent hover:underline">
              Release notes
              <Sym name="open_in_new" size={15} />
            </a>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-sunken py-3 pr-4 pl-6">
        <span className="min-w-0 flex-1 text-[12.5px] text-pretty text-fg-3">{foot}</span>
        {secondary && (
          <button onClick={phase === "available" || phase === "error" ? dismiss : onClose} className={quietBtn}>
            {secondary}
          </button>
        )}
        <button onClick={primary.onClick} disabled={!primary.onClick} className={primaryBtn}>
          {!primary.onClick && <Spinner size={14} light />}
          {primary.label}
        </button>
      </div>
    </Modal>
  );
}

// ---------- What's new ----------

function WhatsNew({ w, versions, from, onClose }: { w: WhatsNewState; versions: string[]; from?: string | null; onClose: () => void }) {
  const list = versions.map((v) => w.notes.find((n) => n.version === v)).filter((n): n is ReleaseNotes => !!n);
  if (!list.length) return null;
  const one = list.length === 1 ? list[0]! : null;
  // Opened after updating: `from` is the version you came from (null when there's no record of it).
  const afterUpdate = from !== undefined;
  const eyebrow = afterUpdate ? (from ? `Updated from ${from}` : "Updated") : one?.date ? `Released ${shortDate(one.date)}` : "Release notes";
  const title = one ? `What's new in ${quoted(one)}` : `What's new since ${from ?? list[list.length - 1]!.version}`;
  const sub = one
    ? afterUpdate
      ? "Thanks for updating. Here's what changed."
      : one.version === w.current.version
        ? "You're on this version."
        : ""
    : `${list.length} releases, newest first.`;
  return (
    <Modal label="What's new" width={600} onEsc={onClose}>
      <Head face={BUNNY_FACES.surprised} eyebrow={eyebrow} title={title} sub={sub} onClose={onClose} border />
      <div className="flex min-h-0 flex-col overflow-auto px-6 pt-1 pb-5">
        {list.map((n) => (
          <div key={n.version} className="flex flex-col gap-3 pt-[18px]">
            {!one && (
              <div className="flex items-center gap-2 pb-0.5">
                <span className="rounded-md bg-accent-soft px-[7px] py-0.5 font-mono text-[12px] font-medium text-accent">{n.version}</span>
                {n.name && <span className="text-[14.5px] font-semibold">{`“${n.name}”`}</span>}
                <span className="text-[12.5px] text-fg-3">{shortDate(n.date)}</span>
              </div>
            )}
            {n.added.length > 0 && (
              <div className="flex flex-col gap-2">
                {n.added.map((h, i) => (
                  <div key={i} className="flex items-start gap-3 rounded-[10px] bg-sunken px-3.5 py-3">
                    <span className="grid size-8 flex-none place-items-center rounded-lg border border-line bg-surface text-accent">
                      <Sym name="auto_awesome" size={18} />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-px">
                      {h.title && <span className="text-[14px] font-semibold"><Inline text={h.title} /></span>}
                      <span className="text-[13px] text-pretty text-fg-2"><Inline text={h.text} /></span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {(
              [
                ["Changed", n.changed],
                ["Fixed", n.fixed],
              ] as const
            )
              .filter(([, items]) => items.length)
              .map(([label, items]) => (
                <div key={label} className="flex flex-col gap-1.5">
                  <h3 className="mt-1 mb-0 text-[13px] font-semibold text-fg-3">{label}</h3>
                  <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
                    {items.map((it, i) => (
                      <li key={i} className="flex items-start gap-2.5 text-[13.5px] text-pretty">
                        <span className="mt-2 size-[5px] flex-none rounded-full bg-line-strong" />
                        <span className="min-w-0">
                          <Inline text={it.title ? `**${it.title}.** ${it.text}` : it.text} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-line bg-sunken py-3 pr-4 pl-6">
        <span className="min-w-0 flex-1 text-[12.5px] text-fg-3">Find this again in Settings › About.</span>
        <a href="https://github.com/DailyStandup-io/pr-bunny/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer" className="flex flex-none items-center gap-[3px] text-[13px] font-medium text-accent hover:underline">
          Full changelog
          <Sym name="open_in_new" size={15} />
        </a>
        <button onClick={onClose} className={`${primaryBtn} px-[18px]`}>
          Got it
        </button>
      </div>
    </Modal>
  );
}

// ---------- the note for a fix-only release ----------

function FixNote({ n, onOpen, onClose }: { n: ReleaseNotes; onOpen: () => void; onClose: () => void }) {
  const { narrow } = useLayout();
  useEffect(() => {
    const t = setTimeout(onClose, 10_000);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const first = n.fixed[0]!;
  const summary = `${plural(n.fixed.length, "fix", "fixes")}: ${(first.title ?? first.text).replace(/\*\*/g, "")}${n.fixed.length > 1 ? ", and more" : ""}.`;
  return (
    <div
      role="status"
      className={`fixed z-50 flex items-start gap-3 rounded-xl border border-line bg-surface py-3 pr-2 pl-3 shadow-pop ${narrow ? "inset-x-3 bottom-[76px]" : "bottom-5 left-[92px] w-[380px]"}`}
    >
      {BUNNY_FACES.happy && <img src={BUNNY_FACES.happy} alt="" className="size-10 flex-none rounded-lg bg-accent-soft [image-rendering:pixelated]" />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13.5px] font-semibold">Updated to {quoted(n)}</span>
        <span className="text-[13px] text-pretty text-fg-2"><Inline text={summary} /></span>
        <button onClick={onOpen} className="mt-1 w-fit cursor-pointer border-0 bg-transparent p-0 text-left text-[13px] font-medium text-accent hover:underline">
          See what changed
        </button>
      </div>
      <button onClick={onClose} aria-label="Dismiss" className="grid size-[30px] flex-none cursor-pointer place-items-center rounded-[7px] border-0 bg-transparent text-fg-3 hover:bg-hover hover:text-fg">
        <Sym name="close" size={18} />
      </button>
    </div>
  );
}
