import { useEffect, useMemo, useState } from "react";
import type { Inbox, InboxEntry, ReviewSummary } from "../../shared/types";
import { api, navigate, useAsync, useLayout } from "../api";
import { pageTitle } from "./Page";
import { RepoSwitcher } from "./RepoSwitcher";
import { PHASE_LABEL, Spinner, Sym, timeAgo } from "./ui";

interface AcItem {
  key: string;
  ref: string;
  title: string;
  meta: string;
  tag?: string;
  go: () => void;
  stack?: { repo: string; pr: number; pos: number; size: number };
}

const short = (repo: string) => repo.split("/")[1] ?? repo;

/** Parses a PR URL, `owner/repo#12`, `#12` or `12`. Bare numbers resolve in the selected repo. */
function parseRef(input: string, repo: string | null): { repo: string; number: number } | null {
  const s = input.trim();
  const m = s.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i) ?? s.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/) ?? s.match(/^()#?(\d+)$/);
  if (!m) return null;
  const r = m[1] || repo;
  return r ? { repo: r, number: Number(m[2]) } : null;
}

/**
 * "Paste a PR URL or #123, or search pull requests": the combobox that starts a review. Suggests
 * PRs assigned to you, open PRs in the selected repo, matches across your repos and past reviews.
 */
export function PrSearch({
  inbox,
  repo,
  onRepo,
  reviews,
  title,
}: {
  inbox: { data?: Inbox };
  repo: string | null;
  onRepo: (r: string) => void;
  reviews: ReviewSummary[];
  title: string;
}) {
  const { narrow } = useLayout();
  const repoPrs = useAsync(() => (repo ? api.repoPrs(repo) : Promise.resolve([])), [repo]);
  const [input, setInput] = useState("");
  const [acOpen, setAcOpen] = useState(false);
  const [acIndex, setAcIndex] = useState(0);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useSearch(input);

  const start = async (pr: string, forRepo = repo) => {
    setStarting(pr);
    setError(null);
    try {
      const { id } = await api.start(pr, forRepo);
      navigate(`/review/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(null);
    }
  };
  const openPr = (p: InboxEntry) => {
    if (p.repo !== repo) onRepo(p.repo);
    start(p.url, p.repo);
  };

  const assignedAll = inbox.data?.assigned ?? [];
  const assigned = assignedAll.filter((p) => p.repo === repo);
  const elsewhere = assignedAll.filter((p) => p.repo !== repo);
  const assignedKeys = new Set(assignedAll.map((p) => `${p.repo}#${p.number}`));
  const openPrs = (repoPrs.data ?? []).filter((p) => !assignedKeys.has(`${p.repo}#${p.number}`));
  const allReviews = reviews;

  // ---------- autocomplete ----------
  const groups = useMemo(() => {
    const q = input.trim().toLowerCase().replace(/^#/, "");
    const match = (p: { title: string; author: string; repo: string; number: number }) =>
      !q || [p.title, p.author, p.repo, `#${p.number}`, String(p.number)].some((x) => x.toLowerCase().includes(q));
    const out: Array<{ label: string; count: string; items: AcItem[] }> = [];
    const known = [...assignedAll, ...(repoPrs.data ?? []), ...search];

    const ref = parseRef(input, repo);
    if (ref) {
      const hit = known.find((p) => p.repo === ref.repo && p.number === ref.number);
      out.push({
        label: "Go to",
        count: "",
        items: [
          {
            key: "goto",
            ref: `#${ref.number}`,
            title: hit ? hit.title : `Review ${ref.repo}#${ref.number}`,
            meta: hit ? `${ref.repo} · ${hit.author}` : `Fetch from ${ref.repo}`,
            go: () => (hit ? openPr(hit) : start(`${ref.repo}#${ref.number}`, ref.repo)),
          },
        ],
      });
    }
    const cap = q ? 6 : 4;
    const pr = (p: InboxEntry, withRepo = false): AcItem => ({
      key: `${p.repo}#${p.number}`,
      ref: `#${p.number}`,
      title: p.title,
      meta: `${withRepo ? `${short(p.repo)} · ` : ""}${p.author} · ${timeAgo(p.updatedAt)}${p.isDraft ? " · Draft" : ""}`,
      tag: p.review ? PHASE_LABEL[p.review.phase] : undefined,
      go: () => openPr(p),
      stack: p.stack ? { repo: p.repo, pr: p.number, ...p.stack } : undefined,
    });
    const add = (label: string, items: AcItem[]) => {
      if (items.length) out.push({ label, count: items.length > cap ? `${cap} of ${items.length}` : "", items: items.slice(0, cap) });
    };
    const s = repo ? short(repo) : "";
    if (repo) {
      add(`Assigned to you · ${s}`, assigned.filter(match).map((p) => pr(p)));
      add(`Open in ${s}`, openPrs.filter(match).map((p) => pr(p)));
    }
    add(repo ? "Assigned to you · other repos" : "Assigned to you", elsewhere.filter(match).map((p) => pr(p, true)));
    if (q) {
      const shown = new Set(out.flatMap((g) => g.items.map((i) => i.key)));
      add("Open in other repos", search.filter((p) => p.repo !== repo && !shown.has(`${p.repo}#${p.number}`)).map((p) => pr(p, true)));
    }
    add(
      "Recent reviews",
      allReviews
        .filter((r) => match({ ...r, number: r.prNumber }))
        .sort((a, b) => Number(b.repo === repo) - Number(a.repo === repo))
        .map((r: ReviewSummary) => ({
          key: `review:${r.id}`,
          ref: `#${r.prNumber}`,
          title: r.title,
          meta: `${short(r.repo)} · ${PHASE_LABEL[r.phase]} · ${timeAgo(r.startedAt)}`,
          go: () => navigate(`/review/${r.id}`),
        })),
    );
    return out;
  }, [input, repo, inbox.data, repoPrs.data, reviews, search]); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = groups.flatMap((g) => g.items);
  const active = flat.length ? Math.min(acIndex, flat.length - 1) : -1;
  const go = (it: AcItem) => {
    setAcOpen(false);
    setInput("");
    it.go();
  };

  let k = 0;
  return (
      <section className="flex flex-col gap-4">
        {narrow && <RepoSwitcher placement="inline" repo={repo} repos={inbox.data?.repos ?? []} onPick={onRepo} />}
        <h1 className={pageTitle}>{title}</h1>
        <div className="relative">
          <span className="pointer-events-none absolute top-[17px] left-[18px] text-fg-3">
            {starting ? <Spinner size={18} /> : <Sym name="search" size={20} />}
          </span>
          <input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setAcOpen(true);
              setAcIndex(0);
            }}
            onFocus={() => {
              setAcOpen(true);
              setAcIndex(0);
            }}
            onBlur={() => setAcOpen(false)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (!flat.length) return;
                const d = e.key === "ArrowDown" ? 1 : -1;
                setAcOpen(true);
                setAcIndex((active + d + flat.length) % flat.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (active >= 0 && acOpen) go(flat[active]!);
                else if (input.trim()) start(input.trim());
              } else if (e.key === "Escape") {
                if (acOpen) setAcOpen(false);
                else (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Paste a PR URL or #123, or search pull requests"
            role="combobox"
            aria-expanded={acOpen}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            className="focus-ring h-[54px] w-full rounded-[10px] border border-line-strong bg-surface pr-[18px] pl-12 text-[15px] outline-none"
          />
          {acOpen && (
            <div role="listbox" className="absolute top-[calc(100%+6px)] right-0 left-0 z-25 flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop-lg">
              <div className="max-h-[min(460px,60vh)] overflow-y-auto p-1.5">
                {groups.map((g) => (
                  <div key={g.label} className="pt-1.5 pb-1">
                    <div className="flex items-baseline gap-2 px-2.5 pt-1 pb-1.5 text-[12px] font-semibold text-fg-3">
                      <span>{g.label}</span>
                      <span className="font-normal">{g.count}</span>
                    </div>
                    {g.items.map((it) => {
                      const idx = k++;
                      const on = idx === active;
                      return (
                        <button
                          key={it.key}
                          role="option"
                          aria-selected={on}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            go(it);
                          }}
                          onMouseEnter={() => idx !== acIndex && setAcIndex(idx)}
                          className={`flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-lg border-0 px-2.5 py-2 text-left ${on ? "bg-hover" : "bg-transparent"}`}
                        >
                          <span className={`min-w-16 flex-none font-mono text-[12.5px] ${on ? "text-accent" : "text-fg-3"}`}>{it.ref}</span>
                          <span className="flex min-w-0 flex-1 flex-col gap-px">
                            <span className="truncate text-[14px] font-medium">{it.title}</span>
                            <span className="truncate text-[12px] text-fg-3">{it.meta}</span>
                          </span>
                          {it.stack && (
                            <span
                              role="button"
                              title="Review the whole stack"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const st = it.stack!;
                                api.openStack(`${st.repo}#${st.pr}`).then(({ id }) => navigate(`/stack/${id}`), () => {});
                              }}
                              className="inline-flex h-[26px] flex-none cursor-pointer items-center gap-1 rounded-md border border-line-strong bg-surface px-[9px] text-[12px] font-medium whitespace-nowrap text-fg-2 hover:border-accent hover:text-accent"
                            >
                              <Sym name="stacks" size={14} />
                              Review stack · {it.stack.pos} of {it.stack.size}
                            </span>
                          )}
                          {it.tag && <span className="flex-none rounded-full bg-accent-soft px-[9px] py-0.5 text-[12px] font-medium text-accent">{it.tag}</span>}
                          {on && <Sym name="keyboard_return" className="text-fg-3" />}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {flat.length === 0 && <p className="m-0 px-3 py-[18px] text-[14px] text-fg-3">No matches in your repos. Paste a PR URL to review one from anywhere.</p>}
              </div>
              <div className="flex flex-wrap gap-4 border-t border-line bg-sunken px-3.5 py-2 text-[12px] text-fg-3">
                <span><span className="font-mono">↑↓</span> move</span>
                <span><span className="font-mono">Enter</span> open</span>
                <span><span className="font-mono">Esc</span> close</span>
                {repo && <span className="ml-auto">Numbers resolve in {repo}</span>}
              </div>
            </div>
          )}
        </div>
        {error && <p className="m-0 text-[14px] text-del">{error}</p>}
      </section>

  );
}

/** Debounced GitHub search across the switcher's repos, for "Open in other repos". */
function useSearch(input: string): InboxEntry[] {
  const [results, setResults] = useState<InboxEntry[]>([]);
  useEffect(() => {
    const q = input.trim();
    if (q.length < 2 || /^#?\d+$/.test(q) || /github\.com\//.test(q)) {
      setResults([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api.search(q).then(
        (r) => live && setResults(r),
        () => live && setResults([]),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [input]);
  return results;
}

