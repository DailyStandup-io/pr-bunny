import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HiddenItem, Inbox, InboxEntry } from "../shared/types";
import { api, navigate, useActivity, useAsync, useLayout, usePath, usePref, useTheme, useUpdate } from "./api";
import { isHiddenPr, useHiddenItems } from "./hidden";
import { Bunny, usePageMood, type MoodReport } from "./components/Bunny";
import { Invaders, useKonami } from "./components/Invaders";
import { appleTouchIcon, icon32 } from "@pr-bunny/brand";
import { ActivityBell } from "./components/ActivityBell";
import { InboxCard } from "./components/InboxCard";
import { startNotifications } from "./notifications";
import { RailTip } from "./components/RailTip";
import { RunCard } from "./components/RunCard";
import { RepoSwitcher } from "./components/RepoSwitcher";
import { Spinner } from "./components/ui";
import { Analytics } from "./pages/Analytics";
import { Home } from "./pages/Home";
import { Review } from "./pages/Review";
import { ReviewHome } from "./pages/ReviewHome";
import { SettingsPage } from "./pages/Settings";
import { SetupPage } from "./pages/Setup";
import { StackPage } from "./pages/Stack";
import { Icon, type IconName } from "@pr-bunny/icons";

/** Inbox icon: a dot while PRs wait on you that you haven't posted a review for, a check when none are assigned. */
function inboxState(inbox: Inbox | undefined, hidden: HiddenItem[]): "default" | "unread" | "caught up" {
  if (!inbox) return "default";
  // PRs you've hidden don't count: they're out of the inbox until they change or you restore them.
  const assigned = inbox.assigned.filter((p) => !isHiddenPr(hidden, p));
  if (assigned.length === 0) return "caught up";
  return assigned.some((p) => p.review?.phase !== "submitted") ? "unread" : "default";
}

// The bunny favicon, when this build has the art (it's licensed and not in the repo).
for (const [rel, href] of [
  ["icon", icon32],
  ["apple-touch-icon", appleTouchIcon],
] as const) {
  if (!href) continue;
  const link = document.createElement("link");
  link.rel = rel;
  link.href = href;
  document.head.appendChild(link);
}

function App() {
  const path = usePath();
  const { theme } = useTheme();
  const [invaders, setInvaders] = useState(false);
  const closeInvaders = useCallback(() => setInvaders(false), []);
  useKonami(() => setInvaders(true), invaders);
  // First launch: nothing is set up yet, so start with the setup page.
  const setup = useAsync(api.setup, []);
  // Set as soon as setup finishes, so "Open Inbox" doesn't bounce back here before the reload lands.
  const [setupDone, setSetupDone] = useState(false);
  const needsSetup = !setupDone && (setup.data ? !setup.data.completedAt : false);
  useEffect(() => {
    if (needsSetup && path !== "/setup") navigate("/setup");
  }, [needsSetup, path]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#1c1b19" : "#f7f6f3");
  }, [theme]);

  return (
    <>
      {path === "/setup" ? <SetupPage
          onDone={() => {
            setSetupDone(true);
            setup.reload();
          }}
        /> : !setup.data && !setup.error ? null : <Shell />}
      {invaders && <Invaders onClose={closeInvaders} />}
    </>
  );
}

