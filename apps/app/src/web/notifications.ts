// Notifications in the browser: the permission state, the bell's feed (kept live over
// /ws/notifications), and desktop alerts. The server records events; the open tab decides whether
// each one also becomes a desktop alert (permission, the master switch, quiet hours, focus,
// bundling) and shows it through the service worker so a click can focus or reopen the tab.
import { useSyncExternalStore } from "react";
import type { AppNotification, NotificationEvent, NotificationFeed, NotificationSettings, NotifyKind } from "../shared/types";
import { navigate, savePos } from "./api";
import { BUNNY_FACES } from "./components/Bunny";
import { bundleText, inQuietHours } from "../shared/notify";

// ---------- a tiny store helper ----------

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => {
      value = v;
      listeners.forEach((l) => l());
    },
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}

async function call<T>(path: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

// ---------- events ----------

/** Setting labels, grouped as in Settings › Notifications. */
export const EVENT_GROUPS: Array<{ name: string; github?: boolean; items: Array<{ key: NotifyKind; label: string; hint?: string; short: string }> }> = [
  {
    name: "GitHub",
    github: true,
    items: [
      { key: "req", label: "I'm requested as a reviewer", short: "review requests" },
      { key: "assign", label: "I'm assigned a PR", short: "assignments" },
      { key: "stackUpd", label: "A PR in one of my stacks is updated", hint: "New commits or a rebase on any layer", short: "stack updates" },
      { key: "myReview", label: "My PR gets a review", hint: "Approvals and comments", short: "reviews of my PRs" },
      { key: "changesReq", label: "Changes are requested on my PR", hint: "With Fix and Don't fix: the agent makes the changes, you approve before anything is pushed", short: "changes requested" },
    ],
  },
  {
    name: "Reviews",
    items: [
      { key: "overview", label: "Overview is ready to read", hint: "The quick scan, usually done in a minute", short: "overviews" },
      { key: "deep", label: "Deep review finished", short: "finished reviews" },
      { key: "failed", label: "Review failed or ran out of turns", short: "failed reviews" },
      { key: "changed", label: "A PR changed since I reviewed it", hint: "New commits after your last review", short: "PRs changed since review" },
      { key: "fixReady", label: "A fix is ready to approve", hint: "The agent finished the changes a reviewer asked for", short: "fixes ready" },
    ],
  },
  {
    name: "Stacks",
    items: [
      { key: "all", label: "Review all finished", short: "Review all" },
      { key: "across", label: "Across-the-stack pass is ready", short: "stack passes" },
    ],
  },
  { name: "App", items: [{ key: "update", label: "A new PR Bunny version is available", short: "updates" }] },
];
export const EVENT_LABEL = Object.fromEntries(EVENT_GROUPS.flatMap((g) => g.items.map((i) => [i.key, i]))) as Record<NotifyKind, (typeof EVENT_GROUPS)[number]["items"][number]>;

/** The server's defaults (settings.ts), for "Turn on the defaults". */
export const DEFAULT_EVENTS: Record<NotifyKind, boolean> = {
  req: true,
  assign: true,
  stackUpd: false,
  myReview: true,
  changesReq: true,
  overview: false,
  deep: true,
  failed: true,
  changed: false,
  fixReady: true,
  all: true,
  across: true,
  update: true,
};

/** The ones offered in setup. */
export const SETUP_EVENTS: NotifyKind[] = ["req", "myReview", "changesReq", "deep", "failed", "changed"];

/** A mascot face for a notification (null in builds without the art). */
export const faceFor = (key: string): string | null => BUNNY_FACES[key as keyof typeof BUNNY_FACES] ?? null;

// ---------- permission ----------

/** "asking" while the browser's prompt is up. */
export type Permission = "unsupported" | "default" | "asking" | "granted" | "denied";

const supported = () => typeof window !== "undefined" && "Notification" in window && window.isSecureContext;
const readPermission = (): Permission => (supported() ? (Notification.permission as Permission) : "unsupported");
const permission = store<Permission>(readPermission());

// Follows changes made in the browser's site settings while the page is open.
try {
  navigator.permissions
    ?.query({ name: "notifications" as PermissionName })
    .then((st) => {
      st.onchange = () => permission.get() !== "asking" && permission.set(readPermission());
    })
    .catch(() => {});
} catch {}

export function usePermission(): Permission {
  return useSyncExternalStore(permission.subscribe, permission.get);
}

/** Asks once (the browser remembers the answer). Resolves to the new state. */
export async function askPermission(): Promise<Permission> {
  if (!supported()) return "unsupported";
  permission.set("asking");
  try {
    permission.set((await Notification.requestPermission()) as Permission);
  } catch {
    permission.set(readPermission());
  }
  return permission.get();
}

/** "Check again" after allowing in the browser's settings. */
export function recheckPermission(): Permission {
  permission.set(readPermission());
  return permission.get();
}

// ---------- which browser (for the unblock steps) ----------

export type BrowserName = "Chrome" | "Arc" | "Edge" | "Firefox" | "Safari";

export function browserName(): BrowserName {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Edg\//.test(ua)) return "Edge";
  try {
    if (getComputedStyle(document.documentElement).getPropertyValue("--arc-palette-title")) return "Arc";
  } catch {}
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Chrome";
}

const APP_NAME: Record<BrowserName, string> = { Chrome: "Google Chrome", Arc: "Arc", Edge: "Microsoft Edge", Firefox: "Firefox", Safari: "Safari" };

/** How to unblock notifications for this site: in the browser, then in macOS. */
export function unblockSteps(browser = browserName(), host = location.hostname): string[] {
  const site: Record<BrowserName, string> = {
    Chrome: `Click the icon to the left of ${host} in the address bar, set Notifications to Allow, then reload.`,
    Edge: `Click the icon to the left of ${host} in the address bar, set Notifications to Allow, then reload.`,
    Arc: "Click the site icon in the address bar, open Site settings and set Notifications to Allow.",
    Firefox: "Click the lock to the left of the address, clear Blocked next to Send notifications, then reload.",
    Safari: `Open Safari › Settings › Websites › Notifications and set ${host} to Allow.`,
  };
  return [site[browser], `Still blocked? Open System Settings › Notifications › ${APP_NAME[browser]} and turn on Allow notifications.`];
}

// ---------- settings (read fresh when needed; they only change from Settings or setup) ----------

let settingsCache: { at: number; value: Promise<NotificationSettings | null> } | null = null;
export function notifySettings(force = false): Promise<NotificationSettings | null> {
  if (!force && settingsCache && Date.now() - settingsCache.at < 10_000) return settingsCache.value;
  const value = call<{ settings: { notifications: NotificationSettings } }>("/api/settings").then(
    (r) => r.settings.notifications,
    () => null,
  );
  settingsCache = { at: Date.now(), value };
  return value;
}

// ---------- the feed ----------

const feed = store<NotificationFeed | null>(null);

export function useFeed(): NotificationFeed | null {
  return useSyncExternalStore(feed.subscribe, feed.get);
}

const loadFeed = () => call<NotificationFeed>("/api/notifications").then(feed.set, () => {});

/** Fix / Don't fix on a "changes requested" entry. Fix starts the agent and opens the fix page. */
export async function fixNotification(id: number) {
  markLocal(id);
  const r = await call<{ fixId: number }>(`/api/notifications/${id}/fix`, "POST");
  navigate(`/fix/${r.fixId}`);
  return r;
}
export async function skipNotification(id: number) {
  markLocal(id);
  await call<{ fixId: number }>(`/api/notifications/${id}/skip`, "POST");
  loadFeed();
}
function markLocal(id: number) {
  const f = feed.get();
  const was = f?.items.find((i) => i.id === id);
  if (f) feed.set({ unseen: Math.max(0, f.unseen - (was && !was.seen ? 1 : 0)), items: f.items.map((i) => (i.id === id ? { ...i, seen: true, read: true } : i)) });
}

export const bell = {
  reload: loadFeed,
  readAll: () => {
    const f = feed.get();
    if (f) feed.set({ unseen: 0, items: f.items.map((i) => ({ ...i, seen: true, read: true })) });
    return call("/api/notifications/read", "POST").catch(() => {});
  },
};

/** Goes where a notification points: an app path (with an optional #anchor) or a GitHub URL. */
function go(path: string) {
  if (/^https?:\/\//.test(path)) {
    window.open(path, "_blank", "noopener");
    return;
  }
  navigate(path);
  const hash = path.split("#")[1];
  if (hash) setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
}

/** A click on a notification, in the bell or on the desktop. */
export async function openNotification(id: number) {
  const f = feed.get();
  // Opening one takes it off the badge (the server marks it seen and read too).
  const was = f?.items.find((i) => i.id === id);
  if (f) feed.set({ unseen: Math.max(0, f.unseen - (was && !was.seen ? 1 : 0)), items: f.items.map((i) => (i.id === id ? { ...i, seen: true, read: true } : i)) });
  try {
    const r = await call<{ path: string; reviewId?: number; tab?: "findings" }>(`/api/notifications/${id}/open`, "POST");
    if (r.reviewId && r.tab) savePos(r.reviewId, { tab: r.tab, idx: 0 });
    go(r.path);
  } catch {
    navigate("/");
  }
}

// ---------- desktop alerts ----------

/** Only one tab raises desktop alerts (the others would show the same thing). */
let leader = false;
/** Which tabs are in front, shared between tabs, for "Stay quiet while PR Bunny is in front". */
const tabId = Math.random().toString(36).slice(2);
const focusedTabs = new Set<string>();
let focusChannel: BroadcastChannel | null = null;

const inFront = () => document.visibilityState === "visible" && document.hasFocus();
function shareFocus() {
  if (inFront()) focusedTabs.add(tabId);
  else focusedTabs.delete(tabId);
  focusChannel?.postMessage({ id: tabId, focused: inFront() });
}

interface Alert {
  title: string;
  body: string;
  tag: string;
  face: string;
  id?: number;
  href?: string;
  /** Buttons on the desktop alert (Chrome, Edge, Arc show them; other browsers just take the click). */
  actions?: Array<{ action: string; title: string }>;
}

/** Changes requested on your PR get Fix / Don't fix right on the desktop alert. */
const actionsFor = (i: AppNotification) => (i.kind === "changesReq" ? [{ action: "fix", title: "Fix" }, { action: "skip", title: "Don't fix" }] : undefined);

let swReg: Promise<ServiceWorkerRegistration | null> = Promise.resolve(null);

async function show(a: Alert): Promise<boolean> {
  if (readPermission() !== "granted") return false;
  const icon = faceFor(a.face) ?? undefined;
  const options: NotificationOptions & { actions?: Alert["actions"] } = { body: a.body, tag: a.tag, icon, data: { id: a.id ?? null, href: a.href ?? null } };
  if (a.actions) options.actions = a.actions;
  try {
    const reg = await Promise.race([swReg, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    if (reg) {
      await reg.showNotification(a.title, options);
      return true;
    }
  } catch {}
  try {
    const n = new Notification(a.title, options);
    n.onclick = () => {
      window.focus();
      n.close();
      if (a.id) openNotification(a.id);
      else if (a.href) go(a.href);
    };
    return true;
  } catch {
    return false;
  }
}

/** The test notification from setup and Settings. Ignores quiet hours; that's the point of it. */
export const sendTest = () =>
  show({ title: "Test from PR Bunny", body: "Notifications work. This is how reviews will reach you.", tag: "test", face: "wink" });

const BURST_MS = 60_000;
let lastShown = 0;
let queue: AppNotification[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  flushTimer = null;
  const items = queue;
  queue = [];
  if (!items.length) return;
  const s = await notifySettings();
  if (!s || !s.desktop || inQuietHours(s) || (s.quietWhileFocused && focusedTabs.size)) return;
  lastShown = Date.now();
  if (items.length === 1) {
    const i = items[0]!;
    await show({ title: i.title, body: i.body, tag: i.tag, face: i.face, id: i.id, actions: actionsFor(i) });
    return;
  }
  await show({ ...bundleText(items), tag: "burst", face: "happy", href: "/" });
}

/** A new event arrived: raise a desktop alert if everything allows it. */
async function deliver(item: AppNotification) {
  if (!leader) return;
  const s = await notifySettings();
  if (!s || !s.desktop || readPermission() !== "granted") return;
  if (inQuietHours(s)) return; // it waits in the bell
  if (s.quietWhileFocused && focusedTabs.size) return;
  const now = Date.now();
  if (!s.bundle || (now - lastShown >= BURST_MS && !flushTimer)) {
    lastShown = now;
    await show({ title: item.title, body: item.body, tag: item.tag, face: item.face, id: item.id, actions: actionsFor(item) });
    return;
  }
  queue.push(item);
  flushTimer ??= setTimeout(flush, Math.max(0, lastShown + BURST_MS - now));
}

// ---------- start ----------

let started = false;
/** Called once by the app shell: loads the feed, keeps it live, and handles notification clicks. */
export function startNotifications() {
  if (started) return;
  started = true;
  loadFeed();

  // The feed socket. Reconnects with backoff, and reloads on reconnect (events may have been missed).
  let delay = 500;
  const connect = () => {
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/notifications`);
    ws.onopen = () => {
      if (delay > 500) loadFeed();
      delay = 500;
    };
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data) as NotificationEvent;
      if (ev.type === "sync") return void loadFeed();
      const f = feed.get() ?? { items: [], unseen: 0 };
      if (f.items.some((i) => i.id === ev.item.id)) return;
      feed.set({ items: [ev.item, ...f.items].slice(0, 50), unseen: f.unseen + 1 });
      deliver(ev.item);
    };
    ws.onclose = () => {
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };
  connect();

  // One tab raises desktop alerts; when it closes, the next one takes over.
  if (navigator.locks) navigator.locks.request("pb:notify-leader", () => ((leader = true), new Promise<never>(() => {}))).catch(() => {});
  else leader = true;

  try {
    focusChannel = new BroadcastChannel("pb:focus");
    focusChannel.onmessage = (e) => {
      const { id, focused } = e.data ?? {};
      if (typeof id !== "string") return;
      if (focused) focusedTabs.add(id);
      else focusedTabs.delete(id);
    };
  } catch {}
  for (const ev of ["focus", "blur", "visibilitychange"]) (ev === "visibilitychange" ? document : window).addEventListener(ev, shareFocus);
  window.addEventListener("pagehide", () => focusChannel?.postMessage({ id: tabId, focused: false }));
  shareFocus();

  // The service worker only handles clicks on desktop alerts.
  if ("serviceWorker" in navigator && window.isSecureContext) {
    swReg = navigator.serviceWorker.register("/sw.js").then(
      () => navigator.serviceWorker.ready,
      () => null,
    );
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type !== "pb:open") return;
      if (e.data.id && e.data.action === "fix") fixNotification(Number(e.data.id)).catch(() => openNotification(Number(e.data.id)));
      else if (e.data.id && e.data.action === "skip") skipNotification(Number(e.data.id)).catch(() => {});
      else if (e.data.id) openNotification(Number(e.data.id));
      else if (typeof e.data.href === "string") go(e.data.href);
    });
  }

  // Opened from a desktop alert after every tab was closed.
  const q = new URLSearchParams(location.search);
  const open = q.get("open");
  if (open && /^\d+$/.test(open)) {
    history.replaceState(null, "", location.pathname);
    const action = q.get("action");
    if (action === "fix") fixNotification(Number(open)).catch(() => openNotification(Number(open)));
    else if (action === "skip") skipNotification(Number(open)).catch(() => {});
    else openNotification(Number(open));
  }
}
