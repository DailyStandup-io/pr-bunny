// The Activity bell at the top of the rail: recent notifications, whether or not desktop alerts
// are allowed. Opening it clears the badge; clicking an entry goes where its notification would.
import { useEffect, useRef, useState } from "react";
import type { AppNotification, NotificationSettings } from "../../shared/types";
import { Icon } from "@pr-bunny/icons";
import { navigate } from "../api";
import { bell, browserName, notifySettings, openNotification, useFeed, usePermission } from "../notifications";
import { BUNNY_FACES } from "./Bunny";
import { RAIL_GAP } from "./RailTip";
import { Sym } from "./ui";

const ICON: Record<AppNotification["kind"], [string, string]> = {
  req: ["rate_review", "var(--accent)"],
  assign: ["assignment_ind", "var(--accent)"],
  myReview: ["edit_note", "var(--text-2)"],
  stackUpd: ["layers", "var(--text-2)"],
  overview: ["article", "var(--text-2)"],
  deep: ["check_circle", "var(--add)"],
  failed: ["error", "var(--warn)"],
  changed: ["commit", "var(--text-2)"],
  all: ["layers", "var(--text-2)"],
  across: ["account_tree", "var(--text-2)"],
  update: ["upgrade", "var(--text-2)"],
};

const when = (iso: string, now = Date.now()) => {
  const t = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  const m = Math.max(0, Math.floor((now - t.getTime()) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (t >= today) return `${Math.floor(m / 60)}h`;
  if (t.getTime() >= today.getTime() - 86_400_000) return "Yesterday";
  return `${Math.floor(m / 1440)}d`;
};

const isToday = (iso: string) => {
  const t = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return t >= today;
};

export function ActivityBell({ compact = false }: { compact?: boolean }) {
  const feed = useFeed();
  const perm = usePermission();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  /** The badge count when the bell was opened ("3 new"). */
  const [fresh, setFresh] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    notifySettings().then(setSettings);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unseen = feed?.unseen ?? 0;
  const allOff = settings ? Object.values(settings.events).every((v) => !v) : false;
  const items = feed?.items ?? [];
  const toggle = () => {
    if (open) return setOpen(false);
    setFresh(unseen);
    setOpen(true);
    notifySettings(true).then(setSettings);
    if (unseen) bell.seen();
  };
  const goSettings = () => {
    setOpen(false);
    navigate("/settings#notifications");
    setTimeout(() => document.getElementById("notifications")?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
  };
  const badge = unseen > 0 && (
    <span className="absolute -top-[5px] left-3 h-[17px] min-w-[17px] rounded-full border-2 border-surface bg-del px-1 text-center text-[10px] leading-[13px] font-semibold text-white">
      {unseen > 9 ? "9+" : unseen}
    </span>
  );
  const showList = !allOff && items.length > 0;
  const groups = [
    { label: "Today", items: items.filter((i) => isToday(i.createdAt)) },
    { label: "Earlier", items: items.filter((i) => !isToday(i.createdAt)) },
  ].filter((g) => g.items.length);

  const panel = (
    <div role="dialog" aria-label="Activity" className="flex max-h-[min(560px,calc(100vh-100px))] w-[372px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
      <div className="flex flex-none items-center gap-2 pt-3 pr-2 pb-2.5 pl-4">
        <span className="text-[14px] font-semibold">Activity</span>
        {fresh > 0 && showList && <span className="text-[12.5px] text-fg-3">{fresh} new</span>}
        <span className="flex-1" />
        {showList && items.some((i) => !i.read) && (
          <button onClick={() => bell.readAll()} className="h-[30px] cursor-pointer rounded-[7px] border-0 bg-transparent px-2 text-[12.5px] text-fg-2 hover:bg-hover">
            Mark all read
          </button>
        )}
        <button
          onClick={goSettings}
          aria-label="Notification settings"
          title="Notification settings"
          className="grid size-[30px] cursor-pointer place-items-center rounded-[7px] border-0 bg-transparent text-fg-3 hover:bg-hover hover:text-fg"
        >
          <Icon name="settings" size={17} />
        </button>
      </div>
      {perm === "denied" && settings?.desktop && !allOff && (
        <div className="mx-2.5 mb-2 flex flex-none items-start gap-[9px] rounded-lg bg-warn-soft px-3 py-2.5">
          <span className="flex flex-none text-warn">
            <Sym name="notifications_off" size={17} fill />
          </span>
          <p className="m-0 text-[12.5px] leading-[1.45]">
            Desktop alerts are blocked in {browserName()}, so they only show here.{" "}
            <button onClick={goSettings} className="cursor-pointer border-0 bg-transparent p-0 text-[12.5px] font-medium text-accent hover:underline">
              How to allow
            </button>
          </p>
        </div>
      )}
      {showList && (
        <div className="min-h-0 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="px-4 pt-1.5 pb-1 text-[12px] font-semibold text-fg-3">{g.label}</div>
              <ul className="m-0 flex list-none flex-col gap-px px-1.5 pt-0 pb-1.5">
                {g.items.map((i) => {
                  const [icon, color] = i.kind === "myReview" && i.face === "hearts" ? ["thumb_up", "var(--add)"] : ICON[i.kind];
                  return (
                    <li key={i.id}>
                      <button
                        onClick={() => {
                          setOpen(false);
                          openNotification(i.id);
                        }}
                        className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-2 text-left hover:bg-hover"
                      >
                        <span className="grid size-[30px] flex-none place-items-center rounded-lg border border-line bg-sunken" style={{ color }}>
                          <Sym name={icon} size={17} fill />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-px">
                          <span className={`truncate text-[13.5px] ${i.read ? "font-medium text-fg-2" : "font-semibold text-fg"}`}>{i.summary}</span>
                          {i.subject && <span className="truncate text-[12.5px] text-fg-2">{i.subject}</span>}
                          <span className="font-mono text-[11.5px] text-fg-3">{[i.repo && i.pr ? `${i.repo} #${i.pr}` : i.repo, when(i.createdAt)].filter(Boolean).join(" · ")}</span>
                        </span>
                        <span className={`mt-1.5 size-2 flex-none rounded-full ${i.read ? "bg-transparent" : "bg-accent"}`} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      {!allOff && !items.length && (
        <div className="flex flex-col items-center gap-1.5 px-6 pt-7 pb-8 text-center">
          {BUNNY_FACES.happy && <img src={BUNNY_FACES.happy} alt="" className="size-12 [image-rendering:pixelated]" />}
          <p className="mt-1.5 mb-0 text-[14.5px] font-medium">Nothing yet</p>
          <p className="m-0 max-w-[260px] text-[13px] text-pretty text-fg-3">Review requests, finished reviews and stack updates show up here.</p>
        </div>
      )}
      {allOff && (
        <div className="flex flex-col items-center gap-1.5 px-6 py-7 text-center">
          {BUNNY_FACES.wobbly && <img src={BUNNY_FACES.wobbly} alt="" className="size-12 [image-rendering:pixelated]" />}
          <p className="mt-1.5 mb-0 text-[14.5px] font-medium">Notifications are off</p>
          <p className="m-0 max-w-[270px] text-[13px] text-pretty text-fg-3">Every event is turned off, so nothing lands here or on your desktop.</p>
          <button onClick={goSettings} className="mt-2.5 h-9 cursor-pointer rounded-lg border border-line-strong bg-surface px-3.5 text-[13px] whitespace-nowrap hover:bg-hover">
            Choose events
          </button>
        </div>
      )}
      {showList && (
        <button
          onClick={() => {
            setOpen(false);
            navigate("/");
          }}
          className="flex h-10 w-full flex-none cursor-pointer items-center justify-center gap-1 border-0 border-t border-line bg-sunken text-[13px] font-medium text-accent hover:bg-hover"
        >
          Open Inbox
          <Sym name="arrow_forward" size={16} />
        </button>
      )}
    </div>
  );

  const icon = (
    <span className="relative block size-[22px]">
      <Icon name={allOff ? "bellOff" : "bell"} size={22} className="absolute inset-0" />
      {badge}
    </span>
  );

  if (compact) {
    return (
      <div ref={wrap} className="flex flex-1">
        <button
          onClick={toggle}
          aria-label={unseen ? `Activity, ${unseen} new` : "Activity"}
          aria-expanded={open}
          className={`flex flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 border-0 bg-transparent ${open ? "text-accent" : "text-fg-2"}`}
        >
          {icon}
          <span className="text-[11px] font-medium">Activity</span>
        </button>
        {open && <div className="fixed inset-x-3 bottom-[72px] z-45 flex justify-center">{panel}</div>}
      </div>
    );
  }

  return (
    <div ref={wrap} className="relative">
      <button
        onClick={toggle}
        aria-label={unseen ? `Activity, ${unseen} new` : "Activity"}
        aria-expanded={open}
        className={`flex h-14 w-[60px] cursor-pointer flex-col items-center justify-center gap-[3px] rounded-[10px] border-0 hover:text-fg ${open ? "bg-accent-soft text-accent" : "bg-transparent text-fg-2"}`}
      >
        {icon}
        <span className="text-[11px] font-medium">Activity</span>
      </button>
      {open && (
        <div className="absolute top-[3px] left-full z-45" style={{ paddingLeft: RAIL_GAP }}>
          {panel}
        </div>
      )}
    </div>
  );
}