function Shell() {
  const path = usePath();
  const layout = useLayout();
  const [pickedRepo, setRepo] = usePref<string | null>("repo", null);
  const inbox = useAsync(api.inbox, []);
  const runs = useActivity();
  // The bell's feed and desktop alerts (see notifications.ts).
  useEffect(() => startNotifications(), []);

  const reviewMatch = path.match(/^\/review\/(\d+)/);
  const reviewId = reviewMatch ? Number(reviewMatch[1]) : null;
  const stackMatch = path.match(/^\/stack\/(\d+)/);
  const stackId = stackMatch ? Number(stackMatch[1]) : null;
  const repo = pickedRepo ?? inbox.data?.lastRepo ?? null;

  // Keep the inbox (and its nav dot) fresh without hammering GitHub.
  useEffect(() => {
    const onFocus = () => inbox.reload();
    window.addEventListener("focus", onFocus);
    const t = setInterval(inbox.reload, 120_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(t);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hidden = useHiddenItems().items;
  const ib = inboxState(inbox.data, hidden);
  // Analytics used to be History; old links still land there.
  const analytics = path === "/analytics" || path === "/history";
  const screen = path.startsWith("/review") || path.startsWith("/stack") ? "review" : analytics ? "analytics" : path === "/settings" ? "settings" : "inbox";
  // Runs you aren't looking at: they spin on the rail's Review button.
  const elsewhere = runs.filter((r) => r.reviewId !== reviewId);
  const nav = [
    { key: "inbox", label: "Inbox", icon: (ib === "unread" ? "inboxUnread" : ib === "caught up" ? "inboxCheck" : "inbox") as IconName, dot: ib === "unread", to: "/" },
    { key: "review", label: "Review", icon: "review" as IconName, dot: false, to: "/review" },
    { key: "analytics", label: "Analytics", icon: "analytics" as IconName, dot: false, to: "/analytics" },
    { key: "settings", label: "Settings", icon: "settings" as IconName, dot: false, to: "/settings" },
  ].map((n) => ({ ...n, on: screen === n.key }));

  const bunny = useAppMood(elsewhere.length ? elsewhere : runs, ib);
  const pickRepo = (r: string) => {
    setRepo(r);
    navigate("/");
  };
  const openPr = async (p: InboxEntry) => {
    setRepo(p.repo);
    if (p.review) return navigate(`/review/${p.review.id}`);
    try {
      const { id } = await api.start(p.url, p.repo);
      navigate(`/review/${id}`);
    } catch {
      navigate("/");
    }
  };
  const pending = (inbox.data?.assigned ?? []).filter((p) => p.review?.phase !== "submitted" && !isHiddenPr(hidden, p));

  return (
    <div className="flex min-h-screen bg-bg text-[14px] leading-normal text-fg">
      {!layout.narrow && (
        <nav className="sticky top-0 z-30 flex h-screen w-[76px] flex-none flex-col items-center gap-1.5 border-r border-line bg-surface pt-3.5 pb-4">
          <RepoSwitcher repo={repo} repos={inbox.data?.repos ?? []} onPick={pickRepo} />
          <ActivityBell />
          {nav.map((n) => {
            const button = (
              <button
                key={n.key}
                aria-label={n.label}
                disabled={!n.to}
                onClick={() => n.to && navigate(n.to)}
                className={`flex h-14 w-[60px] cursor-pointer flex-col items-center justify-center gap-[3px] rounded-[10px] border-0 hover:text-fg disabled:cursor-default disabled:opacity-40 ${
                  n.on ? "bg-accent-soft text-accent" : "bg-transparent text-fg-2"
                }`}
              >
                <NavIcon icon={n.icon} dot={n.dot} busy={n.key === "review" && elsewhere.length > 0} />
                <span className="text-[11px] font-medium">{n.label}</span>
              </button>
            );
            if (n.key === "review")
              return (
                <RunCard key={n.key} runs={elsewhere} label={n.label} onOpen={(r) => navigate(`/review/${r.reviewId}`)}>
                  {button}
                </RunCard>
              );
            return n.key === "inbox" ? (
              <InboxCard key={n.key} pending={pending} repo={repo} onOpenPr={openPr} onOpenInbox={() => navigate("/")}>
                {button}
              </InboxCard>
            ) : (
              <RailTip key={n.key} id={n.key} label={n.label}>
                {button}
              </RailTip>
            );
          })}
          <div className="flex-1" />
          <Bunny report={bunny} />
        </nav>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        {stackId != null ? (
          <StackPage id={stackId} />
        ) : reviewId != null ? (
          <Review id={reviewId} />
        ) : path === "/review" ? (
          <ReviewHome inbox={inbox} repo={repo} onRepo={setRepo} runs={runs} />
        ) : analytics ? (
          <Analytics />
        ) : path === "/settings" ? (
          <SettingsPage />
        ) : (
          <Home inbox={inbox} repo={repo} runs={runs} />
        )}
        {layout.narrow && <div className="h-16 flex-none" />}
      </main>

      {layout.narrow && (
        <nav className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-stretch border-t border-line bg-surface">
          {nav.map((n) => (
            <button
              key={n.key}
              disabled={!n.to}
              onClick={() => n.to && navigate(n.to)}
              className={`flex flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 border-0 bg-transparent disabled:opacity-40 ${n.on ? "text-accent" : "text-fg-2"}`}
            >
              <NavIcon icon={n.icon} dot={n.dot} busy={n.key === "review" && elsewhere.length > 0} />
              <span className="text-[11px] font-medium">{n.label}</span>
            </button>
          ))}
          <ActivityBell compact />
          <Bunny report={bunny} compact />
        </nav>
      )}
    </div>
  );
}

/**
 * The bunny's mood: busy work first (a running review, an update downloading), then whatever the
 * page you're on reports, then an update to install, then an empty inbox.
 */
function useAppMood(runs: ReturnType<typeof useActivity>, ib: ReturnType<typeof inboxState>): MoodReport {
  const update = useUpdate();
  const page = usePageMood();
  if (update?.status === "downloading") return { mood: "working", say: `Downloading ${update.latest?.version ?? "the update"}…`, go: "/settings" };
  if (update?.status === "restarting") return { mood: "working", say: "Restarting…", go: "/settings" };
  const run = runs[0];
  if (run) return { mood: "working", say: run.stage === "recon" ? "Checking out the PR…" : "Reading the diff…", go: `/review/${run.reviewId}` };
  if (page) return page;
  if (update?.status === "available") return { mood: "update", say: `Version ${update.latest?.version} is out. Update from Settings.`, go: "/settings" };
  if (update?.status === "ready") return { mood: "update", say: "Update installed. Restart from Settings to finish.", go: "/settings" };
  if (ib === "caught up") return { mood: "caughtUp", go: "/" };
  return { mood: "idle" };
}

function NavIcon({ icon, dot, busy = false }: { icon: IconName; dot: boolean; busy?: boolean }) {
  return (
    <span className="relative block size-[22px]">
      <Icon name={icon} size={22} className="absolute inset-0" />
      {dot && <span className="absolute top-[1.1px] left-[13.1px] size-[7.8px] rounded-full bg-del" />}
      {busy && (
        <span className="absolute -top-[5px] -right-[6px] grid size-[14px] place-items-center rounded-full bg-surface">
          <Spinner size={10} />
        </span>
      )}
    </span>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
