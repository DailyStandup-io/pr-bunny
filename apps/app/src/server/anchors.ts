// Parses unified diffs so findings can be (a) validated against GitHub's rule that inline comments
// must land inside a diff hunk and (b) shown with the surrounding diff lines.
import type { SnippetLine } from "../shared/types";

interface DiffLine {
  kind: "add" | "del" | "ctx";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface FileDiff {
  path: string;
  hunks: DiffLine[][];
}

export function parseDiff(diff: string): Map<string, FileDiff> {
  const files = new Map<string, FileDiff>();
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let file: FileDiff | null = null;
  let hunk: DiffLine[] | null = null;
  let oldNo = 0;
  let newNo = 0;
  const pathOf = (p: string) => (p.trim() === "/dev/null" ? null : p.trim().replace(/^[ab]\//, ""));

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      oldPath = newPath = null;
      file = hunk = null;
      continue;
    }
    if (!hunk && raw.startsWith("--- ")) {
      oldPath = pathOf(raw.slice(4));
      continue;
    }
    if (!hunk && raw.startsWith("+++ ")) {
      newPath = pathOf(raw.slice(4));
      continue;
    }
    const h = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      const path = newPath ?? oldPath; // deleted files only have the old path
      if (!path) continue;
      file ??= files.get(path) ?? { path, hunks: [] };
      files.set(path, file);
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = [];
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith("+")) hunk.push({ kind: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) });
    else if (raw.startsWith("-")) hunk.push({ kind: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) });
    else if (raw.startsWith(" ")) hunk.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
    // "\ No newline at end of file" and blank separators: ignore
  }
  return files;
}

const lineNo = (l: DiffLine, side: "RIGHT" | "LEFT") => (side === "RIGHT" ? l.newNo : l.oldNo);

function findHunk(fd: FileDiff, line: number, side: "RIGHT" | "LEFT"): { hunk: DiffLine[]; index: number } | null {
  for (const hunk of fd.hunks) {
    const index = hunk.findIndex((l) => lineNo(l, side) === line);
    if (index >= 0) return { hunk, index };
  }
  return null;
}

export interface AnchorInput {
  path: string | null;
  line: number | null;
  startLine: number | null;
  side: "RIGHT" | "LEFT" | null;
}

/**
 * Returns the finding's anchor normalised for GitHub, or `anchorable: false` if GitHub would
 * reject it. A range must start and end in the same hunk. If `side` looks wrong (the line only
 * exists on the other side), it's corrected rather than dropped.
 */
export function validateAnchor(files: Map<string, FileDiff>, a: AnchorInput): AnchorInput & { anchorable: boolean } {
  const no = { ...a, anchorable: false };
  if (!a.path || a.line == null) return no;
  const fd = files.get(a.path);
  if (!fd) return no;

  for (const side of a.side === "LEFT" ? (["LEFT", "RIGHT"] as const) : (["RIGHT", "LEFT"] as const)) {
    const end = findHunk(fd, a.line, side);
    if (!end) continue;
    let startLine = a.startLine != null && a.startLine < a.line ? a.startLine : null;
    if (startLine != null && !end.hunk.some((l) => lineNo(l, side) === startLine)) startLine = null;
    return { path: a.path, line: a.line, startLine, side, anchorable: true };
  }
  return no;
}

/** Diff lines around an anchor (±context within its hunk), or null if the line isn't in the diff. */
export function snippetFromDiff(files: Map<string, FileDiff>, a: AnchorInput, context = 5): SnippetLine[] | null {
  if (!a.path || a.line == null) return null;
  const fd = files.get(a.path);
  if (!fd) return null;
  const side = a.side ?? "RIGHT";
  const found = findHunk(fd, a.line, side);
  if (!found) return null;
  const start = a.startLine ?? a.line;
  const startIdx = found.hunk.findIndex((l) => lineNo(l, side) === start);
  const from = Math.max(0, (startIdx >= 0 ? startIdx : found.index) - context);
  const to = Math.min(found.hunk.length, found.index + context + 1);
  const lo = Math.min(start, a.line);
  return found.hunk.slice(from, to).map((l) => {
    const n = lineNo(l, side);
    return { ...l, target: n != null && n >= lo && n <= a.line! };
  });
}

/** Plain file lines as a snippet (for findings on code the diff doesn't show). */
export function snippetFromFile(lines: string[], firstLineNo: number, target: { from: number; to: number }): SnippetLine[] {
  return lines.map((text, i) => {
    const n = firstLineNo + i;
    return { kind: "ctx", oldNo: null, newNo: n, text, target: n >= target.from && n <= target.to };
  });
}
