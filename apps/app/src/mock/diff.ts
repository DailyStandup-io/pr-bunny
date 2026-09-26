// A small, deterministic unified-diff generator for the fixtures: the same output every run, in the
// shape `gh pr diff` prints (git headers, 3 lines of context, merged hunks). The fake `gh` serves
// these diffs and the fake agents anchor their findings against them, so both agree by construction.

/** Splits file content into lines (no trailing empty line for a final newline). */
export function lines(text: string): string[] {
  if (!text) return [];
  const out = text.split("\n");
  if (out.at(-1) === "") out.pop();
  return out;
}

type Op = { kind: "ctx" | "del" | "add"; text: string };

/** Line-level edit script via LCS, with the common prefix and suffix trimmed first. */
function editScript(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  // lcs[i][j] = LCS length of A[i..] and B[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = A[i] === B[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const mid: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      mid.push({ kind: "ctx", text: A[i]! });
      i++;
      j++;
    } else if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      mid.push({ kind: "del", text: A[i++]! });
    } else {
      mid.push({ kind: "add", text: B[j++]! });
    }
  }
  return [...a.slice(0, pre).map((text) => ({ kind: "ctx" as const, text })), ...mid, ...a.slice(a.length - suf).map((text) => ({ kind: "ctx" as const, text }))];
}

const range = (start: number, len: number) => (len === 1 ? `${start}` : `${len === 0 ? start - 1 : start},${len}`);

/** Hunks for two versions of a file, git style (`@@ -a,b +c,d @@`). Empty when nothing changed. */
export function hunks(before: string, after: string, context = 3): string[] {
  const ops = editScript(lines(before), lines(after));
  const changed = ops.map((o, i) => (o.kind === "ctx" ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return [];
  // Group changes whose context windows touch.
  const groups: Array<[number, number]> = [];
  for (const i of changed) {
    const last = groups.at(-1);
    if (last && i - last[1] <= context * 2 + 1) last[1] = i;
    else groups.push([i, i]);
  }
  const out: string[] = [];
  for (const [first, last] of groups) {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    let oldNo = 1;
    let newNo = 1;
    for (let k = 0; k < from; k++) {
      if (ops[k]!.kind !== "add") oldNo++;
      if (ops[k]!.kind !== "del") newNo++;
    }
    const body: string[] = [];
    let oldLen = 0;
    let newLen = 0;
    for (let k = from; k <= to; k++) {
      const o = ops[k]!;
      body.push(`${o.kind === "ctx" ? " " : o.kind === "del" ? "-" : "+"}${o.text}`);
      if (o.kind !== "add") oldLen++;
      if (o.kind !== "del") newLen++;
    }
    out.push(`@@ -${range(oldNo, oldLen)} +${range(newNo, newLen)} @@\n${body.join("\n")}`);
  }
  return out;
}

/** Deterministic fake blob id for the `index` line (only its shape matters to readers). */
function blobId(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 7);
}

/** One file's section of a unified diff. `before`/`after` null = the file doesn't exist on that side. */
export function fileDiff(path: string, before: string | null, after: string | null): string {
  const hs = hunks(before ?? "", after ?? "");
  if (!hs.length) return "";
  const head = [`diff --git a/${path} b/${path}`];
  if (before === null) head.push("new file mode 100644", `index 0000000..${blobId(after!)}`, "--- /dev/null", `+++ b/${path}`);
  else if (after === null) head.push("deleted file mode 100644", `index ${blobId(before)}..0000000`, `--- a/${path}`, "+++ /dev/null");
  else head.push(`index ${blobId(before)}..${blobId(after)} 100644`, `--- a/${path}`, `+++ b/${path}`);
  return `${head.join("\n")}\n${hs.join("\n")}\n`;
}

/** Added and removed line counts for one file. */
export function stat(before: string | null, after: string | null): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const o of editScript(lines(before ?? ""), lines(after ?? ""))) {
    if (o.kind === "add") additions++;
    else if (o.kind === "del") deletions++;
  }
  return { additions, deletions };
}
