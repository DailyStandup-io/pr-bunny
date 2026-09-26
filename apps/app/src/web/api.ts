import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  ActiveRun,
  HiddenItem,
  HousekeepingPrefs,
  Inbox,
  InboxEntry,
  LiveEvent,
  ModelOption,
  PrStatus,
  AgentInfo,
  Provider,
  ProviderOptions,
  ReviewDetail,
  ReviewEvent,
  RepoSkills,
  ReviewSummary,
  SelfSources,
  SetupChecks,
  SetupInput,
  SetupRepo,
  SetupState,
  SkillPreview,
  CliInfo,
  UpdateState,
  StackDetail,
  StackSummary,
  StackSubmissionLayer,
  Settings,
  Stats,
  SuggestedReviewer,
} from "../shared/types";

export type SettingsResponse = { settings: Settings; modelOptions: ModelOption[]; providers: Record<Provider, ProviderOptions> };

export interface Submission {
  comments: Array<{ findingId: number; path: string; line: number; startLine: number | null; side: "RIGHT" | "LEFT"; body: string }>;
  body: string;
  undecided: number;
  suggestedEvent: ReviewEvent;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

const post = <T>(path: string, data?: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(data ?? {}) });

export const api = {
  inbox: () => request<Inbox>("/api/inbox"),
  repoPrs: (repo: string) => request<InboxEntry[]>(`/api/repos/${repo}/prs`),
  search: (q: string) => request<InboxEntry[]>(`/api/search?q=${encodeURIComponent(q)}`),
  reviews: () => request<ReviewSummary[]>("/api/reviews"),
  stats: () => request<Stats>("/api/stats"),
  settings: () => request<SettingsResponse>("/api/settings"),
  saveSettings: (patch: Partial<Settings>) => post<SettingsResponse>("/api/settings", patch),
  resetSettings: () => post<SettingsResponse>("/api/settings/reset"),
  setup: () => request<SetupState>("/api/setup"),
  setupChecks: () => request<SetupChecks>("/api/setup/checks"),
  setupRepos: () => request<SetupRepo[]>("/api/setup/repos"),
  resolveRepo: (path: string) => post<SetupRepo>("/api/setup/repos/resolve", { path }),
  repoSkills: (path: string) => request<RepoSkills>(`/api/setup/skills?path=${encodeURIComponent(path)}`),
  skillFiles: (path: string, q: string) => request<string[]>(`/api/setup/skills/files?path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}`),
  skillPreview: (path: string, file: string) =>
    request<SkillPreview>(`/api/setup/skills/preview?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}`),
  completeSetup: (input: SetupInput) => post<SetupState>("/api/setup", input),
  stacks: () => request<StackSummary[]>("/api/stacks"),
  openStack: (pr: string | number, repo?: string | null, reviewAll = false) => post<{ id: number }>("/api/stacks", { pr, repo: repo ?? undefined, reviewAll }),
  stack: (id: number) => request<StackDetail>(`/api/stacks/${id}`),
  stackRun: (id: number, state: "running" | "paused" | "idle") => post<StackDetail>(`/api/stacks/${id}/run`, { state }),
  stackLayerStart: (id: number, pr: number) => post<{ reviewId: number }>(`/api/stacks/${id}/layers/${pr}/start`),
  stackLayerSkip: (id: number, pr: number, skip: boolean) => post<StackDetail>(`/api/stacks/${id}/layers/${pr}/skip`, { skip }),
  stackLayerEvent: (id: number, pr: number, event: ReviewEvent | null) => post<StackSubmissionLayer[]>(`/api/stacks/${id}/layers/${pr}/event`, { event }),
  stackRereview: (id: number) => post<{ started: number }>(`/api/stacks/${id}/rereview`),
  stackCross: (id: number) => post(`/api/stacks/${id}/cross`),
  stackSubmission: (id: number) => request<StackSubmissionLayer[]>(`/api/stacks/${id}/submission`),
  stackSummary: (id: number, on: boolean, text: string | null) => post(`/api/stacks/${id}/summary`, { on, text }),
  stackPost: (id: number) => post<Array<{ pr: number; ok: boolean; url?: string; error?: string }>>(`/api/stacks/${id}/post`),
  decideStackFinding: (id: number, decision: "accepted" | "dismissed" | null, opts: { soft?: boolean; reason?: string } = {}) =>
    post(`/api/stack-findings/${id}/decision`, { decision, ...opts }),
  stackComment: (placementId: number, comment: string) => post(`/api/stack-findings/placements/${placementId}/comment`, { comment }),
  linkCli: (replace: boolean) => post<CliInfo>("/api/setup/cli", { replace }),
  pickFolder: () => post<{ path: string | null }>("/api/setup/pick-folder"),
  health: () => request<{ ok: boolean; version: string; name: string; url: string; demo?: boolean }>("/api/health"),
  update: () => request<UpdateState>("/api/update"),
  checkUpdate: () => post<UpdateState>("/api/update/check"),
  installUpdate: () => post<UpdateState>("/api/update/install"),
  restartForUpdate: () => post<UpdateState>("/api/update/restart"),
  review: (id: number) => request<ReviewDetail>(`/api/reviews/${id}`),
  start: (pr: string, repo?: string | null) => post<{ id: number }>("/api/reviews", { pr, repo: repo ?? undefined }),
  markRead: (id: number) => post<ReviewDetail>(`/api/reviews/${id}/read`),
  retry: (id: number) => post<ReviewDetail>(`/api/reviews/${id}/retry`),
  continueRun: (id: number, turns: number, setDefault?: number) => post<ReviewDetail>(`/api/reviews/${id}/continue`, { turns, setDefault }),
  cancel: (id: number, force = false) => post<{ stopping: boolean }>(`/api/reviews/${id}/cancel`, { force }),
  resume: (id: number) => post<{ resumed: boolean; review: ReviewDetail }>(`/api/reviews/${id}/resume`),
  restart: (id: number) => post<ReviewDetail>(`/api/reviews/${id}/restart`),
  clearReviews: (ids: number[]) => post<{ cleared: number[] }>("/api/reviews/clear", { ids }),
  restoreReviews: (ids: number[]) => post<{ restored: number[] }>("/api/reviews/restore", { ids }),
  hidden: () => request<HiddenItem[]>("/api/hidden"),
  hide: (items: Array<Omit<HiddenItem, "hiddenAt">>) => post<HiddenItem[]>("/api/hidden", { items }),
  unhide: (keys: string[]) => post<HiddenItem[]>("/api/hidden/restore", { keys }),
  housekeeping: () => request<HousekeepingPrefs>("/api/housekeeping"),
  saveHousekeeping: (patch: Partial<HousekeepingPrefs>) => post<HousekeepingPrefs>("/api/housekeeping", patch),
  stackStop: (id: number, keepFinished: boolean) => post<{ stopped: number; removed: number[]; stack: StackDetail }>(`/api/stacks/${id}/stop`, { keepFinished }),
  rereview: (id: number) => post<{ id: number }>(`/api/reviews/${id}/rereview`),
  submission: (id: number) => request<Submission>(`/api/reviews/${id}/submission`),
  submit: (id: number, event: ReviewEvent, body: string) => post<{ url: string }>(`/api/reviews/${id}/submission`, { event, body }),
  status: (id: number) => request<PrStatus>(`/api/reviews/${id}/status`),
  approve: (id: number, body: string) => post(`/api/reviews/${id}/approve`, { body }),
  decide: (findingId: number, decision: "accepted" | "dismissed" | null, reason?: string) =>
    post(`/api/findings/${findingId}/decision`, { decision, reason }),
  comment: (findingId: number, comment: string) => post(`/api/findings/${findingId}/comment`, { comment }),
  ask: (findingId: number, question: string) => post(`/api/findings/${findingId}/ask`, { question }),
  askPr: (id: number, question: string) => post(`/api/reviews/${id}/ask`, { question }),
  active: () => request<ActiveRun[]>("/api/active"),
  agents: () => request<AgentInfo[]>("/api/agents"),
  selfSources: (repo: string) => request<SelfSources>(`/api/self/sources?repo=${encodeURIComponent(repo)}`),
  startSelf: (input: { localPath?: string; repo?: string; branch?: string; base?: string; includeDirty?: boolean; pr?: number }) =>
    post<{ id: number; reused: boolean }>("/api/self-reviews", input),
  rerun: (id: number) => post<ReviewDetail>(`/api/reviews/${id}/rerun`),
  reviewers: (id: number) => request<SuggestedReviewer[]>(`/api/reviews/${id}/reviewers`),
  openPr: (id: number, reviewers: string[]) => post<{ number: number; url: string; created: boolean }>(`/api/reviews/${id}/open-pr`, { reviewers }),
};

