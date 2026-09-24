import { useState } from "react";
import type { StackPr } from "../../shared/types";
import { Inline } from "./ui";

/** How many PRs to show on each side of the reviewed one before collapsing. */
const NEIGHBOURS = 2;

/** Vertical stack diagram: base-most parent at the bottom, like `git log --graph` reads upward. */
export function StackRail({ stack, self, repo }: { stack: StackPr[]; self: { number: number; title: string; baseRef: string }; repo: string }) {
  const [expanded, setExpanded] = useState(false);
  const parents = stack.filter((s) => s.relation === "parent").sort((a, b) => a.depth - b.depth);
  const children = stack.filter((s) => s.relation === "child").sort((a, b) => b.depth - a.depth);

  const shownChildren = expanded ? children : children.filter((c) => c.depth <= NEIGHBOURS);
  const shownParents = expanded ? parents : parents.filter((p) => p.depth <= NEIGHBOURS);
  const hiddenAbove = children.length - shownChildren.length;
  const hiddenBelow = parents.length - shownParents.length;
  const collapsible = stack.some((s) => s.depth > NEIGHBOURS);

  const rows = [
    ...shownChildren.map((s) => ({ number: s.number, title: s.title, self: false })),
    { number: self.number, title: self.title, self: true },
    ...shownParents.map((s) => ({ number: s.number, title: s.title, self: false })),
  ];

  const More = ({ count }: { count: number }) => (
    <li className="relative flex items-center gap-3 text-[12px] text-fg-3">
      <span className="relative z-10 flex w-[15px] flex-none justify-center leading-none">⋮</span>
      <button onClick={() => setExpanded(true)} className="cursor-pointer border-0 bg-transparent p-0 text-fg-3 hover:text-accent">
        {count} more
      </button>
    </li>
  );

  return (
    <div>
      <p className="mt-0 mb-3 text-[12.5px] text-fg-3">
        {stack.length + 1} PRs · position {parents.length + 1} from the base
      </p>
      <ol className="relative m-0 flex list-none flex-col gap-2.5 p-0">
        <span className="absolute top-2.5 bottom-2.5 left-[7px] w-px bg-line-strong" />
        {hiddenAbove > 0 && <More count={hiddenAbove} />}
        {rows.map((r) => (
          <li key={r.number} className="relative flex items-start gap-3 text-[13.5px] leading-[1.4]">
            <span
              className={`mt-0.5 size-[15px] flex-none rounded-full border-2 ${r.self ? "border-accent bg-accent-soft-2" : "border-line-strong bg-surface"}`}
              style={{ position: "relative" }}
            />
            <a
              href={`https://github.com/${repo}/pull/${r.number}`}
              target="_blank"
              rel="noreferrer"
              className={r.self ? "font-medium text-fg" : "text-fg-2"}
            >
              <span className={`font-mono ${r.self ? "text-accent" : "text-fg-3"}`}>#{r.number}</span> <Inline text={r.title} />
            </a>
          </li>
        ))}
        {hiddenBelow > 0 && <More count={hiddenBelow} />}
        <li className="relative flex items-center gap-3 text-[12px] text-fg-3">
          <span className="relative size-[15px] flex-none rounded-[3px] border border-dashed border-line-strong bg-surface" />
          <span className="font-mono">{parents.at(-1)?.baseRef ?? self.baseRef}</span>
        </li>
      </ol>
      {expanded && collapsible && (
        <button onClick={() => setExpanded(false)} className="mt-2 cursor-pointer border-0 bg-transparent p-0 text-[12px] text-fg-3 hover:text-accent">
          Collapse
        </button>
      )}
    </div>
  );
}
