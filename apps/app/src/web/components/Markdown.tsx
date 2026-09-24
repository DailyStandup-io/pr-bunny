import type { ReactNode } from "react";
import { Inline } from "./ui";

/**
 * Minimal markdown → React (never HTML strings, so PR-influenced text can't inject markup):
 * fenced code (incl. ```suggestion), headings, bullet/numbered lists, paragraphs, and inline
 * `code` / **bold** / [links](https://…).
 */
export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      blocks.push(
        <div key={key++} className="overflow-hidden rounded-lg border border-line">
          {lang && (
            <div className={`px-3 py-1 font-mono text-[10px] uppercase tracking-wider ${lang === "suggestion" ? "bg-add-soft text-add" : "bg-sunken text-fg-3"}`}>
              {lang === "suggestion" ? "Suggested change" : lang}
            </div>
          )}
          <pre className="overflow-x-auto bg-code px-3 py-2 font-mono text-[12.5px] leading-relaxed text-fg">{body.join("\n")}</pre>
        </div>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      blocks.push(<p key={key++} className="font-semibold"><RichInline text={heading[2]!} /></p>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) {
        let item = lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) item += " " + lines[i++]!.trim();
        items.push(item);
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key++} className={`space-y-1 pl-5 ${ordered ? "list-decimal" : "list-disc"} marker:text-fg-3`}>
          {items.map((it, j) => <li key={j}><RichInline text={it} /></li>)}
        </List>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^```|^#{1,4}\s|^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={key++}><RichInline text={para.join(" ")} /></p>);
  }
  return <div className={`space-y-2.5 ${className}`}>{blocks}</div>;
}

/** Inline plus safe http(s) links. */
function RichInline({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
        return m ? (
          <a key={i} href={m[2]} target="_blank" rel="noreferrer" className="underline">
            {m[1]}
          </a>
        ) : (
          <Inline key={i} text={p} />
        );
      })}
    </>
  );
}
