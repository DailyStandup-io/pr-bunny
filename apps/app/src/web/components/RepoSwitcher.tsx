import { useEffect, useState } from "react";
import type { RepoOption } from "../../shared/types";
import { railTipClass, useRailPopover } from "./RailTip";
import { avatarUrl as userAvatar } from "../avatar";
import { field, Sym, timeAgo } from "./ui";

const owner = (repo: string) => repo.split("/")[0] ?? repo;
const avatarUrl = (repo: string) => userAvatar(owner(repo), 64);

/** Org avatar with the owner's initial underneath, which shows until (or if) the image loads. */
export function RepoAvatar({ repo, size, className }: { repo: string | null; size: number; className: string }) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    setOk(false);
    if (!repo) return;
    const img = new Image();
    img.onload = () => setOk(true);
    img.src = avatarUrl(repo);
  }, [repo && owner(repo)]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className={`relative grid flex-none place-items-center overflow-hidden font-mono ${className}`} style={{ width: size, height: size }}>
      {repo ? owner(repo)[0]!.toUpperCase() : <Sym name="folder" size={size * 0.55} />}
      {ok && repo && <span className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${avatarUrl(repo)})` }} />}
    </span>
  );
}

export const activityLabel = (a: RepoOption["activity"]) =>
  a.kind === "reviewed" ? `You reviewed ${timeAgo(a.at)}` : a.kind === "added" ? `Added ${timeAgo(a.at)}` : `Review requested ${timeAgo(a.at)}`;

/** The rail button for the selected repo, and the "find a repository" popover it opens. */
export function RepoSwitcher({
  repo,
  repos,
  onPick,
  placement = "rail",
}: {
  repo: string | null;
  repos: RepoOption[];
  onPick: (repo: string) => void;
  placement?: "rail" | "inline";
}) {
  const [open, setOpen] = useState(false);
  const tip = useRailPopover("repo");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const q = query.trim().toLowerCase();
  const options = repos.filter((r) => !q || r.name.toLowerCase().includes(q));
  const label = repo ?? "Choose a repository";

  const menu = open && (
    <>
      <div onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
      <div
        className={`absolute z-41 flex w-[320px] max-w-[calc(100vw-24px)] flex-col rounded-xl border border-line bg-surface shadow-pop ${
          placement === "rail" ? "top-3 left-20 max-h-[calc(100vh-24px)]" : "top-[calc(100%+6px)] left-0 max-h-[70vh]"
        }`}
      >
        <div className="px-3 pt-3 pb-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a repository"
            className={`h-[38px] w-full px-3 text-[13.5px] ${field}`}
          />
        </div>
        <div className="px-3.5 pt-1 pb-1.5 text-[12px] font-semibold text-fg-3">Your recent activity</div>
        <ul className="m-0 flex list-none flex-col gap-0.5 overflow-y-auto px-1.5 pt-0 pb-1.5">
          {options.map((r) => {
            const on = r.name === repo;
            return (
              <li key={r.name}>
                <button
                  onClick={() => {
                    onPick(r.name);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={`flex min-h-[52px] w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 px-2.5 py-2 text-left hover:bg-hover ${on ? "bg-accent-soft" : "bg-transparent"}`}
                >
                  <RepoAvatar repo={r.name} size={28} className="rounded-[7px] border border-line bg-sunken text-[12.5px] text-fg-2" />
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="truncate font-mono text-[13px]">{r.name}</span>
                    <span className="text-[12px] text-fg-3">
                      {r.openCount != null && `${r.openCount} open · `}
                      {activityLabel(r.activity)}
                    </span>
                  </span>
                  {on && <Sym name="check" className="text-accent" />}
                </button>
              </li>
            );
          })}
          {options.length === 0 && (
            <li className="px-2.5 pt-2.5 pb-3 text-[13px] text-fg-3">
              {repos.length ? "No repositories match." : "No repositories yet."} Paste a PR URL in the Inbox to open one from anywhere.
            </li>
          )}
        </ul>
      </div>
    </>
  );

  if (placement === "inline") {
    return (
      <div className="relative self-start">
        <button
          onClick={() => {
            setOpen(!open);
            setQuery("");
          }}
          className={`flex h-10 cursor-pointer items-center gap-2 rounded-[10px] border py-1 pr-2 pl-1.5 hover:bg-hover ${open ? "border-line-strong bg-hover" : "border-line bg-transparent"}`}
        >
          <RepoAvatar repo={repo} size={28} className="rounded-[7px] bg-accent-soft text-[13px] font-medium text-accent" />
          <span className="max-w-[60vw] truncate font-mono text-[13px]">{label}</span>
          <Sym name="expand_more" className="text-fg-3" />
        </button>
        {menu}
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => {
          setOpen(!open);
          setQuery("");
          tip.hide();
        }}
        onMouseEnter={tip.show}
        onMouseLeave={() => tip.hide()}
        onFocus={tip.show}
        onBlur={() => tip.hide()}
        aria-label={label}
        className={`relative mb-2 flex h-14 w-[60px] cursor-pointer flex-col items-center justify-center gap-[3px] rounded-[10px] border p-0 hover:bg-hover ${
          open ? "border-line-strong bg-hover" : "border-line bg-transparent"
        }`}
      >
        <RepoAvatar repo={repo} size={26} className="rounded-[7px] bg-accent-soft text-[14px] font-medium text-accent" />
        <Sym name="code" size={16} className="text-fg-3" />
        {tip.open && !open && (
          <span role="tooltip" className={`${railTipClass} font-mono`}>
            {label}
          </span>
        )}
      </button>
      {menu}
    </>
  );
}
