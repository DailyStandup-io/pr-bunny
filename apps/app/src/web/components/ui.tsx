import type { CSSProperties, ReactNode } from "react";
import type { ClaudeRun, Phase } from "../../shared/types";
import { navigate } from "../api";

export function Link({ to, className, style, children }: { to: string; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <a
      href={to}
      className={className}
      style={style}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** Material Symbols Rounded ligature icon. */
export function Sym({ name, size = 18, className = "", fill = false }: { name: string; size?: number; className?: string; fill?: boolean }) {
  return (
    <span aria-hidden className={`sym ${className}`} style={{ fontSize: size, fontVariationSettings: fill ? "'FILL' 1" : undefined }}>
      {name}
    </span>
  );
}

/** An SVG asset drawn in currentColor. */
export function MaskIcon({ src, size = 22, className = "" }: { src: string; size?: number; className?: string }) {
  return <span aria-hidden className={`mask-icon ${className}`} style={{ width: size, height: size, ["--icon" as string]: `url("${src}")` }} />;
}

/** Surface card used for nearly every panel. */
export const card = "rounded-xl border border-line bg-surface";
/** Small grey section heading inside a card. */
export const cardLabel = "m-0 text-[13px] font-semibold text-fg-3";
/** Standard text input / textarea look. */
export const field = "rounded-lg border border-line-strong bg-bg outline-none focus-ring";

export function Diffstat({ additions, deletions, className = "text-[12px]" }: { additions: number; deletions: number; className?: string }) {
  return (
    <span className={`font-mono tabular-nums ${className}`}>
      <span className="text-add">+{additions.toLocaleString()}</span> <span className="text-del">−{deletions.toLocaleString()}</span>
    </span>
  );
}

/** `light`: for use on an accent-coloured button. */
export function Spinner({ size = 13, light = false }: { size?: number; light?: boolean }) {
  return (
    <span
      className={`pb-spin inline-block flex-none rounded-full border-2 ${light ? "border-[color-mix(in_oklch,var(--on-accent)_35%,transparent)] border-t-on-accent" : "border-accent-soft-2 border-t-accent"}`}
      style={{ width: size, height: size }}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="rounded border border-line-strong px-[5px] font-mono">{children}</span>;
}

export function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function fmtTokens(n: number | null): string {
  if (n == null) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function timeAgo(iso: string): string {
  // SQLite datetime('now') is UTC without a zone marker.
  const t = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").getTime();
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function RunMeta({ runs }: { runs: ClaudeRun[] }) {
  if (!runs.length) return null;
  return (
    <div className="flex flex-col gap-1.5 px-1 font-mono text-[11.5px] text-fg-3">
      {runs.map((r) => (
        <div key={r.id} className="flex flex-wrap justify-between gap-2.5">
          <span className="inline-flex items-center gap-1.5">
            {r.status === "running" ? <Spinner size={10} /> : <span className={r.status === "success" ? "text-add" : "text-del"}>●</span>}
            {r.kind} · {r.model}
          </span>
          <span
            className="tabular-nums"
            title={r.costUsd != null ? `≈ $${r.costUsd.toFixed(2)} at list price. Runs bill against your subscription.` : undefined}
          >
            {fmtDuration(r.durationMs)} · {fmtTokens(r.inputTokens)} in · {fmtTokens(r.outputTokens)} out
          </span>
        </div>
      ))}
    </div>
  );
}

export const PHASE_LABEL: Record<Phase, string> = {
  recon_running: "Scanning",
  recon_ready: "Overview ready",
  read: "Queued",
  reviewing: "Reviewing",
  walkthrough: "Ready to walk through",
  submitted: "Submitted",
  failed: "Failed",
};

export const phaseColor = (p: Phase) => (p === "submitted" ? "var(--add)" : p === "failed" ? "var(--del)" : "var(--accent)");

export const inlineCode = "rounded bg-code-inline px-[5px] font-mono text-[0.86em]";

/** Renders the little markdown Claude uses in prose: `code` and **bold**. Everything else is text. */
export function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <code key={i} className={inlineCode}>{p.slice(1, -1)}</code>
        ) : p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <strong key={i} className="font-semibold">
            <Inline text={p.slice(2, -2)} />
          </strong>
        ) : (
          p
        ),
      )}
    </>
  );
}

/** Text with markdown markers removed, for single-line list labels. */
export const plain = (t: string) => t.replace(/`/g, "").replace(/\*\*/g, "");
