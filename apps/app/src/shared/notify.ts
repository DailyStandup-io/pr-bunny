// Pure notification helpers shared by the web app and tests: quiet hours and burst bundling.
import type { AppNotification, NotificationSettings } from "./types";

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Is it quiet hours right now (local time)? */
export function inQuietHours(s: Pick<NotificationSettings, "quiet" | "quietFrom" | "quietTo" | "quietWeekend">, d = new Date()): boolean {
  if (!s.quiet) return false;
  const day = d.getDay();
  if (s.quietWeekend && (day === 0 || day === 6)) return true;
  const now = d.getHours() * 60 + d.getMinutes();
  const from = minutes(s.quietFrom);
  const to = minutes(s.quietTo);
  if (from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

const refOf = (i: AppNotification) => (i.repo && i.pr ? `${i.repo} #${i.pr}` : i.subject || i.summary);

/** "3 reviews finished" / "acme/web #482 and #479, acme/api #311". */
export function bundleText(items: AppNotification[]): { title: string; body: string } {
  const n = items.length;
  const kinds = new Set(items.map((i) => i.kind));
  const only = kinds.size === 1 ? items[0]!.kind : null;
  const title =
    only === "deep"
      ? `${n} reviews finished`
      : only === "req"
        ? `${n} review requests`
        : only === "failed"
          ? `${n} reviews stopped`
          : only === "myReview"
            ? `${n} reviews of your PRs`
            : `${n} updates from PR Bunny`;
  const byRepo = new Map<string, string[]>();
  for (const i of items) {
    if (i.repo && i.pr) byRepo.set(i.repo, [...(byRepo.get(i.repo) ?? []), `#${i.pr}`]);
    else byRepo.set(refOf(i), []);
  }
  const parts = [...byRepo.entries()].map(([repo, prs]) => {
    const uniq = [...new Set(prs)];
    return uniq.length ? `${repo} ${uniq.length > 1 ? `${uniq.slice(0, -1).join(", ")} and ${uniq.at(-1)}` : uniq[0]}` : repo;
  });
  const body = parts.length > 3 ? `${parts.slice(0, 3).join(", ")} and more` : parts.join(", ");
  return { title, body };
}