/** Loads async data and re-runs when deps change. `reload` re-fetches without flashing empty. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => live && setState({ data, loading: false }),
      (e) => live && setState((s) => ({ ...s, error: String(e.message ?? e), loading: false })),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

/** Subscribes to a review's live events. Reconnects with backoff; the server replays a backlog on connect. */
export function useLive(reviewId: number, onEvent: (ev: LiveEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let delay = 500;
    const connect = () => {
      ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/reviews/${reviewId}`);
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
  }, [reviewId]);
}

/**
 * Every running scan/deep review, kept live: the list is re-fetched when a run starts or ends, and
 * progress lines are appended as they arrive. Drives the rail spinner and the review home cards.
 */
export function useActivity(): ActiveRun[] {
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => api.active().then((r) => live && setRuns(r), () => {}), 200);
    };
    refresh();
    let ws: WebSocket | null = null;
    let delay = 500;
    const connect = () => {
      ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/activity`);
      ws.onopen = () => {
        delay = 500;
        refresh();
      };
      ws.onmessage = (m) => {
        const ev = JSON.parse(m.data) as LiveEvent;
        if (ev.type === "phase" || ev.type === "run") refresh();
        else if (ev.type === "progress" && ev.runKind !== "qa")
          setRuns((rs) =>
            rs.map((r) => (r.reviewId === ev.reviewId && r.stage === ev.runKind ? { ...r, lines: [...r.lines, { text: ev.text, tool: ev.tool, at: ev.at }].slice(-3) } : r)),
          );
      };
      ws.onclose = () => {
        if (!live) return;
        setTimeout(connect, delay);
        delay = Math.min(delay * 2, 8000);
      };
    };
    connect();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);
  return runs;
}

