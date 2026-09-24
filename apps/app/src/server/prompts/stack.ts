// The "across the stack" pass: once every layer of a stack has its own deep review, look for what
// only shows up when the layers are read together.

export const STACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      description: "Findings that span layers. An empty array is a valid, good outcome.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "prs", "severity", "lens", "title", "why", "fix", "fixedNote", "fixedIn", "confidence", "placements", "replaces", "prompt"],
        properties: {
          kind: {
            type: "string",
            enum: ["relies", "repeated", "fixed", "breaks"],
            description:
              "relies: one layer depends on something another layer adds, and the dependency is wrong or fragile. repeated: the same problem appears in several layers (merge it into one finding). fixed: a problem one layer introduces is fixed by a later layer. breaks: layers conflict (the same migration twice, one undoes another, merge order matters).",
          },
          prs: { type: "array", items: { type: "integer" }, description: "Every PR number involved, base first." },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          lens: { type: "string", description: "Short category, e.g. 'Correctness', 'Deploy safety', 'Privacy'." },
          title: { type: "string", description: "One-line claim, <= 90 chars. Refer to PRs as #123." },
          why: { type: "string", description: "For the reviewer: what goes wrong and why, citing code in each layer you read." },
          fix: { type: ["string", "null"], description: "What to change, and in which PR." },
          fixedNote: { type: ["string", "null"], description: "kind=fixed only: what the later PR changes, so the reviewer can post a heads-up instead of requesting changes. Else null." },
          fixedIn: { type: ["integer", "null"], description: "kind=fixed only: the PR that fixes it. Else null." },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          placements: {
            type: "array",
            description: "Where to post it: one entry per PR that should get the comment (usually the PR that needs to change; for 'repeated', each PR where it occurs).",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["pr", "path", "line", "comment"],
              properties: {
                pr: { type: "integer" },
                path: { type: ["string", "null"], description: "Repo-relative file in that PR's diff, or null for a general comment." },
                line: { type: ["integer", "null"], description: "Line in the NEW file of that PR, inside its diff, or null." },
                comment: { type: "string", description: "The comment for that PR's author, in GitHub markdown: direct, specific, kind, 1–4 sentences. Mention the other PR(s) as #123." },
              },
            },
          },
          replaces: {
            type: "array",
            items: { type: "integer" },
            description: "Ids of per-layer findings (from the list you were given) that this finding covers, so they aren't decided twice. Empty if none.",
          },
          prompt: { type: ["string", "null"], description: "An instruction the author can paste into their coding agent to fix it, naming the branch(es). Null if nothing to change." },
        },
      },
    },
  },
} as const;

export interface StackOutput {
  findings: Array<{
    kind: "relies" | "repeated" | "fixed" | "breaks";
    prs: number[];
    severity: "critical" | "high" | "medium" | "low";
    lens: string;
    title: string;
    why: string;
    fix: string | null;
    fixedNote: string | null;
    fixedIn: number | null;
    confidence: "high" | "medium" | "low";
    placements: Array<{ pr: number; path: string | null; line: number | null; comment: string }>;
    replaces: number[];
    prompt: string | null;
  }>;
}

export interface StackLayerInput {
  pr: number;
  title: string;
  author: string;
  headRef: string;
  baseRef: string;
  parentPr: number | null;
  summary: string | null;
  findings: Array<{ id: number; severity: string; title: string; path: string | null; line: number | null; why: string }>;
  diff: string;
  diffTruncated: boolean;
}

export function stackSystem(worktree: string): string {
  return `You are the "across the stack" step of a PR review tool. A stack is a chain of PRs, each based on the one below it. Every layer has already had its own review. Your job is only what shows up when the layers are read together.

Environment:
- The top layer's head is checked out in your working directory: ${worktree}. Because each layer builds on the one below, it contains every layer's code. You can Read/Grep/Glob it and run read-only git (diff/log/show/blame) and gh (pr view/diff) commands. Everything else is denied.
- You cannot post anything; the tool does that after the human approves.

Look for:
- relies: code one layer adds that another layer depends on, where the dependency is wrong or fragile.
- repeated: the same problem in several layers. Merge it into one finding and list the per-layer findings it covers in \`replaces\`.
- fixed: something a lower layer breaks that a higher layer fixes. The reviewer can post a heads-up instead of requesting changes.
- breaks: layers that clash (the same migration twice, one reverts another, a merge order that fails).

Rules:
- Don't repeat single-layer findings that don't involve another layer; those are already covered.
- Verify in the code before reporting. An empty list is a valid outcome.
- Refer to PRs as #123 everywhere.`;
}

export function stackPrompt(input: { repo: string; baseRef: string; layers: StackLayerInput[] }): string {
  const layers = input.layers
    .map((l, i) => {
      const found = l.findings.length
        ? l.findings.map((f) => `  - [id ${f.id}] [${f.severity}] ${f.title}${f.path ? ` (${f.path}${f.line ? `:${f.line}` : ""})` : ""}: ${f.why.split("\n")[0]}`).join("\n")
        : "  (none)";
      return `## Layer ${i + 1}: #${l.pr} ${l.title}
Author ${l.author} · ${l.headRef} → ${l.parentPr ? `#${l.parentPr} (${l.baseRef})` : l.baseRef}
${l.summary ? `Its review: ${l.summary}\n` : ""}Its findings:
${found}

Diff of this layer against its parent${l.diffTruncated ? " (truncated; read the checkout for the rest)" : ""}:
\`\`\`diff
${l.diff}
\`\`\``;
    })
    .join("\n\n");
  return `Stack in ${input.repo}, based on ${input.baseRef}, ${input.layers.length} PRs from the base up:

${layers}

Return the findings that span layers, as JSON matching the schema.`;
}
