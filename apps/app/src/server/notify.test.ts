import { beforeEach, describe, expect, test } from "bun:test";
import type { AppNotification } from "../shared/types";
import { bundleText, inQuietHours } from "../shared/notify";
import { db } from "./db/db";
import { feed, markAllRead, markSeen, onPhase, record, type NewNotification } from "./notify";
import { resetSettings, updateSettings } from "./settings";

const base: NewNotification = {
  kind: "deep",
  title: "Deep review ready · #1",
  body: "No findings.",
  summary: "Deep review finished",
  repo: "acme/web",
  pr: 1,
  href: "/review/1",
  tag: "pr:acme/web#1",
  face: "shades",
  key: "k1",
};

beforeEach(() => {
  resetSettings();
  db.run("DELETE FROM notifications");
});

describe("notification settings", () => {
  test("defaults, partial updates and validation", () => {
    const s = resetSettings().notifications;
    expect(s.events.req).toBe(true);
    expect(s.events.overview).toBe(false);
    const next = updateSettings({ notifications: { events: { overview: true } } as any }).notifications;
    expect(next.events.overview).toBe(true);
    expect(next.events.req).toBe(true); // untouched events keep their value
    expect(() => updateSettings({ notifications: { events: { nope: true } } as any })).toThrow(/Unknown notification event/);
    expect(() => updateSettings({ notifications: { quietFrom: "25:00" } as any })).toThrow(/Quiet hours/);
    expect(() => updateSettings({ notifications: { repos: ["not a repo"] } as any })).toThrow(/owner\/name/);
    expect(() => updateSettings({ notifications: { repoMode: "some" } as any })).toThrow(/all or chosen/);
  });
});

describe("record", () => {
  test("records once per key, and only events that are on", () => {
    expect(record(base)).not.toBeNull();
    expect(record(base)).toBeNull(); // same key
    updateSettings({ notifications: { events: { deep: false } } as any });
    expect(record({ ...base, key: "k2" })).toBeNull();
    expect(feed().items).toHaveLength(1);
    expect(feed().unseen).toBe(1);
  });

  test("the repo filter applies to GitHub events only", () => {
    updateSettings({ notifications: { repoMode: "chosen", repos: ["acme/api"] } as any });
    expect(record({ ...base, kind: "req", key: "r1" })).toBeNull();
    expect(record({ ...base, kind: "req", repo: "ACME/api", key: "r2" })).not.toBeNull();
    expect(record({ ...base, key: "d1" })).not.toBeNull(); // a finished review isn't filtered
  });

  test("seen clears the badge; read marks entries read", () => {
    record(base);
    markSeen();
    expect(feed().unseen).toBe(0);
    expect(feed().items[0]!.read).toBe(false);
    markAllRead();
    expect(feed().items[0]!.read).toBe(true);
  });
});

describe("review phases", () => {
  test("a finished deep review notifies once, with its findings", () => {
    db.run("INSERT INTO repos (owner, name) VALUES ('acme', 'notify') ON CONFLICT DO NOTHING");
    const { id: repoId } = db.query("SELECT id FROM repos WHERE owner = 'acme' AND name = 'notify'").get() as { id: number };
    const { id } = db
      .query(
        `INSERT INTO reviews (repo_id, pr_number, title, author, url, head_sha, head_ref, base_ref, phase)
         VALUES (?, 42, 'Add Apple Pay', 'dana', 'https://github.com/acme/notify/pull/42', 'abc', 'pay', 'main', 'walkthrough') RETURNING id`,
      )
      .get(repoId) as { id: number };
    for (const [i, sev] of ["high", "low", "medium"].entries())
      db.run("INSERT INTO findings (review_id, position, severity, title, why, comment) VALUES (?, ?, ?, 't', 'w', 'c')", [id, i, sev]);
    onPhase(id, "walkthrough");
    onPhase(id, "walkthrough"); // repeated phase event
    const items = feed().items.filter((i) => i.kind === "deep");
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Deep review ready · #42");
    expect(items[0]!.body).toBe("3 findings, 1 high. Add Apple Pay.");
    expect(items[0]!.face).toBe("surprised");
    expect(items[0]!.tag).toBe("pr:acme/notify#42");
    // The overview is off by default.
    onPhase(id, "recon_ready");
    expect(feed().items.some((i) => i.kind === "overview")).toBe(false);
  });
});

describe("quiet hours", () => {
  const at = (day: number, h: number, m = 0) => new Date(2026, 8, 20 + day, h, m); // 2026-09-20 is a Sunday
  const q = { quiet: true, quietFrom: "19:00", quietTo: "09:00", quietWeekend: false };
  test("overnight windows", () => {
    expect(inQuietHours(q, at(1, 20))).toBe(true);
    expect(inQuietHours(q, at(1, 8, 59))).toBe(true);
    expect(inQuietHours(q, at(1, 9))).toBe(false);
    expect(inQuietHours(q, at(1, 12))).toBe(false);
  });
  test("same-day windows, off, and weekends", () => {
    expect(inQuietHours({ ...q, quietFrom: "12:00", quietTo: "13:00" }, at(1, 12, 30))).toBe(true);
    expect(inQuietHours({ ...q, quiet: false }, at(1, 20))).toBe(false);
    expect(inQuietHours({ ...q, quietWeekend: true }, at(0, 12))).toBe(true);
    expect(inQuietHours({ ...q, quietWeekend: true }, at(1, 12))).toBe(false);
  });
});

describe("bundleText", () => {
  const n = (kind: AppNotification["kind"], repo: string, pr: number) => ({ kind, repo, pr, subject: "", summary: "" }) as AppNotification;
  test("groups PRs by repo", () => {
    expect(bundleText([n("deep", "acme/web", 482), n("deep", "acme/web", 479), n("deep", "acme/api", 311)])).toEqual({
      title: "3 reviews finished",
      body: "acme/web #482 and #479, acme/api #311",
    });
    expect(bundleText([n("deep", "acme/web", 1), n("req", "acme/web", 2)]).title).toBe("2 updates from PR Bunny");
  });
});
