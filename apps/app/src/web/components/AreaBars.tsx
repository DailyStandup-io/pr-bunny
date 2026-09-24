import type { Area } from "../../shared/types";
import { Inline } from "./ui";

export function AreaBars({ areas }: { areas: Area[] }) {
  const max = Math.max(1, ...areas.map((a) => a.additions + a.deletions));
  return (
    <ul className="m-0 flex list-none flex-col gap-4 p-0">
      {areas.map((a) => {
        const total = a.additions + a.deletions;
        const addShare = total ? (a.additions / total) * 100 : 50;
        return (
          <li key={a.path}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="min-w-0">
                <span className="text-[14.5px] font-medium">{a.label}</span>{" "}
                <span className="ml-1.5 font-mono text-[12px] text-fg-3">{a.path}</span>
              </span>
              <span className="font-mono text-[12px] text-fg-3 tabular-nums">
                {a.files} {a.files === 1 ? "file" : "files"} · <span className="text-add">+{a.additions}</span> <span className="text-del">−{a.deletions}</span>
              </span>
            </div>
            <div className="mt-[7px] h-1.5 rounded-[3px] bg-sunken">
              <div className="flex h-full overflow-hidden rounded-[3px]" style={{ width: `${Math.max(2, (total / max) * 100)}%` }}>
                <div className="bg-add" style={{ width: `${addShare}%` }} />
                <div className="bg-del" style={{ width: `${100 - addShare}%` }} />
              </div>
            </div>
            {a.note && (
              <p className="mt-1.5 mb-0 text-[13.5px] leading-normal text-fg-2">
                <Inline text={a.note} />
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
