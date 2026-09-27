"use client";

import { useEffect, useRef, useState } from "react";
import { face as bunny, faces } from "@pr-bunny/brand";
import dailyStandup from "@pr-bunny/brand/dailystandup.svg";
import { Icon } from "@pr-bunny/icons";

const INSTALL = "curl -fsSL https://prbunny.dev/install | sh";
const GITHUB = "https://github.com/DailyStandup-io/pr-bunny";

/**
 * bunny-1 … bunny-10, with what each face means. Null in builds without the art (it's licensed and
 * kept out of the repo); then the bunnies are simply left out.
 */
const FACES = faces;
const MOODS = [
  "Happy",
  "Cheeky",
  "Content",
  "Tests failed",
  "Grumpy",
  "Found a bug",
  "Approved",
  "Clean PR",
  "Skeptical",
  "Ship it",
];

/** The terminal demo, one line at a time; `face` is the bunny (1–10) shown while that line is last. */
const SCRIPT: Array<{
  mark: string;
  a: string;
  b?: string;
  face: number;
  cmd?: boolean;
  ok?: boolean;
  warn?: boolean;
}> = [
  { mark: "$", a: "bunny review --pr 123", face: 3, cmd: true },
  { mark: "·", a: "Reading acme/web#123", b: "via gh", face: 3 },
  { mark: "·", a: "Rules  review-pr/SKILL.md", b: "from main", face: 3 },
  { mark: "·", a: "Agent  Claude Code", b: "Opus, high effort", face: 9 },
  { mark: "✓", a: "Overview     6 files", b: "+142 −38", ok: true, face: 9 },
  {
    mark: "!",
    a: "lib/money.ts:48",
    b: "cents stored as float",
    warn: true,
    face: 6,
  },
  {
    mark: "!",
    a: "checkout/page.tsx",
    b: "no error boundary",
    warn: true,
    face: 5,
  },
  { mark: "✓", a: "Deep review  2 findings", ok: true, face: 2 },
  { mark: "→", a: "Opened in PR Bunny", b: "nothing posted yet", face: 7 },
];

const USAGE = [
  { cmd: "bunny review", desc: "your branch, uncommitted changes included" },
  { cmd: "bunny review --pr 123", desc: "a PR from this repo" },
  { cmd: "bunny review --rerun", desc: "again, after you push fixes" },
];

const POINTS = [
  {
    img: bunny(10),
    title: "No API keys",
    body: "Runs bill to your Claude or ChatGPT subscription. Nothing to paste, nothing to rotate.",
  },
  {
    img: bunny(9),
    title: "Your repo's rules",
    body: "Reads SKILL.md, AGENTS.md or CONTRIBUTING.md from the default branch, so a PR can't rewrite its own review.",
  },
  {
    img: bunny(2),
    title: "You press Post",
    body: "The agent never writes to GitHub. Every comment waits for you to keep, edit, or drop.",
  },
];

