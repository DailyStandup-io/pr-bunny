// The shape of the fictional world: people, repos, PRs and the scripted agent output for each.
// Everything is hand-written in src/mock/world/; src/mock/fixtures.ts derives diffs, line numbers
// and the gh/agent views from it.
import type { Severity, Verdict } from "../shared/types";

export interface Person {
  login: string;
  name: string;
}

/** A change to one file. `replace` pairs must each match exactly once in the file as it was. */
export interface Edit {
  path: string;
  /** New file (or full replacement) with this content. */
  add?: string;
  replace?: Array<[find: string, replaceWith: string]>;
  remove?: boolean;
}

export interface Commit {
  message: string;
  edits: Edit[];
}

/**
 * Where a finding points: the (unique) line containing `match` in the PR's head version of `path`
 * (or the base version with side LEFT). `span` widens it upwards into a multi-line range.
 */
export interface Anchor {
  path: string;
  match: string;
  span?: number;
  side?: "RIGHT" | "LEFT";
}

export interface ScriptFinding {
  severity: Severity;
  lens: string;
  title: string;
  at: Anchor | null;
  why: string;
  fix: string | null;
  comment: string;
  confidence: "high" | "medium" | "low";
  /** Self-review: the coding-agent prompt. */
  prompt?: string;
  /** What the agent says when asked about this finding. */
  qa?: { answer: string; recommendation: "accept" | "dismiss" | "unsure" };
}

/** A progress step the fake agent streams while it "works": a tool call or a line of narration. */
export type TrailStep = { read: string } | { grep: string; in?: string } | { glob: string } | { bash: string } | { say: string };

export interface ReconScript {
  headline: string;
  summary: string;
  intent: string;
  /** Label and note per area path (the paths `groupAreas` makes from the PR's files). */
  areas: Record<string, [label: string, note: string]>;
  risks: Array<["high" | "medium" | "low", string]>;
  /** Careful human review, and with PR Bunny. */
  minutes: [review: number, assisted: number];
  estReasoning: string;
  focus: string[];
  /** Self-review only: "What reviewers will ask". */
  questions?: Array<[question: string, hint: string]>;
}

export interface ReviewScript {
  findings: ScriptFinding[];
  verdict: Verdict;
  summary: string;
  coverage: string;
  trail?: TrailStep[];
}

/** A re-review after new commits: new findings, plus what happened to each earlier one (by title). */
export interface RereviewScript extends ReviewScript {
  prior: Record<string, ["addressed" | "still_present" | "unclear", string]>;
}

export interface GithubReview {
  author: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  minutesAgo: number;
  comments: number;
}

export interface FixturePr {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  /** Head branch. */
  branch: string;
  /** Base branch (another PR's head for a stack layer). */
  base: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  draft?: boolean;
  labels?: string[];
  /** Review requested of the viewer, by this person. */
  requestedBy?: string;
  requestedMinutesAgo?: number;
  /** Assigned to the viewer. */
  assigned?: boolean;
  updatedMinutesAgo: number;
  commits: Commit[];
  github?: {
    reviews?: GithubReview[];
    checks?: Array<[name: string, state: "SUCCESS" | "FAILURE" | "PENDING"]>;
    decision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
    mergeable?: "MERGEABLE" | "CONFLICTING";
  };
  recon?: ReconScript;
  review?: ReviewScript;
  /** Re-review after the last commit (the viewer reviewed the one before). */
  rereview?: RereviewScript;
  /** "Ask about this PR" answers, matched by a word in the question; `*` is the fallback. */
  askPr?: Record<string, string>;
}

/** A branch in the viewer's checkout with no PR yet (self-review of a local branch). */
export interface FixtureBranch {
  repo: string;
  branch: string;
  base: string;
  /** On GitHub already (so "Open PR" can create the PR). */
  pushed: boolean;
  commits: Commit[];
  recon?: ReconScript;
  review?: ReviewScript;
}

export interface StackScriptFinding {
  kind: "relies" | "repeated" | "fixed" | "breaks";
  prs: number[];
  severity: Severity;
  lens: string;
  title: string;
  why: string;
  fix: string | null;
  fixedNote: string | null;
  fixedIn: number | null;
  confidence: "high" | "medium" | "low";
  placements: Array<{ pr: number; at: Anchor | null; comment: string }>;
  /** Titles of per-layer findings this one covers. */
  replaces: string[];
  prompt: string | null;
}

export interface FixtureStack {
  repo: string;
  /** The bottom PR (based on the repo's base branch). */
  root: number;
  /** Short name used in the demo cheat-sheet. */
  name: string;
  cross: { findings: StackScriptFinding[]; trail?: TrailStep[] };
}

export interface FixtureRepo {
  owner: string;
  name: string;
  description: string;
  defaultBranch: string;
  /** Files on the default branch before any fixture PR. */
  files: Record<string, string>;
  /** People who "recently committed" to the repo, most active first (for suggested reviewers). */
  committers: string[];
}
