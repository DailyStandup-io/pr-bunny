import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentInfo, Effort, ModelOption, Provider, Settings, Stage } from "../../shared/types";
import { api, navigate, refreshAgentLabel, updates, useAsync, useLayout, useTheme, useUpdate, type ThemePref } from "../api";
import { Page } from "../components/Page";
import { card, field, MaskIcon, Spinner, Sym, timeAgo } from "../components/ui";
import { BUNNY_FACES } from "../components/Bunny";
import { HousekeepingExtras } from "../components/Housekeeping";
import claudeLogo from "../assets/claude.svg";
// OpenAI's official Blossom (cdn.openai.com/brand), drawn in the text colour so it works in both themes.
import openaiLogo from "../assets/openai.svg";
import dailyStandupLogo from "@pr-bunny/brand/dailystandup.svg";

const STAGES: Array<{ key: Stage; label: string; hint: string }> = [
  { key: "recon", label: "Overview", hint: "The quick scan you read first. A fast model is fine here." },
  { key: "review", label: "Deep review", hint: "Reads the checked-out PR and writes the findings. Use the strongest model you can." },
  { key: "qa", label: "Questions", hint: "Answers questions about a finding, continuing the review's context." },
];

const LOGO: Record<Provider, string> = { claude: claudeLogo, codex: openaiLogo };

