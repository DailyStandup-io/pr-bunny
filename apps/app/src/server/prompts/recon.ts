import type { StackPr } from "../../shared/types";
import type { AreaGroup } from "../areas";
import type { PrView } from "../gh";

export const RECON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "intent", "areas", "riskFlags", "estReviewMinutes", "estAssistedMinutes", "estReasoning", "focusPoints"],
  properties: {
    headline: { type: "string", description: "One line, <= 90 chars: what this PR is, in plain words." },
    summary: { type: "string", description: "2–4 sentences: what the change does and how, for a reviewer about to read it." },
    intent: { type: "string", description: "One sentence: why this change exists / the problem it solves." },
    areas: {
      type: "array",
      description: "One entry per provided area path, same paths, in the same order.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "label", "note"],
        properties: {
          path: { type: "string" },
          label: { type: "string", description: "2–4 word human name for this area, e.g. 'Enrollment API'." },
          note: { type: "string", description: "<= 120 chars: what changes here." },
        },
      },
    },
    riskFlags: {
      type: "array",
      description: "Things that deserve attention during the deep review. Empty if none. Max 6.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["level", "text"],
        properties: {
          level: { type: "string", enum: ["high", "medium", "low"] },
          text: { type: "string" },
        },
      },
    },
    estReviewMinutes: { type: "integer", minimum: 1, description: "Minutes for a careful human review." },
    estAssistedMinutes: {
      type: "integer",
      minimum: 1,
      description:
        "Minutes for the same reviewer using this tool: reading this overview, then deciding the findings an in-depth AI review raises. Usually well under estReviewMinutes.",
    },
    estReasoning: { type: "string", description: "One short sentence on why the estimate differs from (or matches) the heuristic." },
    focusPoints: {
      type: "array",
      items: { type: "string" },
      description: "2–5 short pointers: where a reviewer should look hardest.",
    },
  },
} as const;

export const RECON_SYSTEM = `You are the recon step of a PR review tool. A human reviewer will read your output BEFORE the in-depth review runs, to orient themselves. Be concrete and brief. Do not review for bugs yet and do not invent problems — only flag risk that is visible from the change's shape (migrations, auth, public contracts, deploy ordering, personal data/secrets handling, large deletions, native/runtime config). Return your answer only via the structured output tool.`;

export function reconPrompt(input: {
  repo: string;
  pr: PrView;
  areas: AreaGroup[];
  heuristicMinutes: number;
  stack: StackPr[];
  diff: string;
  diffTruncated: boolean;
}): string {
  const { pr } = input;
  const stack = input.stack.length
    ? input.stack
        .sort((a, b) => (a.relation === b.relation ? a.depth - b.depth : a.relation === "parent" ? -1 : 1))
        .map((s) => `- ${s.relation} (depth ${s.depth}): #${s.number} ${s.title}`)
        .join("\n")
    : "(not part of a stack)";

  return `Repository: ${input.repo}
PR #${pr.number}: ${pr.title}
Author: ${pr.author}${pr.isDraft ? " (draft)" : ""}
Branch: ${pr.headRefName} → ${pr.baseRefName}
Size: +${pr.additions} −${pr.deletions} across ${pr.changedFiles} files
Labels: ${pr.labels.join(", ") || "none"}

## Description
${pr.body.trim() || "(empty)"}

## Stack
${stack}

## Areas touched (label each of these, same order)
${input.areas.map((a) => `- ${a.path} — ${a.files} files, +${a.additions} −${a.deletions}`).join("\n")}

## Heuristic review estimate
${input.heuristicMinutes} minutes (line-count based). Adjust for real complexity: boilerplate and tests are fast; subtle logic, concurrency, migrations and contracts are slow.
Also estimate the assisted time: the reviewer reads this overview, then an in-depth AI review lists findings they accept or dismiss one by one. They still need to understand the risky parts, so it's never near zero.

## Diff${input.diffTruncated ? " (TRUNCATED — later files omitted; say so in the summary if it matters)" : ""}
\`\`\`diff
${input.diff}
\`\`\``;
}

// ---------- self-review ----------

/** Recon for your own change: same shape, plus the questions a reviewer is likely to ask. */
export const RECON_SELF_SCHEMA = {
  ...RECON_SCHEMA,
  required: [...RECON_SCHEMA.required, "reviewerQuestions"],
  properties: {
    ...RECON_SCHEMA.properties,
    reviewerQuestions: {
      type: "array",
      description:
        "2–4 questions a reviewer will likely ask that the change and its commits don't answer (rollout, why this approach, how it was tested, timing at production scale). Each with a one-line hint the author can act on.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "hint"],
        properties: {
          question: { type: "string", description: "The question, as a reviewer would put it. May use `code`." },
          hint: { type: "string", description: "One sentence: what to add to the PR description (or change) so it doesn't come up." },
        },
      },
    },
  },
} as const;

export const RECON_SELF_SYSTEM = `${RECON_SYSTEM}

This is a SELF-REVIEW: the reader is the change's own author, checking it before anyone else sees it. Write "this change" rather than "this PR", and address them as "you" where it's natural. There may be no PR yet; the "description" is the commit log.`;
