import { useEffect, useRef, type ReactNode } from "react";
import { card, Spinner, Sym } from "./ui";
import { GreySpinner } from "./Tidy";

export interface ProgressLine {
  text: string;
  tool?: string;
  at: number;
  kind?: "recon" | "review" | "qa";
}

/**
 * A run's live log. `action` sits at the right of the header (the Stop button); `stopping` greys the
 * spinner while it winds down; `footer` goes under the log (Force stop).
 */
export function ProgressFeed({
  lines,
  title,
  active,
  action,
  stopping = false,
  footer,
}: {
  lines: ProgressLine[];
  title: string;
  active: boolean;
  action?: ReactNode;
  stopping?: boolean;
  footer?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines.length]);
  const start = lines[0]?.at;

  return (
    // No overflow-hidden: the Stop confirm pops out of the header. The last block rounds its own corners.
    <section className={`${card} [&>*:last-child]:rounded-b-xl`}>
      <header className="flex items-center gap-2.5 border-b border-line px-[18px] py-3.5">
        {stopping ? <GreySpinner size={15} /> : active ? <Spinner size={15} /> : <Sym name="check_circle" size={20} className="text-add" />}
        <span className={`min-w-0 flex-1 text-[14px] font-semibold ${stopping ? "text-fg-2" : ""}`}>{stopping ? "Stopping…" : title}</span>
        {action}
      </header>
      <div ref={box} className="max-h-72 overflow-y-auto bg-code px-[18px] py-3 font-mono text-[12.5px] leading-[1.75]">
        {lines.length === 0 && <p className="m-0 text-fg-3">Starting…</p>}
        {lines.map((l, i) => (
          <div key={i} className="flex gap-3">
            <span className="w-10 flex-none text-right text-fg-3 tabular-nums select-none">{start ? `${Math.round((l.at - start) / 1000)}s` : ""}</span>
            <span className={i === lines.length - 1 && active ? "text-fg" : "text-fg-2"}>
              {l.tool && <span className="mr-1.5 text-accent">{l.tool}</span>}
              {l.text}
            </span>
          </div>
        ))}
      </div>
      {footer}
    </section>
  );
}
