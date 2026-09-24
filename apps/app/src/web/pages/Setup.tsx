// One-time setup (/setup): agent, GitHub CLI, the `bunny` command, repositories, review skills,
// then a summary. Everything here only reads, except "Create link" on the terminal step and
// "Finish setup", which saves it all in one go. Reopened from Settings › About.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, CliInfo, Provider, RepoSkills, SetupChecks, SetupConfig, SetupRepo, SetupState, SkillPreview } from "../../shared/types";
import { api, navigate, useCopy, useTheme, type SettingsResponse } from "../api";
import { BUNNY_FACES } from "../components/Bunny";
import { MaskIcon, Spinner, Sym } from "../components/ui";
import claudeLogo from "../assets/claude.svg";
// OpenAI's official Blossom (cdn.openai.com/brand), drawn in the text colour so it works in both themes.
import openaiLogo from "../assets/openai.svg";
import dailyStandupLogo from "@pr-bunny/brand/dailystandup.svg";
import { Icon } from "@pr-bunny/icons";

const STEPS = ["Agent", "GitHub", "Terminal", "Repos", "Skill", "Summary"] as const;
const TITLES: Array<[string, string]> = [
  ["Choose your coding agent", "PR Bunny drives an agent you're already signed in to on this Mac."],
  ["Connect GitHub", "Required. PR Bunny talks to GitHub only through your gh login."],
  ["Terminal command", "Optional. Kick off a review without opening the browser."],
  ["Repositories", "Where your checkouts live. Optional: you can also paste a PR URL later."],
  ["Review skill", "Use each repo's own review instructions as criteria."],
  ["Review and finish", "Check your choices. Everything here can be changed later in Settings."],
];
const LOGO: Record<Provider, string> = { claude: claudeLogo, codex: openaiLogo };
const STAGE_LABEL = { recon: "Overview", review: "Deep review", qa: "Questions" } as const;

type Scan = "agents" | "gh" | "repos" | "skills";
/** A repo's review-skill choice: a file path, null for generic criteria. */
type Choice = string | null;