/** Re-renders every second, for elapsed-time clocks. */
export function useNow(active = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** m:ss since `iso`. */
export const elapsed = (iso: string, now = Date.now()) => {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Where you left a review (tab and finding), so "Resume" goes straight back there. */
export interface ReviewPos {
  tab: "overview" | "findings" | "submit" | "status";
  idx: number;
}
export function readPos(id: number): ReviewPos | null {
  try {
    const raw = localStorage.getItem(`pb:pos:${id}`);
    return raw ? (JSON.parse(raw) as ReviewPos) : null;
  } catch {
    return null;
  }
}
export function savePos(id: number, patch: Partial<ReviewPos>) {
  try {
    const next = { tab: "overview", idx: 0, ...readPos(id), ...patch };
    localStorage.setItem(`pb:pos:${id}`, JSON.stringify(next));
  } catch {}
}

/** Self-review: your edits to a finding's coding-agent prompt (they don't change the finding). */
export function readPrompt(findingId: number): string | null {
  try {
    return localStorage.getItem(`pb:prompt:${findingId}`);
  } catch {
    return null;
  }
}
export function savePrompt(findingId: number, text: string | null) {
  try {
    if (text == null) localStorage.removeItem(`pb:prompt:${findingId}`);
    else localStorage.setItem(`pb:prompt:${findingId}`, text);
  } catch {}
}

/** Copies text, and flips `key` into a "Copied" state for a moment. */
export function useCopy(): [string | null, (text: string, key: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = (text: string, key: string) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch {}
    setCopied(key);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1600);
  };
  return [copied, copy];
}

// ---------- which agent runs reviews ----------

let agentLabel: "Claude" | "Codex" = "Claude";
const agentListeners = new Set<() => void>();
/** Re-reads Settings so labels follow the agent in use (called on load and after saving). */
export function refreshAgentLabel() {
  api.settings().then(
    (r) => {
      const next = r.settings.provider === "codex" ? "Codex" : "Claude";
      if (next !== agentLabel) {
        agentLabel = next;
        agentListeners.forEach((l) => l());
      }
    },
    () => {},
  );
}
refreshAgentLabel();

/** "Claude" or "Codex": the agent named in "Ask …", verdicts and progress text. */
export function useAgentLabel(): "Claude" | "Codex" {
  return useSyncExternalStore(
    (cb) => {
      agentListeners.add(cb);
      return () => agentListeners.delete(cb);
    },
    () => agentLabel,
  );
}

// ---------- per-browser preferences ----------

/** localStorage-backed state for small UI preferences. Storage can be unavailable; then it's just state. */
export function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      // `rp:` and `rd:` are the old review.pr / review-desk prefixes; read them until the value is next saved.
      const raw = localStorage.getItem(`pb:${key}`) ?? localStorage.getItem(`rp:${key}`) ?? localStorage.getItem(`rd:${key}`);
      return raw == null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(`pb:${key}`, JSON.stringify(v));
    } catch {}
  };
  return [value, set];
}

