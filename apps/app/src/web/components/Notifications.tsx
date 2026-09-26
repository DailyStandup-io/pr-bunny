// Notification controls: the permission panel, the setup step, Settings › Notifications, and the
// summary row. Desktop alerts come from this browser; every event also lands in the bell.
import { useEffect, useState } from "react";
import type { NotificationSettings, NotifyKind } from "../../shared/types";
import {
  askPermission,
  browserName,
  DEFAULT_EVENTS,
  EVENT_GROUPS,
  EVENT_LABEL,
  recheckPermission,
  sendTest,
  SETUP_EVENTS,
  unblockSteps,
  usePermission,
  type Permission,
} from "../notifications";
import { api, useAsync } from "../api";
import { Spinner, Sym } from "./ui";

/** What the panel shows: the browser's permission, or "off" when allowed but switched off. */
type Shown = "notasked" | "asking" | "allowed" | "blocked" | "unsupported" | "off";

const shown = (p: Permission, desktop = true): Shown =>
  p === "granted" ? (desktop ? "allowed" : "off") : p === "denied" ? "blocked" : p === "default" ? "notasked" : p;

function look(s: Shown, browser: string, host: string) {
  return {
    notasked: { tile: "notifications", tileColor: "var(--text-2)", tileBg: "var(--sunken)", icon: "radio_button_unchecked", color: "var(--text-3)", text: "Not turned on yet", sub: "Your browser asks once. You can change it later in Settings." },
    asking: { tile: "notifications", tileColor: "var(--accent)", tileBg: "var(--accent-soft)", icon: "", color: "var(--accent)", text: "Waiting for your answer", sub: "Look for the prompt near the address bar and choose Allow." },
    allowed: { tile: "notifications_active", tileColor: "var(--add)", tileBg: "var(--add-soft)", icon: "check_circle", color: "var(--add)", text: `Allowed in ${browser}`, sub: "Reaches you even when this tab is in the background." },
    blocked: { tile: "notifications_off", tileColor: "var(--warn)", tileBg: "var(--warn-soft)", icon: "error", color: "var(--warn)", text: `Blocked in ${browser}`, sub: `Turned off for ${host}. You can undo it in two places.` },
    unsupported: { tile: "notifications_off", tileColor: "var(--text-3)", tileBg: "var(--sunken)", icon: "do_not_disturb_on", color: "var(--text-3)", text: "Not supported in this browser", sub: `Open ${host} in Chrome, Arc, Firefox or Safari to turn them on.` },
    off: { tile: "notifications_off", tileColor: "var(--text-3)", tileBg: "var(--sunken)", icon: "do_not_disturb_on", color: "var(--text-3)", text: "Desktop notifications are off", sub: "Events still collect in the bell." },
  }[s];
}

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[26px] w-11 flex-none rounded-full border-0 enabled:cursor-pointer disabled:opacity-40 ${checked ? "bg-accent" : "bg-line-strong"}`}
    >
      <span className="absolute top-[3px] size-5 rounded-full bg-surface shadow-seg transition-[left]" style={{ left: checked ? 21 : 3 }} />
    </button>
  );
}

function Steps({ steps, pad, footer }: { steps: string[]; pad: string; footer?: string }) {
  return (
    <div className="flex flex-col gap-3 pr-[22px] pb-[18px]" style={{ paddingLeft: pad }}>
      {steps.map((text, i) => (
        <div key={i} className="flex items-start gap-2.5">
          <span className="mt-px grid size-5 flex-none place-items-center rounded-full border border-line bg-sunken text-[11px] font-semibold text-fg-2">{i + 1}</span>
          <p className="m-0 text-[13.5px] text-pretty">{text}</p>
        </div>
      ))}
      {footer && <p className="m-0 text-[13px] text-fg-3">{footer}</p>}
    </div>
  );
}

/** The tile, status and buttons. `big` is the setup step's version. */
function Status({ s, big, children }: { s: ReturnType<typeof look>; big: boolean; children?: React.ReactNode }) {
  return (
    <div className={`flex flex-wrap items-start gap-x-3.5 gap-y-3 px-[22px] ${big ? "py-[18px]" : "py-4"}`}>
      <span className="grid size-9 flex-none place-items-center rounded-[9px]" style={{ background: s.tileBg, color: s.tileColor }}>
        <Sym name={s.tile} size={20} />
      </span>
      <div className={`flex min-w-0 flex-[1_1_220px] flex-col ${big ? "gap-[3px]" : "gap-0.5"}`}>
        {big && <span className="text-[14.5px] font-medium">Desktop notifications</span>}
        <span className={`flex items-center gap-1.5 ${big ? "text-[13px]" : "text-[14px] font-medium"}`} style={{ color: s.color }}>
          {s.icon ? <Sym name={s.icon} size={big ? 16 : 17} fill /> : <Spinner size={14} />}
          {s.text}
        </span>
        <span className="text-[13px] text-pretty text-fg-3">{s.sub}</span>
      </div>
      {children}
    </div>
  );
}

const secondaryBtn = (big: boolean) =>
  `flex flex-none cursor-pointer items-center gap-[7px] rounded-lg border whitespace-nowrap ${
    big ? "h-10 border-line-strong bg-surface pr-3.5 pl-3 text-[13.5px] hover:bg-hover" : "h-9 border-line bg-transparent pr-3 pl-2.5 text-[13px] text-fg-2 hover:bg-hover hover:text-fg"
  }`;

// ---------- setup step ----------

export function NotificationsStep({ events, onEvent }: { events: Record<NotifyKind, boolean>; onEvent: (k: NotifyKind, on: boolean) => void }) {
  const perm = usePermission();
  const browser = browserName();
  const [sent, setSent] = useState(false);
  const s = shown(perm);
  const l = look(s, browser, location.hostname);
  const foot =
    s === "allowed"
      ? "The events below go to your desktop and the bell in PR Bunny."
      : s === "blocked" || s === "unsupported"
        ? "The events below still show in the bell in PR Bunny, just not on your desktop."
        : "The events below show in the bell in PR Bunny, and on your desktop once allowed.";
  return (
    <>
      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <Status s={l} big>
          {(s === "notasked" || s === "asking") && (
            <button
              onClick={() => askPermission()}
              disabled={s === "asking"}
              className="flex h-10 flex-none cursor-pointer items-center gap-2 rounded-lg border-0 bg-accent px-4 text-[13.5px] font-semibold whitespace-nowrap text-on-accent disabled:cursor-default"
            >
              {s === "asking" && <Spinner size={14} light />}
              {s === "asking" ? "Waiting for you…" : "Turn on notifications"}
            </button>
          )}
          {s === "allowed" && (
            <button onClick={() => sendTest().then((ok) => setSent(ok))} className={secondaryBtn(true)}>
              <span className="text-fg-2">
                <Sym name="send" />
              </span>
              {sent ? "Send another" : "Send a test notification"}
            </button>
          )}
          {s === "blocked" && (
            <button onClick={recheckPermission} className={secondaryBtn(true)}>
              <span className="text-fg-2">
                <Sym name="refresh" />
              </span>
              Check again
            </button>
          )}
        </Status>
        {s === "allowed" && sent && (
          <div className="mx-[22px] mb-[18px] flex items-start gap-2.5 rounded-lg bg-add-soft px-3.5 py-3">
            <span className="flex-none text-add">
              <Sym name="check_circle" fill />
            </span>
            <div>
              <p className="m-0 text-[13.5px] font-medium">Sent. Look in the top-right corner of your screen.</p>
              <p className="mt-0.5 mb-0 text-[13px] text-fg-2">Nothing there? Focus or Do Not Disturb may be on. Check Control Center.</p>
            </div>
          </div>
        )}
        {s === "blocked" && <Steps steps={unblockSteps(browser)} pad="72px" footer="When that's done, press Check again." />}
        <div className="flex items-start gap-2.5 border-t border-line bg-sunken px-[22px] py-3">
          <span className="flex-none text-fg-3">
            <Sym name="notifications" size={17} />
          </span>
          <p className="m-0 text-[13px] text-pretty text-fg-2">{foot}</p>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-3 px-[22px] pt-4 pb-2">
          <h2 className="m-0 text-[15px] font-semibold">Notify me when</h2>
          <span className="text-[13px] text-fg-3">More events and quiet hours in Settings</span>
        </div>
        <div className="pb-2">
          {SETUP_EVENTS.map((k) => (
            <div key={k} className="flex items-center gap-4 px-[22px] py-[9px]">
              <span className="min-w-0 flex-1 text-[14px]">{EVENT_LABEL[k].label}</span>
              <Toggle checked={events[k]} onChange={(v) => onEvent(k, v)} label={EVENT_LABEL[k].label} />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/** The Notifications row on the setup summary, for every outcome. */
export function notificationsSummary(perm: Permission, skipped: boolean, events: Record<NotifyKind, boolean>): { value: string; sub: string; state: "ok" | "neutral" | "warn" } {
  const browser = browserName();
  const n = Object.values(events).filter(Boolean).length;
  const count = `${n} ${n === 1 ? "event" : "events"}`;
  if (skipped) return { value: "Not set up", sub: "Defaults apply to the bell. Change in Settings.", state: "neutral" };
  if (!n) return { value: "Every event is off", sub: "Nothing will notify you", state: "warn" };
  if (perm === "granted") return { value: `On in ${browser} · ${count}`, sub: "Desktop and bell", state: "ok" };
  if (perm === "denied") return { value: `Blocked in ${browser} · bell only`, sub: "Allow in browser settings for desktop alerts", state: "warn" };
  if (perm === "unsupported") return { value: `Bell only · ${count}`, sub: "This browser can't show desktop notifications", state: "neutral" };
  return { value: `Bell only · ${count}`, sub: "Desktop alerts not turned on", state: "neutral" };
}

// ---------- Settings › Notifications ----------

export function NotificationsSection({ value, onChange }: { value: NotificationSettings; onChange: (patch: Partial<NotificationSettings>) => void }) {
  const perm = usePermission();
  // The repos in the switcher are offered as chips for "Chosen repos".
  const inbox = useAsync(api.inbox, []);
  const repoOptions = inbox.data?.repos.map((r) => r.name) ?? [];
  // Links from the bell and desktop alerts land on #notifications or #about.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: "start" }), 50);
  }, []);
  const browser = browserName();
  const [sent, setSent] = useState(false);
  const s = shown(perm, value.desktop);
  const l = look(s, browser, location.hostname);
  const canMaster = perm === "granted";
  const desktop = s === "allowed";
  const allOff = Object.values(value.events).every((v) => !v);
  const repos = [...new Set([...repoOptions, ...value.repos])].sort((a, b) => a.localeCompare(b));
  const setEvent = (k: NotifyKind, on: boolean) => onChange({ events: { ...value.events, [k]: on } });
  const toggleRepo = (r: string) => onChange({ repos: value.repos.includes(r) ? value.repos.filter((x) => x !== r) : [...value.repos, r] });

  return (
    <section id="notifications" className="scroll-mt-6 overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-start gap-4 border-b border-line px-[22px] py-[18px]">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[15px] font-semibold">Notifications</h2>
          <p className="mt-[3px] mb-0 text-[13px] text-fg-3">Desktop alerts from this browser. Everything also lands in the bell.</p>
        </div>
        <span className="mt-0.5 flex">
          <Toggle checked={canMaster && value.desktop} disabled={!canMaster} onChange={(v) => onChange({ desktop: v })} label="Desktop notifications" />
        </span>
      </div>

      <Status s={l} big={false}>
        {s === "notasked" && (
          <button
            onClick={() => askPermission().then((p) => p === "granted" && !value.desktop && onChange({ desktop: true }))}
            className="h-9 flex-none cursor-pointer rounded-lg border-0 bg-accent px-3.5 text-[13px] font-semibold whitespace-nowrap text-on-accent"
          >
            Turn on notifications
          </button>
        )}
        {s === "asking" && (
          <button disabled className="flex h-9 flex-none items-center gap-2 rounded-lg border-0 bg-accent px-3.5 text-[13px] font-semibold whitespace-nowrap text-on-accent">
            <Spinner size={14} light />
            Waiting for you…
          </button>
        )}
        {s === "allowed" && (
          <button onClick={() => sendTest().then((ok) => setSent(ok))} className={secondaryBtn(false)}>
            <Sym name={sent ? "check" : "send"} size={17} />
            {sent ? "Sent" : "Send test"}
          </button>
        )}
        {s === "blocked" && (
          <button onClick={recheckPermission} className={secondaryBtn(false)}>
            <Sym name="refresh" size={17} />
            Check again
          </button>
        )}
      </Status>
      {s === "blocked" && <Steps steps={unblockSteps(browser)} pad="72px" />}
      {allOff && (
        <div className="mx-[22px] mb-4 flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-lg bg-warn-soft px-3.5 py-3">
          <span className="flex flex-none text-warn">
            <Sym name="warning" fill />
          </span>
          <p className="m-0 flex-[1_1_300px] text-[13.5px]">Every event is off. Nothing will reach your desktop or the bell.</p>
          <button onClick={() => onChange({ events: { ...DEFAULT_EVENTS } })} className="h-8 flex-none cursor-pointer rounded-[7px] border border-line-strong bg-surface px-3 text-[13px] hover:bg-hover">
            Turn on the defaults
          </button>
        </div>
      )}

      {EVENT_GROUPS.map((g) => (
        <div key={g.name}>
          <div className="border-t border-line px-[22px] pt-3.5 pb-1">
            <h3 className="m-0 text-[13px] font-semibold text-fg-3">{g.name}</h3>
          </div>
          <div className="pb-1.5">
            {g.items.map((r) => (
              <div key={r.key} className="flex items-center gap-4 px-[22px] py-2">
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-[14px]">{r.label}</p>
                  {r.hint && <p className="mt-px mb-0 text-[12.5px] text-fg-3">{r.hint}</p>}
                </div>
                <Toggle checked={value.events[r.key]} onChange={(v) => setEvent(r.key, v)} label={r.label} />
              </div>
            ))}
            {g.github && (
              <div className="mx-[22px] mt-1.5 mb-2 flex flex-col gap-2.5 rounded-[10px] bg-sunken px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
                  <div className="min-w-0 flex-[1_1_220px]">
                    <p className="m-0 text-[13.5px] font-medium">From</p>
                    <p className="mt-px mb-0 text-[12.5px] text-fg-3">Applies to the GitHub events above.</p>
                  </div>
                  <div role="radiogroup" aria-label="Repositories" className="flex flex-none gap-0.5 rounded-[10px] border border-line bg-bg p-[3px]">
                    {(
                      [
                        ["all", "All repos"],
                        ["chosen", "Chosen repos"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        role="radio"
                        aria-checked={value.repoMode === key}
                        onClick={() => onChange({ repoMode: key })}
                        className={`h-8 cursor-pointer rounded-[7px] border-0 px-3 text-[13px] font-medium hover:text-fg ${value.repoMode === key ? "bg-surface text-fg shadow-seg" : "bg-transparent text-fg-2"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {value.repoMode === "chosen" && (
                  <div className="flex flex-wrap gap-1.5">
                    {repos.length === 0 && <p className="m-0 text-[12.5px] text-fg-3">No repositories yet. Add some in setup, or review a PR first.</p>}
                    {repos.map((r) => {
                      const on = value.repos.includes(r);
                      return (
                        <button
                          key={r}
                          onClick={() => toggleRepo(r)}
                          aria-pressed={on}
                          className={`flex h-8 cursor-pointer items-center gap-[5px] rounded-lg border pr-2.5 pl-2 font-mono text-[12.5px] ${
                            on ? "border-transparent bg-accent-soft text-accent" : "border-line-strong bg-surface text-fg-2 hover:text-fg"
                          }`}
                        >
                          <Sym name={on ? "check" : "add"} size={16} />
                          {r}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ))}

      <div className="flex items-baseline gap-2 border-t border-line px-[22px] pt-3.5 pb-1">
        <h3 className="m-0 text-[13px] font-semibold text-fg-3">Delivery</h3>
        {!desktop && <span className="text-[12.5px] text-fg-3">· Desktop only</span>}
      </div>
      <div className="pb-2.5 transition-opacity" style={{ opacity: desktop ? 1 : 0.45 }}>
        <div className="flex items-center gap-4 px-[22px] py-2">
          <div className="min-w-0 flex-1">
            <p className="m-0 text-[14px]">Quiet hours</p>
            <p className="mt-px mb-0 text-[12.5px] text-fg-3">Hold desktop alerts. They wait in the bell.</p>
          </div>
          <Toggle checked={value.quiet} onChange={(v) => onChange({ quiet: v })} label="Quiet hours" />
        </div>
        {value.quiet && (
          <div className="flex flex-wrap items-center gap-2 px-[22px] pt-0.5 pb-2">
            <span className="text-[13px] text-fg-3">From</span>
            <input
              type="time"
              value={value.quietFrom}
              onChange={(e) => e.target.value && onChange({ quietFrom: e.target.value })}
              aria-label="Quiet from"
              className="focus-ring h-9 rounded-lg border border-line-strong bg-bg px-2 font-mono text-[13px] text-fg outline-none"
            />
            <span className="text-[13px] text-fg-3">to</span>
            <input
              type="time"
              value={value.quietTo}
              onChange={(e) => e.target.value && onChange({ quietTo: e.target.value })}
              aria-label="Quiet until"
              className="focus-ring h-9 rounded-lg border border-line-strong bg-bg px-2 font-mono text-[13px] text-fg outline-none"
            />
            <button
              onClick={() => onChange({ quietWeekend: !value.quietWeekend })}
              aria-pressed={value.quietWeekend}
              className={`flex h-9 cursor-pointer items-center gap-[5px] rounded-lg border pr-2.5 pl-2 text-[13px] ${
                value.quietWeekend ? "border-transparent bg-accent-soft text-accent" : "border-line-strong bg-surface text-fg-2 hover:text-fg"
              }`}
            >
              <Sym name={value.quietWeekend ? "check" : "add"} size={16} />
              All weekend
            </button>
          </div>
        )}
        <div className="flex items-center gap-4 px-[22px] py-2">
          <div className="min-w-0 flex-1">
            <p className="m-0 text-[14px]">Stay quiet while PR Bunny is in front</p>
            <p className="mt-px mb-0 text-[12.5px] text-fg-3">If you're already looking at it, the bell is enough.</p>
          </div>
          <Toggle checked={value.quietWhileFocused} onChange={(v) => onChange({ quietWhileFocused: v })} label="Stay quiet while in front" />
        </div>
        <div className="flex items-center gap-4 px-[22px] py-2">
          <div className="min-w-0 flex-1">
            <p className="m-0 text-[14px]">Bundle bursts</p>
            <p className="mt-px mb-0 text-[12.5px] text-fg-3">Events within a minute arrive as one, like “3 reviews finished”.</p>
          </div>
          <Toggle checked={value.bundle} onChange={(v) => onChange({ bundle: v })} label="Bundle bursts" />
        </div>
      </div>
    </section>
  );
}