export function SettingsPage() {
  const { stickyBottom } = useLayout();
  const { data, error } = useAsync(api.settings, []);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Agents are scanned each time Settings opens, and on "Scan again".
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [scanning, setScanning] = useState(true);
  const scan = async () => {
    setScanning(true);
    try {
      setAgents(await api.agents());
    } catch {
      setAgents([]);
    } finally {
      setScanning(false);
    }
  };
  useEffect(() => {
    scan();
  }, []);

  useEffect(() => {
    if (data) {
      setDraft(data.settings);
      setSaved(data.settings);
    }
  }, [data]);

  if (error) return <Page title="Settings"><p className="m-0 text-[14px] text-del">{error}</p></Page>;
  if (!draft || !saved || !data) return <Page title="Settings"><Spinner /></Page>;

  const provider = data.providers[draft.provider];
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (patch: Partial<Settings>) => {
    setDraft({ ...draft, ...patch });
    setStatus(null);
  };
  const pickAgent = (p: Provider) => {
    const d = data.providers[p].defaults;
    set({ provider: p, models: { ...d.models }, effort: { ...d.effort } });
  };

  const run = async (fn: () => Promise<{ settings: Settings }>, ok: string) => {
    setBusy(true);
    try {
      const res = await fn();
      setDraft(res.settings);
      setSaved(res.settings);
      setStatus({ kind: "ok", text: ok });
      refreshAgentLabel();
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col">
      <Page title="Settings" flush>
        <section className={`${card} overflow-hidden`}>
          <div className="flex items-start gap-4 border-b border-line px-[22px] py-[18px]">
            <div className="min-w-0 flex-1">
              <h2 className="m-0 text-[15px] font-semibold">Agent</h2>
              <p className="mt-[3px] mb-0 text-[13px] text-fg-3">The coding agent that runs reviews on this machine. Pick one you're signed in to.</p>
            </div>
            <button
              onClick={scan}
              disabled={scanning}
              className="flex h-9 flex-none items-center gap-2 rounded-lg border border-line bg-transparent px-3 text-[13px] text-fg-2 enabled:cursor-pointer enabled:hover:bg-hover enabled:hover:text-fg"
            >
              {scanning ? <Spinner size={15} /> : <Sym name="refresh" />}
              {scanning ? "Scanning" : "Scan again"}
            </button>
          </div>
          {(["claude", "codex"] as const).map((key, i, keys) => {
            const a = agents?.find((x) => x.key === key);
            const selected = draft.provider === key;
            const usable = !scanning && Boolean(a?.installed && a.signedIn);
            const statusText = scanning || !a
              ? "Checking sign-in…"
              : !a.installed
                ? "Not installed"
                : a.signedIn
                  ? `Signed in${a.account ? ` as ${a.account}` : ""}${a.plan ? ` · ${a.plan}` : ""}`
                  : "Installed, not signed in";
            const good = !scanning && a?.installed && a.signedIn;
            return (
              <button
                key={key}
                onClick={() => usable && !selected && pickAgent(key)}
                disabled={!usable || selected}
                aria-pressed={selected}
                className={`flex w-full items-start gap-3.5 border-0 px-[22px] py-[18px] text-left text-fg ${usable && !selected ? "cursor-pointer" : "cursor-default"}`}
                style={{ borderBottom: `1px solid ${i === keys.length - 1 ? "transparent" : "var(--line)"}`, background: selected ? "var(--accent-soft)" : "transparent" }}
              >
                <span
                  className="mt-0.5 grid size-[18px] flex-none place-items-center rounded-full border-[1.5px]"
                  style={{ borderColor: selected ? "var(--accent)" : "var(--line-strong)", opacity: usable || selected ? 1 : 0.45 }}
                >
                  <span className="size-2 rounded-full" style={{ background: selected ? "var(--accent)" : "transparent" }} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className="flex items-center gap-[7px] text-[14.5px] font-medium">
                    {key === "codex" ? (
                      <MaskIcon src={LOGO.codex} size={16} className="flex-none text-fg" />
                    ) : (
                      <img src={LOGO[key]} alt="" className="size-4 flex-none object-contain" />
                    )}
                    {data.providers[key].label}
                  </span>
                  <span className="truncate font-mono text-[12px] text-fg-3">
                    {a?.installed ? `${a.path}${a.version ? ` · v${a.version}` : ""}` : scanning ? " " : "Not found on this machine"}
                  </span>
                  <span className="mt-[3px] flex items-center gap-1.5 text-[13px]" style={{ color: scanning ? "var(--text-3)" : good ? "var(--add)" : "var(--text-2)" }}>
                    <Sym name={scanning ? "schedule" : good ? "check_circle" : "error"} size={16} fill />
                    {statusText}
                  </span>
                  {!scanning && a && (!a.installed || !a.signedIn) && (
                    <span className="mt-1.5 text-[13px] leading-normal text-fg-2">
                      Run <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-fg">{a.installed ? a.loginCmd : a.installCmd}</code>
                      {!a.installed && (
                        <>
                          {" "}
                          then <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-fg">{a.loginCmd}</code>
                        </>
                      )}{" "}
                      in a terminal, then scan again.
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </section>

        <section className={card}>
          <Header title="Models" sub={provider.hint} />
          {STAGES.map((s) => (
            <div key={s.key} className="flex flex-wrap gap-x-6 gap-y-3 border-b border-line px-[22px] py-[18px] last:border-b-0">
              <div className="min-w-0 flex-[1_1_260px]">
                <p className="m-0 text-[14.5px] font-medium">{s.label}</p>
                <p className="mt-0.5 mb-0 text-[13px] leading-normal text-fg-3">{s.hint}</p>
              </div>
              <div className="flex min-w-[240px] flex-[0_1_320px] flex-col gap-2">
                <ModelPicker
                  key={`${draft.provider}:${s.key}`}
                  value={draft.models[s.key]}
                  options={provider.models}
                  placeholder={draft.provider === "codex" ? "e.g. gpt-5-codex" : "e.g. claude-opus-5-5"}
                  onChange={(m) => set({ models: { ...draft.models, [s.key]: m } })}
                />
                <label className="flex items-center justify-between gap-3 text-[13px] text-fg-3">
                  Effort
                  <select
                    value={draft.effort[s.key]}
                    onChange={(e) => set({ effort: { ...draft.effort, [s.key]: e.target.value as Effort } })}
                    className={`h-9 px-2.5 text-[13px] text-fg ${field}`}
                  >
                    {provider.efforts.map((e) => (
                      <option key={e.key} value={e.key}>
                        {e.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          ))}
        </section>

        <section className={card}>
          <Header title="Review" sub="What goes into the deep review's prompt." />
          <Row label="Learn from dismissals" hint="Include your past dismissals in this repo, so the same false positives stop coming back.">
            <div className="flex items-center gap-3.5">
              <Toggle checked={draft.dismissalMemory} onChange={(v) => set({ dismissalMemory: v })} />
              <NumberInput value={draft.dismissalMemoryLimit} disabled={!draft.dismissalMemory} onChange={(n) => set({ dismissalMemoryLimit: n })} suffix="most recent" />
            </div>
          </Row>
          <Row label="Stack context" hint="How many PRs above and below in a stack to load descriptions for. The agent can still open any stack PR itself.">
            <NumberInput value={draft.stackContextDepth} onChange={(n) => set({ stackContextDepth: n })} suffix="levels each way" />
          </Row>
          <Row label="Deep review turn limit" hint="Safety cap on tool calls in one deep review. Raise it if very large PRs stop early. Claude Code only.">
            <NumberInput value={draft.reviewMaxTurns} onChange={(n) => set({ reviewMaxTurns: n })} suffix="turns" />
          </Row>
          <Row label="Overview turn limit" hint="How many tries the overview gets to hand back a complete answer. It reads no files, so a few is plenty. Claude Code only.">
            <NumberInput value={draft.reconMaxTurns} onChange={(n) => set({ reconMaxTurns: n })} suffix="turns" />
          </Row>
          <div className="border-t border-line px-[22px] pt-4">
            <h3 className="m-0 text-[13px] font-semibold text-fg-3">Stacks</h3>
          </div>
          <Row label="Review order" hint="Which end Review all starts from. Base first reviews each layer after the one it builds on.">
            <Segmented value={draft.stackOrder} options={[["base", "Base first"], ["top", "Top first"]]} onChange={(v) => set({ stackOrder: v as "base" | "top" })} />
          </Row>
          <Row label="PRs at once" hint="How many deep reviews run in parallel during Review all. More is faster and uses more of your plan.">
            <Segmented value={String(draft.stackConcurrency)} options={[["1", "1"], ["2", "2"], ["3", "3"]]} onChange={(v) => set({ stackConcurrency: Number(v) })} />
          </Row>
          <Row label="Review all limit" hint="Stacks with more PRs than this don't offer Review all. You can still review each layer.">
            <NumberInput value={draft.stackMaxAll} onChange={(n) => set({ stackMaxAll: n })} suffix="PRs or fewer" />
          </Row>
          <Row label="Include approved and merged PRs" hint="Off leaves out layers that are already approved, merged, or reviewed by you. Turn on to review them again.">
            <Toggle checked={draft.stackIncludeDone} onChange={(v) => set({ stackIncludeDone: v })} />
          </Row>
        </section>

        <section className={card}>
          <Header title="Housekeeping" />
          <Row label="Clean up checkouts after" hint="PR checkouts are deleted after this long with no activity, and right after you post. Asking a question later recreates one.">
            <NumberInput value={draft.worktreeTtlHours} onChange={(n) => set({ worktreeTtlHours: n })} suffix="hours" />
          </Row>
          {/* Clearing finished reviews and the hidden list: saved on change, separate from the save bar. */}
          <HousekeepingExtras />
        </section>

        <Appearance />
        <About />

        <SaveBar
          bottom={stickyBottom}
          text={dirty ? "Unsaved changes" : status?.text ?? "No changes"}
          tone={dirty ? "var(--text)" : status?.kind === "error" ? "var(--del)" : status ? "var(--add)" : "var(--text-3)"}
          dirty={dirty}
          busy={busy}
          onReset={() => run(api.resetSettings, "Reset to defaults")}
          onDiscard={() => set(saved)}
          onSave={() => run(() => api.saveSettings(draft), "Saved")}
        />
      </Page>
    </div>
  );
}

/**
 * The floating save bar. It's only as wide as what it says, and eases (with a little overshoot)
 * between sizes as the text changes: "No changes" → "Unsaved changes" + Discard.
 */
function SaveBar(props: {
  bottom: number;
  text: string;
  tone: string;
  dirty: boolean;
  busy: boolean;
  onReset: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => setWidth(Math.ceil(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="pointer-events-none sticky z-15 mt-auto flex justify-center pb-4" style={{ bottom: props.bottom }}>
      <div
        className={`${card} pointer-events-auto max-w-full overflow-hidden shadow-bar`}
        style={{
          width: width ? width + 2 : "auto",
          transition: "width 520ms linear(0, 0.22 6%, 0.72 15%, 1.06 25%, 1.13 31%, 1.1 37%, 1.02 47%, 0.985 57%, 0.992 68%, 1.002 82%, 1)",
        }}
      >
        <div ref={inner} className="flex w-max items-center gap-3.5 py-1.5 pr-1.5 pl-3.5">
          <p className="m-0 text-[13px] whitespace-nowrap" style={{ color: props.tone }}>
            {props.text}
          </p>
          <span className="h-[18px] w-px flex-none bg-line" />
          <div className="flex items-center gap-1">
            <button
              onClick={props.onReset}
              disabled={props.busy}
              className="h-8 flex-none cursor-pointer rounded-[7px] border-0 bg-transparent px-2.5 text-[13px] whitespace-nowrap text-fg-2 hover:bg-hover hover:text-fg"
            >
              Reset
            </button>
            {props.dirty && (
              <button
                onClick={props.onDiscard}
                disabled={props.busy}
                className="h-8 flex-none cursor-pointer rounded-[7px] border border-line bg-transparent px-2.5 text-[13px] text-fg hover:bg-hover"
              >
                Discard
              </button>
            )}
            <button
              onClick={props.onSave}
              disabled={!props.dirty || props.busy}
              className={`h-8 flex-none rounded-[7px] border-0 px-3.5 text-[13px] font-semibold ${props.dirty ? "cursor-pointer bg-accent text-on-accent" : "cursor-default bg-sunken text-fg-3"}`}
            >
              {props.busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Header({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="border-b border-line px-[22px] py-[18px]">
      <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
      {sub && <p className="mt-[3px] mb-0 text-[13px] text-fg-3">{sub}</p>}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line px-[22px] py-[18px] last:border-b-0">
      <div className="min-w-0 flex-[1_1_260px]">
        <p className="m-0 text-[14.5px] font-medium">{label}</p>
        <p className="mt-0.5 mb-0 text-[13px] leading-normal text-fg-3">{hint}</p>
      </div>
      {children}
    </div>
  );
}

const CUSTOM = "__custom__";

function ModelPicker({ value, options, placeholder, onChange }: { value: string; options: ModelOption[]; placeholder: string; onChange: (m: string) => void }) {
  const known = options.some((o) => o.id === value);
  const [custom, setCustom] = useState(!known);
  const note = options.find((o) => o.id === value)?.note;
  return (
    <div className="flex flex-col gap-1.5">
      <select
        value={custom ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) setCustom(true);
          else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
        className={`h-11 px-3 text-[14px] ${field}`}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
        <option value={CUSTOM}>Custom model ID…</option>
      </select>
      {custom ? (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder={placeholder}
          className={`h-10 px-3 font-mono text-[13px] ${field}`}
        />
      ) : (
        note && <p className="m-0 text-[12px] text-fg-3">{note}</p>
      )}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-[26px] w-11 flex-none cursor-pointer rounded-full border-0 ${checked ? "bg-accent" : "bg-line-strong"}`}
    >
      <span className="absolute top-[3px] size-5 rounded-full bg-surface shadow-seg transition-[left]" style={{ left: checked ? 21 : 3 }} />
    </button>
  );
}

function NumberInput({ value, onChange, suffix, disabled }: { value: number; onChange: (n: number) => void; suffix: string; disabled?: boolean }) {
  return (
    <label className={`flex items-center gap-2 text-[13px] text-fg-3 ${disabled ? "opacity-40" : ""}`}>
      <input
        type="number"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`h-10 w-[76px] px-2.5 text-right font-mono text-[14px] text-fg ${field}`}
      />
      {suffix}
    </label>
  );
}

/** Theme: System follows the OS. Applies immediately (it's per browser, not a saved setting). */
function Appearance() {
  const { pref, setPref } = useTheme();
  const opts: Array<[ThemePref, string, string]> = [
    ["system", "System", "desktop_windows"],
    ["light", "Light", "light_mode"],
    ["dark", "Dark", "dark_mode"],
  ];
  return (
    <section className={card}>
      <Header title="Appearance" />
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-[22px] py-[18px]">
        <div className="min-w-0 flex-[1_1_260px]">
          <p className="m-0 text-[14.5px] font-medium">Theme</p>
          <p className="mt-0.5 mb-0 text-[13px] leading-normal text-fg-3">System follows your computer's light or dark setting. Applies right away.</p>
        </div>
        <div role="radiogroup" aria-label="Theme" className="flex flex-none gap-0.5 rounded-[10px] border border-line bg-sunken p-[3px]">
          {opts.map(([key, label, icon]) => (
            <button
              key={key}
              role="radio"
              aria-checked={pref === key}
              onClick={() => setPref(key)}
              className={`flex h-9 cursor-pointer items-center gap-1.5 rounded-[7px] border-0 px-3 text-[13px] font-medium hover:text-fg ${
                pref === key ? "bg-surface text-fg shadow-seg" : "bg-transparent text-fg-2"
              }`}
            >
              <Sym name={icon} size={17} />
              {label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Version, updates, and who made it. Installing and restarting only happen from these buttons. */
function About() {
  const u = useUpdate();
  const latest = u?.latest;
  const status = u?.status ?? "idle";
  const dev = u?.current.version === "dev";
  const v = latest ? `${latest.version}${latest.name ? ` \u201c${latest.name}\u201d` : ""}` : "";
  const panel: { text: string; icon: string; tone: string; bg?: string; btn?: { label: string; primary?: boolean; busy?: boolean; onClick?: () => void }; notes?: boolean; progress?: boolean } = {
    idle: { text: u?.checkedAt ? `Last checked ${timeAgo(u.checkedAt)}` : "Not checked yet", icon: "schedule", tone: "var(--text-3)", btn: { label: "Check for updates", onClick: updates.check } },
    checking: { text: "Checking for a new release…", icon: "sync", tone: "var(--text-3)", btn: { label: "Checking", busy: true } },
    latest: { text: "You're on the latest version.", icon: "check_circle", tone: "var(--add)", btn: { label: "Check again", onClick: updates.check } },
    available: { text: `Version ${v} is available.`, icon: "new_releases", tone: "var(--accent)", bg: "var(--accent-soft)", notes: true, btn: { label: `Update to ${latest?.version}`, primary: true, onClick: updates.install } },
    downloading: { text: `Downloading ${latest?.version}… ${u?.progress ?? 0}%`, icon: "downloading", tone: "var(--accent)", progress: true, btn: { label: "Updating", busy: true } },
    ready: {
      text: `${latest?.version} is installed. Restart PR Bunny to finish. Reviews in progress pick up where they left off.`,
      icon: "check_circle",
      tone: "var(--add)",
      bg: "var(--add-soft)",
      btn: { label: "Restart now", primary: true, onClick: updates.restart },
    },
    restarting: { text: "Restarting…", icon: "restart_alt", tone: "var(--text-3)", btn: { label: "Restarting", busy: true } },
    error: { text: u?.error ?? "Something went wrong.", icon: "error", tone: "var(--del)", bg: "var(--del-soft)", btn: { label: "Try again", onClick: updates.check } },
    unsupported: { text: u?.note ?? "Updates aren't available here.", icon: "info", tone: "var(--text-3)" },
  }[status];

  return (
    <section className={`${card} overflow-hidden`}>
      <div className="flex items-center gap-3 border-b border-line px-[22px] py-[18px]">
        <h2 className="m-0 flex-1 text-[15px] font-semibold">About</h2>
        <button onClick={() => navigate("/setup")} className="h-8 cursor-pointer rounded-lg border-0 bg-transparent px-2.5 text-[13px] font-medium text-accent hover:bg-accent-soft">
          Run setup again
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3.5 px-[22px] py-5">
        {BUNNY_FACES.smile && <img src={BUNNY_FACES.smile} alt="PR Bunny" className="size-14 flex-none [image-rendering:pixelated]" />}
        <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-0.5">
          <span className="text-[17px] font-semibold tracking-[-0.01em]">PR Bunny</span>
          <span className="font-mono text-[12.5px] text-fg-3">{u ? (dev ? "Development build (from source)" : `Version ${u.current.version} \u201c${u.current.name}\u201d`) : " "}</span>
        </div>
        {panel.btn && (
          <button
            onClick={panel.btn.onClick}
            disabled={panel.btn.busy || !panel.btn.onClick}
            className={`flex h-10 flex-none items-center gap-2 rounded-lg border px-4 text-[13.5px] font-semibold enabled:cursor-pointer enabled:hover:brightness-[0.97] ${
              panel.btn.primary ? "border-accent bg-accent text-on-accent" : "border-line-strong bg-transparent text-fg"
            }`}
          >
            {panel.btn.busy && <Spinner size={15} />}
            {panel.btn.label}
          </button>
        )}
      </div>
      <div className="mx-[22px] mb-[18px] flex flex-col gap-2.5 rounded-lg px-3.5 py-3" style={{ background: panel.bg ?? "var(--sunken)" }}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13.5px]">
          <span className="flex flex-none" style={{ color: panel.tone }}>
            <Sym name={panel.icon} size={18} fill />
          </span>
          <span className={`min-w-0 flex-1 ${panel.bg ? "text-fg" : "text-fg-2"}`}>{panel.text}</span>
          {panel.notes && latest?.notesUrl && (
            <a href={latest.notesUrl} target="_blank" rel="noreferrer" className="flex flex-none items-center gap-1 text-[13px] text-accent hover:underline">
              Release notes
              <Sym name="open_in_new" size={15} />
            </a>
          )}
        </div>
        {panel.progress && (
          <div className="h-1 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-accent transition-[width] duration-200 ease-linear" style={{ width: `${u?.progress ?? 0}%` }} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line bg-sunken px-[22px] py-3">
        <MaskIcon src={dailyStandupLogo} size={18} className="flex-none text-fg-2" />
        <p className="m-0 min-w-0 flex-1 text-[13px] text-fg-3">
          Built by{" "}
          <a href="https://dailystandup.io" target="_blank" rel="noreferrer" className="font-medium text-fg hover:underline">
            DailyStandup.io
          </a>{" "}
          · © 2026 DailyStandup.io
        </p>
        <a href="https://github.com/DailyStandup-io/pr-bunny" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-[13px] text-fg-2 hover:text-fg">
          <Sym name="open_in_new" size={16} />
          GitHub
        </a>
      </div>
    </section>
  );
}

/** A small segmented control (like the theme picker). */
function Segmented({ value, options, onChange }: { value: string; options: Array<[string, string]>; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" className="flex flex-none gap-0.5 rounded-[10px] border border-line bg-sunken p-[3px]">
      {options.map(([key, label]) => (
        <button
          key={key}
          role="radio"
          aria-checked={value === key}
          onClick={() => onChange(key)}
          className={`h-[34px] min-w-10 cursor-pointer rounded-[7px] border-0 px-3 text-[13px] font-medium hover:text-fg ${value === key ? "bg-surface text-fg shadow-seg" : "bg-transparent text-fg-2"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