export function SetupPage({ onDone }: { onDone: () => void }) {
  const { theme, setPref } = useTheme();
  const [state, setState] = useState<SetupState | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [checks, setChecks] = useState<SetupChecks | null>(null);
  const [busy, setBusy] = useState<Partial<Record<Scan, boolean>>>({ agents: true, gh: true, repos: true });
  const [errors, setErrors] = useState<Partial<Record<Scan, string>>>({});
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [skipped, setSkipped] = useState<Record<number, boolean>>({});
  const [provider, setProvider] = useState<Provider | null>(null);
  const [cliOn, setCliOn] = useState(true);
  const [cli, setCli] = useState<CliInfo | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [repos, setRepos] = useState<SetupRepo[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [skills, setSkills] = useState<Record<string, RepoSkills | { error: string }>>({});
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 560);
  const reentry = Boolean(state?.completedAt);

  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 560);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  // ---------- loading and scans ----------

  const runChecks = async (key: "agents" | "gh") => {
    setBusy((b) => ({ ...b, [key]: true }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    try {
      const c = await api.setupChecks();
      setChecks(c);
      setCli((prev) => (prev?.linked ? prev : c.cli));
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: message(e) }));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  };

  const scanRepos = async (initial: boolean, saved: SetupState | null) => {
    setBusy((b) => ({ ...b, repos: true }));
    setErrors((e) => ({ ...e, repos: undefined }));
    try {
      const found = await api.setupRepos();
      setRepos((cur) => {
        // First run: everything found. Coming back: what was saved; "Check again" adds new finds.
        const base = initial && saved?.completedAt ? found.filter((r) => r.source === "added") : found;
        const have = new Set(cur.map((r) => r.path));
        return [...cur, ...base.filter((r) => !have.has(r.path) && !dismissed.includes(r.path))];
      });
    } catch (e) {
      setErrors((x) => ({ ...x, repos: message(e) }));
    } finally {
      setBusy((b) => ({ ...b, repos: false }));
    }
  };

  useEffect(() => {
    (async () => {
      const [s, st] = await Promise.all([api.setup(), api.settings()]);
      setState(s);
      setSettings(st);
      if (s.completedAt) {
        setMaxStep(5);
        setStep(5);
      }
      scanRepos(true, s);
    })().catch((e) => setErrors({ agents: message(e) }));
    (async () => {
      setBusy((b) => ({ ...b, gh: true, agents: true }));
      try {
        const c = await api.setupChecks();
        setChecks(c);
        setCli(c.cli);
      } catch (e) {
        setErrors((x) => ({ ...x, agents: message(e), gh: message(e) }));
      } finally {
        setBusy((b) => ({ ...b, gh: false, agents: false }));
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pick an agent once we know what's signed in: the saved one if it's usable, else the first that is.
  useEffect(() => {
    if (!checks || !state) return;
    const ready = (p: Provider) => checks.agents.some((a) => a.key === p && a.installed && a.signedIn);
    setProvider((cur) => (cur && ready(cur) ? cur : ready(state.defaults.provider) ? state.defaults.provider : ready("claude") ? "claude" : ready("codex") ? "codex" : null));
    if (state.completedAt && !checks.cli.linked) setCliOn(Boolean(state.config?.cli.installed));
  }, [checks, state]);

  const scanSkills = async () => {
    if (!repos.length) return;
    setBusy((b) => ({ ...b, skills: true }));
    const out: Record<string, RepoSkills | { error: string }> = {};
    await Promise.all(
      repos.map(async (r) => {
        out[r.path] = await api.repoSkills(r.path).catch((e) => ({ error: message(e) }));
      }),
    );
    setSkills(out);
    setBusy((b) => ({ ...b, skills: false }));
  };

  const go = (n: number) => {
    setStep(n);
    setMaxStep((m) => Math.max(m, n));
    window.scrollTo(0, 0);
  };
  useEffect(() => {
    if (step === 4 && repos.some((r) => !skills[r.path]) && !busy.skills) scanSkills();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- derived ----------

  const agent = checks?.agents.find((a) => a.key === provider) ?? null;
  const agentOk = Boolean(agent?.installed && agent.signedIn);
  const gh = checks?.gh ?? null;
  const ghOk = Boolean(gh?.signedIn);
  const cliLinked = Boolean(cli?.linked);
  const choiceOf = (r: SetupRepo): Choice => {
    if (r.path in choices) return choices[r.path]!;
    if (r.reviewSkill !== undefined) return r.reviewSkill;
    const s = skills[r.path];
    return s && "candidates" in s ? s.suggested : null;
  };
  const satisfied = [agentOk && !busy.agents, ghOk && !busy.gh, !cliOn || cliLinked, repos.length > 0, !busy.skills && repos.every((r) => skills[r.path]), agentOk && ghOk];
  const hints = [
    busy.agents ? "" : "Sign in to an agent to continue",
    busy.gh ? "" : "Log in to gh to continue",
    cli?.conflict && !cliLinked ? "Replace the existing file, or skip" : "Create the link, or skip",
    "",
    "",
    "Agent and GitHub CLI are required",
  ];
  const canNext = satisfied[step] && !saving;

  const config: SetupConfig | null = useMemo(() => {
    if (!settings || !provider) return null;
    const d = provider === settings.settings.provider ? settings.settings : settings.providers[provider].defaults;
    return {
      provider,
      models: d.models,
      effort: d.effort,
      gh: { path: gh?.path ?? null, user: gh?.user ?? null },
      cli: { installed: cliOn && cliLinked, path: cli?.path ?? "~/.local/bin/bunny" },
      repos: repos.map((r) => ({ repo: r.repo, path: r.displayPath, reviewSkill: choiceOf(r) })),
      onboardedAt: new Date().toISOString(),
    };
  }, [settings, provider, gh, cliOn, cliLinked, cli, repos, choices, skills]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = async () => {
    if (!provider) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.completeSetup({ provider, installCli: cliOn && cliLinked, repos: repos.map((r) => ({ path: r.path, reviewSkill: choiceOf(r) })) });
      setFinished(true);
      window.scrollTo(0, 0);
    } catch (e) {
      setSaveError(message(e));
    } finally {
      setSaving(false);
    }
  };

  const next = () => {
    if (!canNext) return;
    if (step === 5) return void finish();
    setSkipped((s) => ({ ...s, [step]: false }));
    go(step + 1);
  };
  const skip = () => {
    setSkipped((s) => ({ ...s, [step]: true }));
    if (step === 2) setCliOn(false);
    go(step + 1);
  };

  // ---------- render ----------

  if (!state || !settings) {
    return (
      <Frame theme={theme} onTheme={() => setPref(theme === "dark" ? "light" : "dark")} face={BUNNY_FACES.smile}>
        <div className="grid flex-1 place-items-center">{errors.agents ? <ErrorBox title="Couldn't load setup" detail={errors.agents} /> : <Spinner size={20} />}</div>
      </Frame>
    );
  }

  const face = finished ? BUNNY_FACES.happy : step === 5 ? BUNNY_FACES.shades : BUNNY_FACES.smile;
  return (
    <Frame theme={theme} onTheme={() => setPref(theme === "dark" ? "light" : "dark")} face={face}>
      {!finished && (
        <>
          <nav aria-label="Setup steps" className="grid grid-cols-6 gap-1.5">
            {STEPS.map((label, i) => {
              const cur = i === step;
              const done = i !== step && i < 5 && (reentry || (i < maxStep && (satisfied[i] || skipped[i])));
              const reachable = reentry || i <= maxStep;
              return (
                <button
                  key={label}
                  onClick={() => reachable && !cur && go(i)}
                  disabled={!reachable}
                  aria-current={cur ? "step" : undefined}
                  className={`flex min-h-11 min-w-0 flex-col justify-center gap-[7px] border-0 bg-transparent px-0 py-1 text-left ${reachable && !cur ? "cursor-pointer" : "cursor-default"}`}
                >
                  <span className={`block h-[3px] rounded-sm ${cur || done ? "bg-accent" : "bg-line"}`} />
                  <span className={`flex min-w-0 items-center gap-[3px] text-[12px] ${cur ? "font-semibold text-fg" : done ? "font-medium text-fg-2" : "font-medium text-fg-3"}`}>
                    {done && (
                      <span className="flex-none text-accent">
                        <Sym name="check" size={14} />
                      </span>
                    )}
                    <span className="truncate">{label}</span>
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="flex flex-col gap-1">
            <span className="text-[13px] font-medium text-fg-3">{reentry ? "All steps complete" : step < 5 ? `Step ${step + 1} of 5` : "Summary"}</span>
            <h1 className="m-0 text-[24px] leading-[1.25] font-semibold tracking-[-0.012em]">{reentry && step === 5 ? "Setup" : TITLES[step]![0]}</h1>
            <p className="mt-0.5 mb-0 text-[14.5px] text-pretty text-fg-2">{reentry && step === 5 ? "Everything is set up. Change any step, then save." : TITLES[step]![1]}</p>
          </div>

          {step === 0 && (
            <AgentStep
              checks={checks}
              busy={!!busy.agents}
              error={errors.agents}
              provider={provider}
              onPick={setProvider}
              onCheck={() => runChecks("agents")}
              settings={settings}
              narrow={narrow}
            />
          )}
          {step === 1 && <GhStep gh={gh} busy={!!busy.gh} error={errors.gh} onCheck={() => runChecks("gh")} narrow={narrow} />}
          {step === 2 && (
            <CliStep
              cli={cli}
              on={cliOn}
              onToggle={() => setCliOn((v) => !v)}
              scanning={!cli}
              linking={linking}
              error={linkError}
              onLink={async (replace) => {
                setLinking(true);
                setLinkError(null);
                try {
                  setCli(await api.linkCli(replace));
                } catch (e) {
                  setLinkError(message(e));
                } finally {
                  setLinking(false);
                }
              }}
              onKeep={() => setCliOn(false)}
            />
          )}
          {step === 3 && (
            <ReposStep
              repos={repos}
              roots={state.searchRoots}
              busy={!!busy.repos}
              error={errors.repos}
              onCheck={() => scanRepos(false, state)}
              onRemove={(p) => {
                setRepos((rs) => rs.filter((r) => r.path !== p));
                setDismissed((d) => [...d, p]);
              }}
              onAdd={(r) => {
                setRepos((rs) => [...rs, r]);
                setDismissed((d) => d.filter((p) => p !== r.path));
              }}
            />
          )}
          {step === 4 && (
            <SkillStep
              repos={repos}
              skills={skills}
              busy={!!busy.skills}
              locations={state.skillLocations}
              choiceOf={choiceOf}
              onChoose={(path, c) => setChoices((x) => ({ ...x, [path]: c }))}
              onCheck={scanSkills}
            />
          )}
          {step === 5 && (
            <Summary
              agent={agent}
              settings={settings}
              provider={provider}
              gh={gh}
              cliOn={cliOn}
              cli={cli}
              repos={repos}
              choiceOf={choiceOf}
              config={config}
              configPath={state.configPath}
              onEdit={go}
            />
          )}

          {saveError && <ErrorBox title="Couldn't save setup" detail={saveError} />}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5 pt-1">
            {step > 0 && (
              <button onClick={() => go(step - 1)} className="flex h-10 cursor-pointer items-center gap-1 rounded-lg border border-line-strong bg-surface pr-3.5 pl-2.5 text-[13.5px] hover:bg-hover">
                <Sym name="arrow_back" />
                Back
              </button>
            )}
            <span className="flex-[1_1_0]" />
            {!satisfied[step] && hints[step] && <span className="text-right text-[13px] text-fg-3">{hints[step]}</span>}
            {(step === 2 || step === 3) && (
              <button onClick={skip} className="h-10 cursor-pointer rounded-lg border-0 bg-transparent px-3.5 text-[13.5px] text-fg-2 hover:bg-hover hover:text-fg">
                Skip
              </button>
            )}
            <button
              onClick={next}
              disabled={!canNext}
              className={`flex h-10 items-center gap-1.5 rounded-lg border-0 pr-3.5 pl-4 text-[13.5px] font-semibold ${canNext || saving ? "cursor-pointer bg-accent text-on-accent" : "cursor-default bg-sunken text-fg-3"}`}
            >
              {saving && <Spinner size={14} light />}
              {step === 5 ? (saving ? "Saving…" : reentry ? "Save changes" : "Finish setup") : step === 4 ? "Review setup" : "Continue"}
              {step < 5 && <Sym name="arrow_forward" />}
            </button>
          </div>
        </>
      )}

      {finished && (
        <Done
          reentry={reentry}
          agent={agent}
          ghUser={gh?.user ?? null}
          cliInstalled={cliOn && cliLinked}
          firstRepo={repos[0]?.displayPath ?? null}
          onOpen={() => {
            onDone();
            navigate("/");
          }}
        />
      )}
    </Frame>
  );
}

// ---------- layout ----------

function Frame({ theme, onTheme, face, children }: { theme: "light" | "dark"; onTheme: () => void; face: string | null; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-[14px] leading-normal text-fg">
      <div className="mx-auto flex min-h-screen w-full max-w-[704px] flex-col gap-6 px-[clamp(14px,4vw,32px)] py-7">
        <header className="flex items-center gap-2.5">
          {face && <img src={face} alt="" className="size-[30px] object-contain [image-rendering:pixelated]" />}
          <span className="text-[15px] font-semibold">PR Bunny</span>
          <span className="text-[13px] text-fg-3">Setup</span>
          <span className="flex-1" />
          <button
            onClick={onTheme}
            title="Toggle theme"
            aria-label="Toggle theme"
            className="grid size-9 cursor-pointer place-items-center rounded-[9px] border border-line bg-transparent text-fg-2 hover:bg-hover hover:text-fg"
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
          </button>
        </header>
        {children}
        <footer className="mt-auto flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 pt-7 text-[12.5px] text-fg-3">
          <MaskIcon src={dailyStandupLogo} size={16} className="flex-none text-fg-3" />
          <span>
            Built by{" "}
            <a href="https://dailystandup.io" target="_blank" rel="noreferrer" className="text-fg-2 hover:underline">
              DailyStandup.io
            </a>
          </span>
          <span>·</span>
          <a href="https://github.com/DailyStandup-io" target="_blank" rel="noreferrer" className="text-fg-2 hover:underline">
            GitHub
          </a>
        </footer>
      </div>
    </div>
  );
}

const card = "overflow-hidden rounded-xl border border-line bg-surface";

function SectionHead({ title, sub, onCheck, busy }: { title: React.ReactNode; sub?: React.ReactNode; onCheck?: () => void; busy?: boolean }) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-[22px] py-[18px]">
      <div className="min-w-0 flex-[1_1_240px]">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {sub && <p className="mt-[3px] mb-0 text-[13px] text-pretty text-fg-3">{sub}</p>}
      </div>
      {onCheck && <CheckAgain onClick={onCheck} busy={!!busy} />}
    </div>
  );
}

function CheckAgain({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="flex h-9 flex-none items-center gap-2 rounded-lg border border-line bg-transparent px-3 text-[13px] text-fg-2 enabled:cursor-pointer enabled:hover:bg-hover enabled:hover:text-fg"
    >
      {busy ? <Spinner size={14} /> : <Sym name="refresh" />}
      {busy ? "Checking…" : "Check again"}
    </button>
  );
}

function ErrorBox({ title, detail, className = "" }: { title: string; detail: string; className?: string }) {
  return (
    <div className={`flex items-start gap-2.5 rounded-lg bg-del-soft px-3.5 py-3 ${className}`}>
      <span className="flex-none text-del">
        <Sym name="error" fill />
      </span>
      <div className="min-w-0">
        <p className="m-0 text-[13.5px] font-medium">{title}</p>
        <p className="mt-0.5 mb-0 text-[13px] break-words text-fg-2">{detail}</p>
      </div>
    </div>
  );
}

function Skeleton({ rows, avatar = "round" }: { rows: number; avatar?: "round" | "square" }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-3.5 border-t border-line px-[22px] py-[18px] first:border-t-transparent">
          <span className={`mt-0.5 flex-none bg-sunken ${avatar === "round" ? "size-[18px] rounded-full" : "size-7 rounded-[7px]"}`} />
          <span className="flex flex-1 flex-col gap-[9px]">
            {["32%", "58%", "44%"].slice(0, avatar === "round" ? 3 : 2).map((w, j) => (
              <span key={j} className="block animate-pulse rounded bg-sunken" style={{ width: w, height: j === 0 ? 12 : 9 }} />
            ))}
          </span>
        </div>
      ))}
    </>
  );
}

/** A copyable command. */
function Cmd({ cmd, or }: { cmd: string; or?: boolean }) {
  const [copied, copy] = useCopy();
  return (
    <div className="flex items-center gap-2">
      {or && <span className="flex-none text-[12px] text-fg-3">or</span>}
      <div className="flex min-h-10 min-w-0 flex-1 items-center gap-1 rounded-lg border border-line bg-sunken py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[12.5px] whitespace-nowrap">{cmd}</code>
        <button
          onClick={() => copy(cmd, "c")}
          aria-label="Copy command"
          title="Copy"
          className={`grid size-8 flex-none cursor-pointer place-items-center rounded-md border-0 bg-transparent hover:bg-hover ${copied ? "text-add" : "text-fg-3"}`}
        >
          <Sym name={copied ? "check" : "content_copy"} size={17} />
        </button>
      </div>
    </div>
  );
}

interface HelpStep {
  text: string;
  cmds: string[];
  after?: React.ReactNode;
}

function Help({ steps, pad }: { steps: HelpStep[]; pad: string }) {
  return (
    <div className="flex flex-col gap-3.5 pr-[22px] pb-[18px]" style={{ paddingLeft: pad }}>
      {steps.map((h, i) => (
        <div key={i} className="flex items-start gap-2.5">
          <span className="mt-px grid size-5 flex-none place-items-center rounded-full border border-line bg-sunken text-[11px] font-semibold text-fg-2">{i + 1}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="m-0 text-[13.5px]">{h.text}</p>
            {h.cmds.map((c, j) => (
              <Cmd key={c} cmd={c} or={j > 0} />
            ))}
            {h.after && <p className="m-0 text-[13px] text-fg-2">{h.after}</p>}
          </div>
        </div>
      ))}
      <p className="m-0 text-[13px] text-fg-3">When that's done, press Check again.</p>
    </div>
  );
}

const Code = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-sunken px-1.5 py-px font-mono text-[12px] text-fg">{children}</code>;

// ---------- step 1: agent ----------

function agentHelp(a: AgentInfo): HelpStep[] {
  if (a.key === "claude") {
    const login: HelpStep = {
      text: "Start it and sign in with your Claude subscription",
      cmds: ["claude"],
      after: (
        <>
          Then type <Code>/login</Code> inside it and choose your Claude account.
        </>
      ),
    };
    return a.installed ? [login] : [{ text: "Install Claude Code", cmds: [a.installCmd, "brew install --cask claude-code"] }, login];
  }
  const login: HelpStep = { text: "Sign in with ChatGPT", cmds: ["codex login"] };
  return a.installed ? [login] : [{ text: "Install Codex", cmds: [a.installCmd] }, login];
}

function AgentStep(props: {
  checks: SetupChecks | null;
  busy: boolean;
  error?: string;
  provider: Provider | null;
  onPick: (p: Provider) => void;
  onCheck: () => void;
  settings: SettingsResponse;
  narrow: boolean;
}) {
  const { checks, busy, error, provider } = props;
  const chosen = checks?.agents.find((a) => a.key === provider);
  const ok = chosen?.installed && chosen.signedIn;
  const defaults = provider ? (provider === props.settings.settings.provider ? props.settings.settings : props.settings.providers[provider].defaults) : null;
  const opts = provider ? props.settings.providers[provider] : null;
  return (
    <>
      <section className={card}>
        <div className="border-b border-line">
          <SectionHead title="Agents on this Mac" sub="Only a signed-in agent can be selected." onCheck={props.onCheck} busy={busy} />
        </div>
        {busy && <Skeleton rows={2} />}
        {!busy && error && <ErrorBox className="mx-[22px] my-[18px]" title="Couldn't scan for agents" detail={error} />}
        {!busy &&
          !error &&
          checks?.agents.map((a, i) => {
            const ready = a.installed && a.signedIn;
            const sel = provider === a.key;
            return (
              <div key={a.key} className={i ? "border-t border-line" : ""} style={{ background: sel ? "var(--accent-soft)" : "transparent" }}>
                <button
                  onClick={() => ready && props.onPick(a.key)}
                  disabled={!ready}
                  aria-pressed={sel}
                  className={`flex w-full items-start gap-3.5 border-0 bg-transparent px-[22px] py-[18px] text-left text-fg ${ready && !sel ? "cursor-pointer" : "cursor-default"}`}
                >
                  <Radio on={sel} dim={!ready} />
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="flex items-center gap-2 text-[14.5px] font-medium">
                      {a.key === "codex" ? (
                        <MaskIcon src={LOGO.codex} size={16} className="flex-none text-fg" />
                      ) : (
                        <img src={LOGO[a.key]} alt="" className="size-4 flex-none object-contain" />
                      )}
                      {a.label}
                      <code className="rounded bg-sunken px-1.5 py-px font-mono text-[11.5px] font-normal text-fg-2">{a.key}</code>
                    </span>
                    <span className="truncate font-mono text-[12px] text-fg-3">{a.installed ? `${a.path}${a.version ? ` · v${a.version}` : ""}` : "Not found on PATH"}</span>
                    <Status
                      state={ready ? "ok" : a.installed ? "warn" : "off"}
                      text={ready ? `Signed in${a.account ? ` as ${a.account}` : ""}${a.plan ? ` · ${a.plan}` : ""}` : a.installed ? "Installed, not signed in" : "Not installed"}
                    />
                  </span>
                </button>
                {!ready && <Help steps={agentHelp(a)} pad={props.narrow ? "22px" : "54px"} />}
              </div>
            );
          })}
        <div className="flex items-start gap-2.5 border-t border-line bg-sunken px-[22px] py-3">
          <span className="flex-none text-fg-3">
            <Sym name="key_off" size={17} />
          </span>
          <p className="m-0 text-[13px] text-pretty text-fg-2">
            No API keys. Runs bill to your Claude or ChatGPT subscription, and <code className="font-mono text-[12px]">ANTHROPIC_API_KEY</code> /{" "}
            <code className="font-mono text-[12px]">OPENAI_API_KEY</code> are ignored.
          </p>
        </div>
      </section>
      {ok && !busy && defaults && opts && (
        <section className={`${card} flex flex-col gap-2.5 px-[22px] py-4`}>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="m-0 text-[15px] font-semibold">Default models</h2>
            <span className="text-[13px] text-fg-3">Change later in Settings</span>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            {(["recon", "review", "qa"] as const).map((st) => (
              <span key={st} className="flex items-baseline gap-1.5 text-[13px] text-fg-3">
                {STAGE_LABEL[st]}
                <span className="font-mono text-[12.5px] text-fg">{opts.models.find((m) => m.id === defaults.models[st])?.label ?? defaults.models[st]}</span>
                <span className="text-[12px]">
                  {defaults.effort[st] === "default" ? "default effort" : `${opts.efforts.find((e) => e.key === defaults.effort[st])?.label.toLowerCase() ?? defaults.effort[st]} effort`}
                </span>
              </span>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Radio({ on, dim = false }: { on: boolean; dim?: boolean }) {
  return (
    <span
      className="mt-0.5 grid size-[18px] flex-none place-items-center rounded-full border-[1.5px]"
      style={{ borderColor: on ? "var(--accent)" : "var(--line-strong)", opacity: dim ? 0.4 : 1 }}
    >
      <span className="size-2 rounded-full" style={{ background: on ? "var(--accent)" : "transparent" }} />
    </span>
  );
}

function Status({ state, text, big = false }: { state: "ok" | "warn" | "off"; text: string; big?: boolean }) {
  const [icon, color] = state === "ok" ? ["check_circle", "var(--add)"] : state === "warn" ? ["error", "var(--warn)"] : ["do_not_disturb_on", "var(--text-3)"];
  return (
    <span className={`flex items-center gap-1.5 ${big ? "text-[14px] font-medium" : "mt-[3px] text-[13px]"}`} style={{ color }}>
      <Sym name={icon} size={big ? 17 : 16} fill />
      {text}
    </span>
  );
}

// ---------- step 2: GitHub ----------

function GhStep({ gh, busy, error, onCheck, narrow }: { gh: SetupChecks["gh"] | null; busy: boolean; error?: string; onCheck: () => void; narrow: boolean }) {
  const ok = Boolean(gh?.signedIn);
  const loginAfter = "Pick GitHub.com, HTTPS, and log in with a web browser.";
  const help: HelpStep[] = !gh || ok ? [] : gh.installed ? [{ text: "Log in to GitHub", cmds: [gh.loginCmd], after: loginAfter }] : [{ text: "Install the GitHub CLI", cmds: [gh.installCmd] }, { text: "Log in", cmds: [gh.loginCmd], after: loginAfter }];
  return (
    <section className={card}>
      <div className="border-b border-line">
        <SectionHead
          title={
            <>
              GitHub CLI <code className="rounded bg-sunken px-1.5 py-px font-mono text-[12px] font-normal text-fg-2">gh</code>
            </>
          }
          sub="PR Bunny reads PRs with gh and, only when you click Post, submits reviews through it. The agent itself never writes to GitHub."
          onCheck={onCheck}
          busy={busy}
        />
      </div>
      {busy && (
        <div className="flex items-start gap-3.5 px-[22px] py-[18px]">
          <span className="size-9 flex-none rounded-[9px] bg-sunken" />
          <span className="flex flex-1 flex-col gap-[9px]">
            {["46%", "62%", "30%"].map((w, i) => (
              <span key={w} className="block animate-pulse rounded bg-sunken" style={{ width: w, height: [10, 12, 9][i] }} />
            ))}
          </span>
        </div>
      )}
      {!busy && error && <ErrorBox className="mx-[22px] my-[18px]" title="Couldn't check gh" detail={error} />}
      {!busy && !error && gh && (
        <>
          <div className="flex items-start gap-3.5 px-[22px] py-[18px]">
            <span className="grid size-9 flex-none place-items-center rounded-[9px] border border-line bg-sunken text-fg-2">
              <Sym name="terminal" size={20} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="truncate font-mono text-[12.5px] text-fg-2">{gh.installed ? `${gh.path}${gh.version ? ` · v${gh.version}` : ""}` : "gh · not found on PATH"}</span>
              <Status big state={ok ? "ok" : gh.installed ? "warn" : "off"} text={ok ? `Logged in to github.com as @${gh.user}` : gh.installed ? "Installed, not logged in" : "Not installed"} />
              {ok && gh.scopes.length > 0 && (
                <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-fg-3">
                  Token scopes
                  {gh.scopes.map((sc) => (
                    <code key={sc} className="rounded border border-line bg-sunken px-1.5 py-px font-mono text-[11.5px] text-fg-2">
                      {sc}
                    </code>
                  ))}
                </span>
              )}
              {ok && gh.missingScopes.length > 0 && (
                <span className="mt-1.5 text-[13px] text-warn">
                  Missing {gh.missingScopes.join(", ")}. Run <Code>gh auth refresh -s {gh.missingScopes.join(",")}</Code>, then check again.
                </span>
              )}
            </div>
          </div>
          {!ok && <Help steps={help} pad={narrow ? "22px" : "72px"} />}
        </>
      )}
    </section>
  );
}

// ---------- step 3: terminal command ----------

function CliStep(props: {
  cli: CliInfo | null;
  on: boolean;
  onToggle: () => void;
  scanning: boolean;
  linking: boolean;
  error: string | null;
  onLink: (replace: boolean) => void;
  onKeep: () => void;
}) {
  const { cli, on } = props;
  const state = !on ? "off" : props.scanning || !cli ? "scan" : cli.linked ? "linked" : cli.conflict ? "conflict" : "free";
  const examples: Array<[string, string]> = [
    ["bunny review", "Self-review the current branch, including uncommitted changes"],
    ["bunny review --pr 123", "Self-review your PR #123 in this repo"],
    ["bunny review --rerun", "Check again after you've fixed things"],
  ];
  return (
    <section className={card}>
      <div className="flex items-start gap-4 px-[22px] py-[18px]">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[15px] font-semibold">
            Install the <code className="font-mono text-[13.5px] font-medium">bunny</code> command?
          </h2>
          <p className="mt-[3px] mb-0 text-[13px] text-fg-3">Start a review from any checkout. Results open here.</p>
        </div>
        <button
          onClick={props.onToggle}
          role="switch"
          aria-checked={on}
          aria-label="Install bunny"
          className={`relative mt-0.5 h-[26px] w-11 flex-none cursor-pointer rounded-full border-0 ${on ? "bg-accent" : "bg-line-strong"}`}
        >
          <span className="absolute top-[3px] size-5 rounded-full bg-surface shadow-seg transition-[left]" style={{ left: on ? 21 : 3 }} />
        </button>
      </div>
      <div className="mx-[22px] mb-[18px] flex flex-col gap-3 rounded-[10px] border border-line bg-code px-4 py-3.5" style={{ opacity: on ? 1 : 0.5 }}>
        {examples.map(([c, d]) => (
          <div key={c} className="flex flex-col gap-px">
            <code className="font-mono text-[12.5px]">
              <span className="text-fg-3">$ </span>
              {c}
            </code>
            <span className="text-[12.5px] text-fg-3">{d}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 border-t border-line px-[22px] py-4">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-fg-3">
          Symlink<code className="font-mono text-[12.5px] text-fg">{cli?.path ?? "~/.local/bin/bunny"}</code>
          <span>→</span>
          <code className="font-mono text-[12.5px] break-all text-fg-2">{cli?.target ?? "…"}</code>
        </div>
        {state === "off" && <p className="m-0 text-[13px] text-fg-3">bunny won't be installed. You can add it later from Settings › About › Run setup again.</p>}
        {state === "scan" && (
          <span className="flex items-center gap-2 text-[13px] text-fg-3">
            <Spinner size={14} />
            Checking the path…
          </span>
        )}
        {state === "free" && (
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
            <p className="m-0 flex-[1_1_200px] text-[13px] text-fg-2">Nothing at this path yet.</p>
            <button
              onClick={() => props.onLink(false)}
              disabled={props.linking}
              className="flex h-9 flex-none cursor-pointer items-center gap-2 rounded-lg border-0 bg-accent px-3.5 text-[13px] font-semibold text-on-accent"
            >
              {props.linking && <Spinner size={14} light />}
              {props.linking ? "Linking…" : "Create link"}
            </button>
          </div>
        )}
        {state === "conflict" && cli && (
          <div className="flex items-start gap-2.5 rounded-lg bg-warn-soft px-3.5 py-3">
            <span className="flex-none text-warn">
              <Sym name="warning" fill />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div>
                <p className="m-0 text-[13.5px] font-medium">Something else is already at this path</p>
                <p className="mt-0.5 mb-0 font-mono text-[12px] [overflow-wrap:anywhere] text-fg-2">{cli.conflict}</p>
              </div>
              <p className="m-0 text-[13px]">Replace it?</p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => props.onLink(true)}
                  disabled={props.linking}
                  className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border-0 bg-accent px-3.5 text-[13px] font-semibold text-on-accent"
                >
                  {props.linking && <Spinner size={14} light />}
                  {props.linking ? "Replacing…" : "Replace"}
                </button>
                <button onClick={props.onKeep} className="h-9 cursor-pointer rounded-lg border border-line-strong bg-surface px-3 text-[13px] hover:bg-hover">
                  Keep existing
                </button>
              </div>
            </div>
          </div>
        )}
        {state === "linked" && cli && (
          <div className="flex items-start gap-2.5 rounded-lg bg-add-soft px-3.5 py-3">
            <span className="flex-none text-add">
              <Sym name="check_circle" fill />
            </span>
            <p className="m-0 text-[13.5px]">
              Linked. Open a new terminal and run <code className="rounded bg-surface px-1.5 py-px font-mono text-[12px]">bunny --version</code> to check.
              {cli.onPath === false && (
                <span className="mt-1.5 block text-[13px] text-fg-2">
                  {cli.path.replace(/\/[^/]+$/, "")} isn't on your PATH yet. Add <code className="font-mono text-[12px]">export PATH="$HOME/.local/bin:$PATH"</code> to ~/.zshrc.
                </span>
              )}
            </p>
          </div>
        )}
        {props.error && <ErrorBox title="Couldn't create the link" detail={props.error} />}
      </div>
    </section>
  );
}

// ---------- step 4: repositories ----------

function ReposStep(props: {
  repos: SetupRepo[];
  roots: string[];
  busy: boolean;
  error?: string;
  onCheck: () => void;
  onRemove: (path: string) => void;
  onAdd: (r: SetupRepo) => void;
}) {
  const { repos } = props;
  const [path, setPath] = useState("");
  const [valid, setValid] = useState<{ ok: true; repo: SetupRepo } | { ok: false; text: string; neutral?: boolean } | null>(null);
  const seq = useRef(0);

  // Validate as you type (debounced): is it a checkout, with a GitHub remote, not already listed?
  useEffect(() => {
    const p = path.trim();
    const n = ++seq.current;
    if (!p) return setValid(null);
    const t = setTimeout(async () => {
      try {
        const r = await api.resolveRepo(p);
        if (n !== seq.current) return;
        if (repos.some((x) => x.path === r.path)) setValid({ ok: false, text: "Already in the list", neutral: true });
        else setValid({ ok: true, repo: r });
      } catch (e) {
        if (n === seq.current) setValid({ ok: false, text: message(e) });
      }
    }, 300);
    return () => clearTimeout(t);
  }, [path, repos]);

  const add = () => {
    if (!valid?.ok) return;
    props.onAdd(valid.repo);
    setPath("");
  };
  const pick = async () => {
    const r = await api.pickFolder().catch(() => null);
    if (r?.path) setPath(r.path);
  };

  return (
    <>
      <section className={card}>
        <SectionHead
          title="Found on this Mac"
          sub={
            <>
              Searched <span className="font-mono text-[12px]">{props.roots.join(", ") || "your code folders"}</span>
            </>
          }
          onCheck={props.onCheck}
          busy={props.busy}
        />
        {props.busy && !repos.length && <Skeleton rows={3} avatar="square" />}
        {!props.busy && props.error && <ErrorBox className="mx-[22px] mb-[18px]" title="Couldn't search for repositories" detail={props.error} />}
        {!props.busy && !props.error && !repos.length && (
          <div className="flex flex-col items-center gap-1.5 border-t border-line px-[22px] py-7 text-center">
            <span className="text-fg-3">
              <Sym name="folder_off" size={28} />
            </span>
            <p className="mt-1 mb-0 text-[14.5px] font-medium">No repositories found</p>
            <p className="m-0 max-w-[420px] text-[13px] text-pretty text-fg-3">Nothing with a GitHub remote in the usual folders. Add one below, or skip and paste a PR URL in the Inbox later.</p>
          </div>
        )}
        {repos.length > 0 && (
          <ul className="m-0 list-none p-0">
            {repos.map((r) => (
              <li key={r.path} className="flex items-center gap-3.5 border-t border-line py-3 pr-2.5 pl-[22px]">
                <span className="grid size-7 flex-none place-items-center rounded-[7px] bg-accent-soft font-mono text-[13px] font-medium text-accent">{r.repo.split("/")[1]![0]!.toUpperCase()}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-mono text-[13.5px] font-medium">{r.repo}</span>
                    {r.branch && (
                      <span className="inline-flex max-w-full items-center gap-[3px] truncate rounded bg-sunken px-1.5 font-mono text-[11.5px] text-fg-2">
                        <Sym name="call_split" size={13} />
                        {r.branch}
                      </span>
                    )}
                  </span>
                  <span className="truncate font-mono text-[12px] text-fg-3">{r.displayPath}</span>
                </span>
                <button
                  onClick={() => props.onRemove(r.path)}
                  aria-label={`Remove ${r.repo}`}
                  title="Remove"
                  className="grid size-10 flex-none cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-fg-3 hover:bg-hover hover:text-fg"
                >
                  <Sym name="close" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={`${card} flex flex-col gap-3 px-[22px] py-[18px]`}>
        <div>
          <h2 className="m-0 text-[15px] font-semibold">Add a local folder</h2>
          <p className="mt-[3px] mb-0 text-[13px] text-fg-3">A checkout with a GitHub remote.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div
            className="flex h-11 min-w-0 flex-[1_1_260px] items-center rounded-lg border bg-bg"
            style={{ borderColor: !valid ? "var(--line-strong)" : valid.ok ? "var(--add)" : valid.neutral ? "var(--line-strong)" : "var(--del)" }}
          >
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="~/Developer/my-repo"
              spellCheck={false}
              aria-label="Folder path"
              className="h-full min-w-0 flex-1 border-0 bg-transparent px-3 font-mono text-[13px] outline-none"
            />
            <button
              onClick={pick}
              aria-label="Choose folder"
              title="Choose folder…"
              className="mr-px grid size-10 flex-none cursor-pointer place-items-center rounded-[7px] border-0 bg-transparent text-fg-2 hover:bg-hover hover:text-fg"
            >
              <Sym name="folder_open" size={19} />
            </button>
          </div>
          <button
            onClick={add}
            disabled={!valid?.ok}
            className={`h-11 flex-none rounded-lg border-0 px-4 text-[13.5px] font-semibold ${valid?.ok ? "cursor-pointer bg-accent text-on-accent" : "cursor-default bg-sunken text-fg-3"}`}
          >
            Add
          </button>
        </div>
        {valid && (
          <span className="flex items-center gap-1.5 text-[13px]" style={{ color: valid.ok ? "var(--add)" : valid.neutral ? "var(--text-3)" : "var(--del)" }}>
            <Sym name={valid.ok ? "check_circle" : valid.neutral ? "info" : "cancel"} size={16} fill />
            <span className="font-mono text-[12.5px]">{valid.ok ? `git repo · GitHub remote ${valid.repo.repo}` : valid.text}</span>
          </span>
        )}
      </section>
    </>
  );
}

// ---------- step 5: review skill ----------

function SkillStep(props: {
  repos: SetupRepo[];
  skills: Record<string, RepoSkills | { error: string }>;
  busy: boolean;
  locations: string[];
  choiceOf: (r: SetupRepo) => Choice;
  onChoose: (path: string, c: Choice) => void;
  onCheck: () => void;
}) {
  const [showLocs, setShowLocs] = useState(false);
  return (
    <>
      <section className={card}>
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-[22px] py-4">
          <div className="flex min-w-0 flex-[1_1_240px] items-start gap-2.5">
            <span className="flex-none text-fg-2">
              <Sym name="lock" />
            </span>
            <p className="m-0 text-[13.5px] text-pretty text-fg-2">Read from the default branch, so a PR can't change the rules it's reviewed against.</p>
          </div>
          <CheckAgain onClick={props.onCheck} busy={props.busy} />
        </div>
        <button
          onClick={() => setShowLocs((v) => !v)}
          aria-expanded={showLocs}
          className="flex min-h-11 w-full cursor-pointer items-center gap-1.5 border-0 border-t border-line bg-transparent px-[22px] text-left text-[13px] text-fg-2 hover:bg-hover"
        >
          <span className="flex-1">Locations checked, in order of preference</span>
          <span className="text-[12.5px] text-fg-3">{props.locations.length}</span>
          <span style={{ transform: showLocs ? "rotate(180deg)" : "none" }}>
            <Sym name="expand_more" />
          </span>
        </button>
        {showLocs && (
          <ol className="m-0 flex flex-col gap-[3px] pt-1 pr-[22px] pb-4 pl-11 font-mono text-[12px] text-fg-2">
            {props.locations.map((l) => (
              <li key={l} className="[overflow-wrap:anywhere]">
                {l}
              </li>
            ))}
          </ol>
        )}
      </section>
      {!props.repos.length && (
        <section className={`${card} px-[22px] py-6 text-center`}>
          <p className="m-0 text-[14.5px] font-medium">No repositories yet</p>
          <p className="mt-1 mb-0 text-[13px] text-fg-3">When you add one later, PR Bunny looks for its instructions the same way.</p>
        </section>
      )}
      {props.repos.map((r) => (
        <RepoSkill key={r.path} repo={r} data={props.skills[r.path]} busy={props.busy} choice={props.choiceOf(r)} onChoose={(c) => props.onChoose(r.path, c)} />
      ))}
    </>
  );
}

function RepoSkill({ repo, data, busy, choice, onChoose }: { repo: SetupRepo; data?: RepoSkills | { error: string }; busy: boolean; choice: Choice; onChoose: (c: Choice) => void }) {
  const [chooser, setChooser] = useState(false);
  const [q, setQ] = useState("");
  const [files, setFiles] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<SkillPreview | { error: string } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(true);
  const scanning = busy || !data;
  const ok = data && "candidates" in data ? data : null;
  const branch = ok?.branch ?? "main";

  useEffect(() => {
    if (!chooser) return;
    const t = setTimeout(() => api.skillFiles(repo.path, q).then(setFiles, () => setFiles([])), 200);
    return () => clearTimeout(t);
  }, [chooser, q, repo.path]);

  useEffect(() => {
    setPreview(null);
    if (!choice || scanning) return;
    let live = true;
    api.skillPreview(repo.path, choice).then(
      (p) => live && setPreview(p),
      (e) => live && setPreview({ error: message(e) }),
    );
    return () => {
      live = false;
    };
  }, [choice, scanning, repo.path]);

  const options: Array<{ key: string; label: string; why: string; val?: Choice; suggested?: boolean; mono?: boolean; chooser?: boolean }> = [];
  for (const c of ok?.candidates ?? []) options.push({ key: c.path, label: c.path, why: c.why, val: c.path, suggested: c.suggested, mono: true });
  if (choice && !ok?.candidates.some((c) => c.path === choice)) options.push({ key: `custom:${choice}`, label: choice, why: "Chosen by you", val: choice, mono: true });
  options.push({ key: "chooser", label: "Choose another file…", why: "Any file in the repo", chooser: true });
  options.push({ key: "none", label: "None — use generic criteria", why: "PR Bunny's built-in checklist", val: null });

  return (
    <section className={card}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-[22px] py-3.5">
        <span className="font-mono text-[14px] font-medium">{repo.repo}</span>
        <span className="text-[12.5px] text-fg-3">
          {scanning ? `Scanning ${branch}…` : ok ? (ok.candidates.length ? `${ok.candidates.length} found on ${branch}` : `Nothing found on ${branch}`) : "Couldn't scan"}
        </span>
      </div>
      {scanning && <Skeleton rows={2} />}
      {!scanning && data && "error" in data && <ErrorBox className="mx-[22px] my-4" title="Couldn't read this repo" detail={data.error} />}
      {!scanning && ok && (
        <>
          <div role="radiogroup" aria-label={`Review instructions for ${repo.repo}`}>
            {options.map((o, i) => {
              const sel = !o.chooser && o.val === choice;
              return (
                <button
                  key={o.key}
                  onClick={() => {
                    if (o.chooser) return setChooser((v) => !v);
                    onChoose(o.val ?? null);
                    setChooser(false);
                  }}
                  role="radio"
                  aria-checked={sel}
                  className={`flex w-full cursor-pointer items-start gap-3 border-0 px-[22px] py-3 text-left text-fg ${i ? "border-t border-line" : ""} ${sel ? "bg-accent-soft" : o.chooser && chooser ? "bg-sunken" : "bg-transparent hover:bg-hover"}`}
                >
                  {o.chooser ? (
                    <span className="mt-px flex-none text-fg-2">
                      <Sym name="folder_open" />
                    </span>
                  ) : (
                    <Radio on={sel} />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={o.mono ? "font-mono text-[13px] [overflow-wrap:anywhere]" : "text-[13.5px] font-medium"}>{o.label}</span>
                      {o.suggested && <span className="rounded-full bg-accent-soft px-[7px] py-px text-[11px] font-semibold text-accent">Suggested</span>}
                    </span>
                    <span className="text-[12.5px] text-fg-3">{o.why}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {chooser && (
            <div className="flex flex-col gap-2 border-t border-line bg-sunken px-[22px] pt-3 pb-3.5">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Filter files in ${repo.repo}`}
                spellCheck={false}
                autoFocus
                className="h-10 rounded-lg border border-line-strong bg-surface px-3 font-mono text-[12.5px] outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
              />
              <div className="flex max-h-[280px] flex-col overflow-y-auto rounded-lg border border-line bg-surface">
                {files === null && (
                  <span className="flex items-center gap-2 px-3 py-2.5 text-[13px] text-fg-3">
                    <Spinner size={13} />
                    Loading files…
                  </span>
                )}
                {files?.map((f, i) => (
                  <button
                    key={f}
                    onClick={() => {
                      onChoose(f);
                      setChooser(false);
                      setQ("");
                    }}
                    className={`flex min-h-10 cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left font-mono text-[12.5px] hover:bg-hover ${i ? "border-t border-line" : ""}`}
                  >
                    <span className="text-fg-3">
                      <Sym name="description" size={16} />
                    </span>
                    <span className="[overflow-wrap:anywhere]">{f}</span>
                  </button>
                ))}
                {files?.length === 0 && <span className="px-3 py-2.5 text-[13px] text-fg-3">No files match.</span>}
              </div>
            </div>
          )}
          {choice && (
            <div className="border-t border-line">
              <button
                onClick={() => setPreviewOpen((v) => !v)}
                aria-expanded={previewOpen}
                className="flex min-h-11 w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-[22px] text-left hover:bg-hover"
              >
                <span className="text-fg-3">
                  <Sym name="visibility" size={17} />
                </span>
                <span className="min-w-0 flex-1 text-[13px] text-fg-2">
                  Preview <span className="text-fg-3">· first {preview && "lines" in preview ? preview.lines.length : 20} lines on {branch}</span>
                </span>
                <span className="text-fg-3" style={{ transform: previewOpen ? "rotate(180deg)" : "none" }}>
                  <Sym name="expand_more" />
                </span>
              </button>
              {previewOpen && (
                <div className="mx-[22px] mb-[18px] max-h-[360px] overflow-auto rounded-lg border border-line bg-code">
                  {!preview && (
                    <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-fg-3">
                      <Spinner size={13} />
                      Loading…
                    </div>
                  )}
                  {preview && "error" in preview && <div className="px-4 py-3 text-[13px] text-del">{preview.error}</div>}
                  {preview && "lines" in preview && (
                    <div className="min-w-max py-2 font-mono text-[12px] leading-[1.7]">
                      {preview.lines.map((t, i) => (
                        <div key={i} className="flex">
                          <span className="w-10 flex-none pr-3 text-right text-fg-3 tabular-nums select-none">{i + 1}</span>
                          <span className="pr-4 whitespace-pre text-fg">{t || " "}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------- summary and done ----------

function Summary(props: {
  agent: AgentInfo | null;
  settings: SettingsResponse;
  provider: Provider | null;
  gh: SetupChecks["gh"] | null;
  cliOn: boolean;
  cli: CliInfo | null;
  repos: SetupRepo[];
  choiceOf: (r: SetupRepo) => Choice;
  config: SetupConfig | null;
  configPath: string;
  onEdit: (step: number) => void;
}) {
  const [showJson, setShowJson] = useState(false);
  const { agent, gh, repos } = props;
  const agentOk = Boolean(agent?.installed && agent.signedIn);
  const ghOk = Boolean(gh?.signedIn);
  const cliLinked = props.cliOn && Boolean(props.cli?.linked);
  const n = repos.length;
  const withSkill = repos.filter((r) => props.choiceOf(r)).length;
  const opts = props.provider ? props.settings.providers[props.provider] : null;
  const models = props.config && opts ? (["recon", "review", "qa"] as const).map((st) => `${STAGE_LABEL[st]}: ${opts.models.find((m) => m.id === props.config!.models[st])?.label ?? props.config!.models[st]}`).join(" · ") : "";
  const rows = [
    { label: "Coding agent", value: agent ? `${agent.label}${agent.account ? ` · ${agent.account}` : ""}` : "Not chosen", sub: models, ok: agentOk, step: 0 },
    { label: "GitHub CLI", value: ghOk ? `Logged in as @${gh!.user}` : "Not logged in", sub: gh?.path ?? "", ok: ghOk, step: 1 },
    { label: "Terminal command", value: cliLinked ? "bunny is linked" : props.cliOn ? "Not linked yet" : "Not installed", sub: cliLinked ? props.cli!.path : "", ok: cliLinked, neutral: !props.cliOn, step: 2 },
    { label: "Repositories", value: n ? `${n} ${n === 1 ? "repository" : "repositories"}` : "None yet", sub: n ? repos.map((r) => r.repo).join(", ") : "Add one later by pasting a PR URL", ok: n > 0, neutral: !n, step: 3 },
    {
      label: "Review skill",
      value: n ? `${withSkill} of ${n} use their own instructions` : "No repositories",
      sub: repos.map((r) => `${r.repo.split("/")[1]}: ${props.choiceOf(r) ?? "generic"}`).join(" · "),
      ok: n > 0 && withSkill > 0,
      neutral: !n || !withSkill,
      step: 4,
    },
  ];
  return (
    <>
      <section className={card}>
        {rows.map((r, i) => {
          const [icon, color] = r.ok ? ["check_circle", "var(--add)"] : r.neutral ? ["do_not_disturb_on", "var(--text-3)"] : ["error", "var(--warn)"];
          return (
            <div key={r.label} className={`flex items-start gap-3.5 py-3.5 pr-2.5 pl-[22px] ${i ? "border-t border-line" : ""}`}>
              <span className="mt-0.5 flex-none" style={{ color }}>
                <Sym name={icon} fill />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="text-[12.5px] text-fg-3">{r.label}</span>
                <span className="text-[14.5px] font-medium">{r.value}</span>
                {r.sub && <span className="font-mono text-[12px] [overflow-wrap:anywhere] text-fg-3">{r.sub}</span>}
              </div>
              <button onClick={() => props.onEdit(r.step)} className="h-9 flex-none cursor-pointer rounded-lg border-0 bg-transparent px-3 text-[13px] font-medium text-accent hover:bg-accent-soft">
                Edit
              </button>
            </div>
          );
        })}
      </section>
      <section className={card}>
        <button onClick={() => setShowJson((v) => !v)} aria-expanded={showJson} className="flex min-h-[52px] w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-[22px] text-left hover:bg-hover">
          <span className="text-fg-3">
            <Sym name="data_object" />
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <span className="text-[14px] font-medium">What gets saved</span>
            <span className="font-mono text-[12px] text-fg-3">{props.configPath}</span>
          </span>
          <span className="text-fg-3" style={{ transform: showJson ? "rotate(180deg)" : "none" }}>
            <Sym name="expand_more" size={20} />
          </span>
        </button>
        {showJson && (
          <pre className="m-0 overflow-x-auto border-t border-line bg-code px-[22px] pt-3.5 pb-[18px] font-mono text-[12px] leading-[1.65] text-fg">
            {JSON.stringify(props.config ?? {}, null, 2)}
          </pre>
        )}
      </section>
    </>
  );
}

function Done({ reentry, agent, ghUser, cliInstalled, firstRepo, onOpen }: { reentry: boolean; agent: AgentInfo | null; ghUser: string | null; cliInstalled: boolean; firstRepo: string | null; onOpen: () => void }) {
  const [showTry, setShowTry] = useState(false);
  return (
    <section className="mt-2 flex flex-col gap-[18px] rounded-xl border border-line bg-surface px-[26px] py-7">
      <span className="text-add">
        <Sym name="check_circle" size={34} fill />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[24px] leading-[1.25] font-semibold tracking-[-0.012em]">{reentry ? "Changes saved" : "You're set up"}</h1>
        <p className="m-0 text-[14.5px] text-pretty text-fg-2">
          PR Bunny will review with {agent?.label ?? "your agent"}
          {ghUser ? ` and read GitHub as @${ghUser}` : ""}. Change any of this in Settings.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={onOpen} className="flex h-10 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-accent px-4 text-[13.5px] font-semibold text-on-accent">
          Open Inbox
          <Sym name="arrow_forward" />
        </button>
        {cliInstalled && (
          <button
            onClick={() => setShowTry((v) => !v)}
            aria-expanded={showTry}
            className="flex h-10 cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3.5 text-[13.5px] hover:bg-hover"
          >
            Try <code className="font-mono text-[12.5px]">bunny review</code> in a checkout
          </button>
        )}
      </div>
      {showTry && (
        <div className="flex flex-col gap-2">
          <Cmd cmd={`cd ${firstRepo ?? "~/Developer/my-repo"}`} />
          <Cmd cmd="bunny review" />
          <p className="m-0 text-[13px] text-fg-3">Reviews your branch, uncommitted changes included, and opens the result here.</p>
        </div>
      )}
    </section>
  );
}

// ---------- helpers ----------

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