/** Viewport-driven layout, with the same breakpoints as the design (content width excludes the 76px rail). */
export function useLayout() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const narrow = w < 760;
  const contentW = narrow ? w : w - 76;
  const wide = contentW >= 1180;
  const mid = !wide && contentW >= 820;
  return { narrow, wide, mid, stickyBottom: narrow ? 64 : 0 };
}

// ---------- tiny router ----------

const listeners = new Set<() => void>();
window.addEventListener("popstate", () => listeners.forEach((l) => l()));

export function navigate(path: string) {
  if (path === location.pathname) return;
  history.pushState(null, "", path);
  listeners.forEach((l) => l());
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => location.pathname,
  );
}

// ---------- theme ----------

export type ThemePref = "system" | "light" | "dark";
const themeListeners = new Set<() => void>();
const readThemePref = (): ThemePref => {
  try {
    const raw = localStorage.getItem("pb:theme") ?? localStorage.getItem("rp:theme") ?? localStorage.getItem("rd:theme");
    const v = raw ? JSON.parse(raw) : null;
    return v === "light" || v === "dark" ? v : "system"; // null (never picked) = follow the OS
  } catch {
    return "system";
  }
};
let themePref = readThemePref();
const dark = window.matchMedia?.("(prefers-color-scheme: dark)");
dark?.addEventListener("change", () => themeListeners.forEach((l) => l()));

/** Theme preference (System / Light / Dark) and the theme it resolves to, shared app-wide. */
export function useTheme(): { pref: ThemePref; theme: "light" | "dark"; setPref: (p: ThemePref) => void } {
  const pref = useSyncExternalStore(
    (cb) => {
      themeListeners.add(cb);
      return () => themeListeners.delete(cb);
    },
    () => themePref,
  );
  useSyncExternalStore(
    (cb) => {
      themeListeners.add(cb);
      return () => themeListeners.delete(cb);
    },
    () => dark?.matches ?? false,
  );
  const theme = pref === "system" ? (dark?.matches ? "dark" : "light") : pref;
  const setPref = (p: ThemePref) => {
    themePref = p;
    try {
      localStorage.setItem("pb:theme", JSON.stringify(p === "system" ? null : p));
    } catch {}
    themeListeners.forEach((l) => l());
  };
  return { pref, theme, setPref };
}

// ---------- updates ----------

let update: UpdateState | null = null;
const updateListeners = new Set<() => void>();
let updateTimer: ReturnType<typeof setTimeout> | null = null;
const setUpdate = (u: UpdateState) => {
  update = u;
  updateListeners.forEach((l) => l());
  schedulePoll();
};
/** Polls the update state: slowly while idle, quickly while downloading or restarting. */
function schedulePoll() {
  if (updateTimer) clearTimeout(updateTimer);
  const busy = update?.status === "downloading" || update?.status === "checking";
  updateTimer = setTimeout(pollUpdate, busy ? 600 : 5 * 60_000);
}
function pollUpdate() {
  api.update().then(setUpdate, () => schedulePoll());
}
pollUpdate();

/** After "Restart now": wait for the server to come back on the new version, then reload the page. */
async function waitForRestart(from: string) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = await api.health().catch(() => null);
    if (h && h.version !== from) return location.reload();
  }
  pollUpdate();
}

export const updates = {
  check: () => {
    if (update) setUpdate({ ...update, status: "checking", error: null });
    return api.checkUpdate().then(setUpdate, (e) => update && setUpdate({ ...update, status: "error", error: String(e.message ?? e) }));
  },
  install: () => api.installUpdate().then(setUpdate, (e) => update && setUpdate({ ...update, status: "error", error: String(e.message ?? e) })),
  restart: () =>
    api.restartForUpdate().then(
      (u) => {
        setUpdate(u);
        waitForRestart(u.current.version);
      },
      (e) => update && setUpdate({ ...update, status: "error", error: String(e.message ?? e) }),
    ),
};

export function useUpdate(): UpdateState | null {
  return useSyncExternalStore(
    (cb) => {
      updateListeners.add(cb);
      return () => updateListeners.delete(cb);
    },
    () => update,
  );
}
