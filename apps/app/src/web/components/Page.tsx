import type { ReactNode } from "react";

/** The top-level page frame: one width, one gutter, one title size, for every screen in the rail. */
export const pageFrame = "mx-auto flex w-full max-w-[960px] flex-col px-[clamp(16px,3vw,32px)] pt-10";
export const pageTitle = "m-0 text-[28px] leading-[1.2] font-semibold tracking-[-0.015em]";

export function Page({ title, sub, gap = 24, flush = false, children }: { title?: ReactNode; sub?: ReactNode; gap?: number; flush?: boolean; children: ReactNode }) {
  return (
    <div className={`${pageFrame} ${flush ? "flex-1" : "pb-16"}`} style={{ gap }}>
      {title != null &&
        (sub != null ? (
          <header className="flex flex-col gap-1.5">
            <h1 className={pageTitle}>{title}</h1>
            <p className="m-0 text-[15px] text-fg-2">{sub}</p>
          </header>
        ) : (
          <h1 className={pageTitle}>{title}</h1>
        ))}
      {children}
    </div>
  );
}
