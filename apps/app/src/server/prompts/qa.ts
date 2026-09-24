import type { Finding } from "../../shared/types";

export const QA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "recommendation", "revised"],
  properties: {
    answer: { type: "string", description: "Direct answer to the reviewer's question, in markdown. Cite code (path:line) you read." },
    recommendation: { type: "string", enum: ["accept", "dismiss", "unsure"], description: "Should the reviewer post this finding, given what you now know?" },
    revised: {
      type: ["object", "null"],
      description: "Only if the finding itself should change (wrong severity, better comment, corrected line). Otherwise null.",
      additionalProperties: false,
      required: ["severity", "title", "why", "fix", "comment", "line", "startLine"],
      properties: {
        severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
        title: { type: "string" },
        why: { type: "string" },
        fix: { type: ["string", "null"] },
        comment: { type: "string" },
        line: { type: ["integer", "null"] },
        startLine: { type: ["integer", "null"] },
      },
    },
  },
} as const;

export interface QaOutput {
  answer: string;
  recommendation: "accept" | "dismiss" | "unsure";
  revised: null | {
    severity: Finding["severity"];
    title: string;
    why: string;
    fix: string | null;
    comment: string;
    line: number | null;
    startLine: number | null;
  };
}

export const PR_QA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: {
    answer: { type: "string", description: "Direct answer to the reviewer's question, in markdown. Cite code (path:line) you read." },
  },
} as const;

export interface PrQaOutput {
  answer: string;
}

/** A question about the whole PR, asked from the overview (before or after the deep review). */
export function prQaPrompt(
  ctx: { repo: string; number: number; title: string; author: string; headRef: string; baseRef: string; mergeBase: string | null; headline: string | null; summary: string | null },
  question: string,
  firstTurn: boolean,
): string {
  const context = firstTurn
    ? `You're helping a reviewer understand a pull request before they review it. The PR is checked out in the current directory (read-only).

PR: ${ctx.repo}#${ctx.number} "${ctx.title}" by ${ctx.author}
Branch: ${ctx.headRef} → ${ctx.baseRef}${ctx.mergeBase ? `\nSee the change with: git diff ${ctx.mergeBase}...HEAD` : ""}
${ctx.headline ? `Overview: ${ctx.headline}\n${ctx.summary ?? ""}\n` : ""}
`
    : "";
  return `${context}Reviewer's question:
${question}

Read the code as needed, answer briefly and concretely, and return via the structured output tool.`;
}

export function qaPrompt(f: Finding, question: string, firstTurn: boolean): string {
  const context = firstTurn
    ? `The reviewer is walking through your findings and has a question about this one:

[${f.severity}] ${f.title}
Location: ${f.path ?? "general"}${f.line ? `:${f.startLine ? `${f.startLine}-` : ""}${f.line}` : ""}
Why: ${f.why}
Fix: ${f.fix ?? "—"}
Current draft comment:
${f.comment}

`
    : "";
  return `${context}Reviewer's question:
${question}

Investigate as needed (the checkout is still available), answer honestly — including "you're right, this finding is wrong" — and return via the structured output tool.`;
}