export function Landing() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [face, setFace] = useState(6);
  const [poked, setPoked] = useState(false);
  const [lines, setLines] = useState(1);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The theme script in layout.tsx already set data-theme; read it back so the toggle shows the right icon.
  useEffect(
    () =>
      setTheme(
        document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      ),
    [],
  );
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("pb:theme", next);
    } catch {}
  };

  // Play the terminal demo on a loop: quick lines, a beat on the command, a pause at the end.
  useEffect(() => {
    const done = lines >= SCRIPT.length;
    const t = setTimeout(
      () => setLines((n) => (n >= SCRIPT.length ? 1 : n + 1)),
      done ? 3200 : lines === 1 ? 1100 : 650,
    );
    return () => clearTimeout(t);
  }, [lines]);

  const copy = () => {
    try {
      navigator.clipboard.writeText(INSTALL);
    } catch {}
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1600);
  };
  const poke = () => {
    setFace((f) => (f + 1) % 10);
    setPoked(true);
    setTimeout(() => setPoked(false), 160);
  };
  const shown = SCRIPT.slice(0, lines);
  const last = shown[shown.length - 1]!;

  return (
    <div className="min-h-screen bg-bg text-[15px] leading-[1.55] text-fg">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col px-[clamp(16px,4vw,40px)] pt-[22px] pb-8">
        <header className="flex items-center gap-2.5">
          {FACES && (
            <img
              src={FACES[0]}
              alt=""
              width={30}
              height={30}
              className="pixel size-[30px]"
            />
          )}
          <span className="text-[15px] font-semibold">PR Bunny</span>
          <span className="flex-1" />
          <a
            href={GITHUB}
            target="_blank"
            rel="noreferrer"
            className="flex h-9 items-center rounded-[9px] px-3 text-[13.5px] text-fg-2 hover:bg-hover hover:text-fg hover:no-underline"
          >
            GitHub
          </a>
          <button
            onClick={toggleTheme}
            title="Toggle theme"
            aria-label="Toggle theme"
            className="grid size-9 cursor-pointer place-items-center rounded-[9px] border border-line bg-transparent text-fg-2 hover:bg-hover hover:text-fg"
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
          </button>
        </header>

        {/* Hero */}
        <section className="flex flex-col items-center gap-[22px] pt-[clamp(56px,10vw,112px)] pb-[clamp(48px,8vw,88px)] text-center">
          {FACES && (
            <button
              onClick={poke}
              title="Poke"
              aria-label="Poke the bunny"
              className="size-32 cursor-pointer border-0 bg-transparent p-0 transition-transform duration-[180ms] ease-[cubic-bezier(.3,1.6,.5,1)]"
              style={{ transform: poked ? "scale(0.9) rotate(-6deg)" : "none" }}
            >
              <img
                src={FACES[face]}
                alt="PR Bunny"
                width={128}
                height={128}
                className="pixel block size-32"
              />
            </button>
          )}
          <h1 className="m-0 max-w-[760px] text-[clamp(36px,6.4vw,62px)] leading-[1.04] font-semibold tracking-[-0.03em] text-balance">
            A second pair of ears on every pull request.
          </h1>
          <p className="m-0 max-w-[560px] text-[clamp(16px,2vw,18px)] text-pretty text-fg-2">
            PR Bunny reviews code with the Claude Code or Codex you&apos;re
            already signed in to. It runs on your Mac, and nothing reaches
            GitHub until you press Post.
          </p>
          <div className="mt-2.5 flex min-h-14 w-full max-w-[560px] items-center gap-1.5 rounded-xl border border-line-strong bg-surface py-1.5 pr-1.5 pl-[18px] shadow-[0_1px_0_var(--line),0_12px_32px_-18px_oklch(0.3_0.03_12/0.35)]">
            <code className="min-w-0 flex-1 overflow-x-auto text-left font-mono text-[14px] whitespace-nowrap">
              <span className="text-fg-3 select-none">$ </span>
              {INSTALL}
            </code>
            <button
              onClick={copy}
              className="flex h-11 flex-none cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-accent px-3.5 text-[13.5px] font-semibold text-on-accent"
            >
              <span className="sym text-[18px]">
                {copied ? "check" : "content_copy"}
              </span>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="flex flex-wrap justify-center gap-x-[18px] gap-y-1.5 text-[13px] text-fg-3">
            {["Free, no account", "No API keys", "macOS · needs gh"].map(
              (t) => (
                <span key={t} className="flex items-center gap-[5px]">
                  <span
                    className="sym text-[16px] text-add"
                    style={{ fontVariationSettings: "'FILL' 1" }}
                  >
                    check_circle
                  </span>
                  {t}
                </span>
              ),
            )}
          </div>
        </section>

        {/* Demo */}
        <section className="grid items-center gap-[clamp(24px,4vw,48px)] pb-[clamp(64px,10vw,112px)] [grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))]">
          <div className="flex max-w-[380px] flex-col gap-3.5">
            <span className="font-mono text-[12.5px] text-accent">
              bunny review
            </span>
            <h2 className="m-0 text-[clamp(26px,3.4vw,34px)] leading-[1.15] font-semibold tracking-[-0.02em] text-balance">
              Run it from any checkout.
            </h2>
            <p className="m-0 text-pretty text-fg-2">
              Self-review your branch before you push, or pull in a
              teammate&apos;s PR by number. Findings open in the app, ready to
              edit, drop, or post.
            </p>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {USAGE.map((u) => (
                <div
                  key={u.cmd}
                  className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5"
                >
                  <code className="rounded-[5px] border border-line bg-sunken px-[7px] py-0.5 font-mono text-[12.5px]">
                    {u.cmd}
                  </code>
                  <span className="text-[13px] text-fg-3">{u.desc}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="relative min-w-0">
            {FACES && (
              <img
                src={FACES[last.face - 1]}
                alt=""
                width={64}
                height={64}
                className="pixel absolute -top-[46px] right-[18px] z-[1] size-16"
              />
            )}
            <div className="overflow-hidden rounded-xl border border-line-strong bg-code">
              <div className="flex h-[38px] items-center gap-[7px] border-b border-line bg-surface px-3.5">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="size-2.5 rounded-full bg-line-strong"
                  />
                ))}
                <span className="flex-1 pr-11 text-center font-mono text-[11.5px] text-fg-3">
                  ~/Developer/web
                </span>
              </div>
              <div
                className="min-h-[268px] overflow-x-auto px-[18px] pt-4 pb-[18px] font-mono text-[12.5px] leading-[1.75]"
                aria-live="off"
              >
                {shown.map((l, i) => (
                  <div
                    key={i}
                    className="flex gap-2.5 whitespace-pre"
                    style={{ color: l.cmd ? "var(--text)" : "var(--text-2)" }}
                  >
                    <span
                      className="w-3 flex-none"
                      style={{
                        color: l.cmd
                          ? "var(--text-3)"
                          : l.ok
                            ? "var(--add)"
                            : l.warn
                              ? "var(--warn)"
                              : l.mark === "→"
                                ? "var(--accent)"
                                : "var(--text-3)",
                      }}
                    >
                      {l.mark}
                    </span>
                    <span>{l.a}</span>
                    <span className="text-fg-3">{l.b ?? ""}</span>
                  </div>
                ))}
                {lines >= SCRIPT.length && (
                  <span className="ml-[22px] inline-block h-[15px] w-2 bg-fg-3 align-[-3px]" />
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Principles */}
        <section className="grid border-t border-line [grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr))]">
          {POINTS.map((p) => (
            <div
              key={p.title}
              className="flex flex-col gap-2.5 pt-8 pr-[clamp(0px,2vw,24px)] pb-9"
            >
              {p.img && (
                <img
                  src={p.img}
                  alt=""
                  width={44}
                  height={44}
                  className="pixel size-11"
                />
              )}
              <h3 className="mt-1.5 mb-0 text-[17px] font-semibold tracking-[-0.01em]">
                {p.title}
              </h3>
              <p className="m-0 text-[14px] text-pretty text-fg-2">{p.body}</p>
            </div>
          ))}
        </section>

        {/* Free */}
        <section className="mt-[clamp(40px,7vw,80px)] flex flex-col items-center gap-4 rounded-2xl border border-line bg-surface px-[clamp(20px,5vw,56px)] py-[clamp(36px,6vw,64px)] text-center">
          {FACES && (
            <div className="flex gap-1">
              {FACES.map((src, i) => (
                <button
                  key={src}
                  onClick={() => {
                    setFace(i);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  title={MOODS[i]}
                  aria-label={MOODS[i]}
                  className="size-[clamp(26px,5vw,40px)] cursor-pointer border-0 bg-transparent p-0 transition-[transform,opacity] duration-150 hover:-translate-y-1 hover:opacity-100"
                  style={{ opacity: i === face ? 1 : 0.55 }}
                >
                  <img src={src} alt="" className="pixel block size-full" />
                </button>
              ))}
            </div>
          )}
          <h2 className="mt-1.5 mb-0 text-[clamp(26px,4vw,40px)] leading-[1.1] font-semibold tracking-[-0.025em] text-balance">
            Free. That&apos;s the whole pricing page.
          </h2>
          <p className="m-0 max-w-[460px] text-pretty text-fg-2">
            Reviews run on the subscription you already have. We never see your
            code.
          </p>
          <div className="mt-1.5 flex min-h-12 w-full max-w-[520px] items-center gap-1 rounded-[10px] border border-line bg-sunken py-1 pr-1 pl-3.5">
            <code className="min-w-0 flex-1 overflow-x-auto text-left font-mono text-[13px] whitespace-nowrap">
              <span className="text-fg-3 select-none">$ </span>
              {INSTALL}
            </code>
            <button
              onClick={copy}
              aria-label="Copy install command"
              title="Copy"
              className="grid size-10 flex-none cursor-pointer place-items-center rounded-[7px] border-0 bg-transparent hover:bg-hover"
              style={{ color: copied ? "var(--add)" : "var(--text-3)" }}
            >
              <span className="sym text-[18px]">
                {copied ? "check" : "content_copy"}
              </span>
            </button>
          </div>
        </section>

        <footer className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 pt-10 text-[12.5px] text-fg-3">
          <Mask src={dailyStandup.src} size={16} className="text-fg-3" />
          <span>
            Built by{" "}
            <a
              href="https://dailystandup.io"
              target="_blank"
              rel="noreferrer"
              className="text-fg-2"
            >
              DailyStandup.io
            </a>
          </span>
          <span>·</span>
          <a
            href={GITHUB}
            target="_blank"
            rel="noreferrer"
            className="text-fg-2"
          >
            GitHub
          </a>
          <p className="m-0 w-full text-center">
            PR Bunny counts installs and update checks anonymously; no identifiers are sent or stored.
          </p>
        </footer>
      </div>
    </div>
  );
}

/** An SVG drawn in currentColor. */
function Mask({
  src,
  size,
  className = "",
}: {
  src: string;
  size: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`block flex-none bg-current ${className}`}
      style={{
        width: size,
        height: size,
        mask: `url("${src}") center / contain no-repeat`,
        WebkitMask: `url("${src}") center / contain no-repeat`,
      }}
    />
  );
}
