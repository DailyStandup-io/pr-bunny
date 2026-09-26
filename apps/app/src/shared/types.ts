// Types shared by the server and the web app.

export type Phase =
  | "recon_running"
  | "recon_ready"
  | "read"
  | "reviewing"
  | "walkthrough"
  | "submitted"
  | "failed";

export interface StackPr {
  number: number;
  title: string;
  headRef: string;
  baseRef: string;
  relation: "parent" | "child";
  /** 1 = directly adjacent to the reviewed PR. */
  depth: number;
}

export interface Area {
  path: string;
  label: string;
  note: string;
  files: number;
  additions: number;
  deletions: number;
}

export interface RiskFlag {
  level: "high" | "medium" | "low";
  text: string;
}

export interface Recon {
  headline: string;
  summary: string;
  intent: string;
  areas: Area[];
  riskFlags: RiskFlag[];
  estReviewMinutes: number;
  /** Minutes with this tool doing the legwork. Missing on overviews made before it existed. */
  estAssistedMinutes?: number;
  estReasoning: string;
  heuristicMinutes: number;
  focusPoints: string[];
  diffTruncated: boolean;
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface ClaudeRun {
  id: number;
  kind: "recon" | "review" | "qa";
  model: string;
  status: "running" | "success" | "error";
  costUsd: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
  startedAt: string;
}

export type ReviewMode = "peer" | "self";

export interface ReviewSummary {
  id: number;
  repo: string; // owner/name
  /** 0 for a self-review of a branch that has no PR yet. */
  prNumber: number;
  title: string;
  author: string;
  url: string;
  phase: Phase;
  additions: number;
  deletions: number;
  changedFiles: number;
  startedAt: string;
  submittedAt: string | null;
  mode: ReviewMode;
  headRef: string;
  readAt: string | null;
  error: string | null;
  findingsTotal: number;
  findingsDecided: number;
  findingsAccepted: number;
  /** Self-review: findings not yet resolved in a re-run and not marked won't fix. */
  findingsOpen: number;
  postedEvent: ReviewEvent | null;
  postedComments: number;
  runNumber: number;
  openedPrNumber: number | null;
  /** Latest thing that happened: started, a decision, or posting. */
  updatedAt: string;
}

export type Severity = "critical" | "high" | "medium" | "low";
export type Verdict = "approve" | "merge_with_followups" | "address_before_merge";
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface SnippetLine {
  kind: "add" | "del" | "ctx" | "gap";
  oldNo: number | null;
  newNo: number | null;
  text: string;
  target: boolean;
}

export interface FindingMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface Finding {
  id: number;
  position: number;
  severity: Severity;
  lens: string | null;
  title: string;
  path: string | null;
  line: number | null;
  startLine: number | null;
  side: "RIGHT" | "LEFT" | null;
  why: string;
  fix: string | null;
  comment: string;
  confidence: "high" | "medium" | "low" | null;
  anchorable: boolean;
  decision: "accepted" | "dismissed" | null;
  dismissReason: string | null;
  posted: boolean;
  snippet: SnippetLine[];
  messages: FindingMessage[];
  /** Self-review: instruction for the author's coding agent. */
  agentPrompt: string | null;
  /** Self-review: the re-run that found it fixed, or that found it still present. */
  resolvedRun: number | null;
  stillOpenRun: number | null;
  stillNote: string | null;
  /** Placed here by a stack's "across the stack" pass. */
  stackFindingId: number | null;
  /** Accepted as a heads-up: posted, but doesn't count towards requesting changes. */
  soft: boolean;
}

export interface ReviewerQuestion {
  question: string;
  hint: string;
}

export interface PriorStatus {
  findingId: number;
  title: string;
  status: "addressed" | "still_present" | "unclear";
  note: string;
}

/** A failed step that stopped at its turn cap; it can be resumed with more turns. */
export interface TurnLimitStop {
  stage: "recon" | "review";
  /** The cap the run was given, if known. */
  limit: number | null;
  /** The current default cap for this stage. */
  defaultLimit: number;
}

export interface ReviewDetail extends ReviewSummary {
  headSha: string;
  headRef: string;
  baseRef: string;
  error: string | null;
  recon: Recon | null;
  files: PrFile[];
  stack: StackPr[];
  runs: ClaudeRun[];
  readAt: string | null;
  verdict: Verdict | null;
  reviewSummary: string | null;
  coverage: string | null;
  findings: Finding[];
  postedEvent: ReviewEvent | null;
  postedBody: string | null;
  ghReviewId: number | null;
  parentReviewId: number | null;
  priorStatus: PriorStatus[];
  /** Set when the step that failed ran out of turns. */
  turnLimit: TurnLimitStop | null;
  /** "Ask Claude about this PR" thread on the overview. */
  prMessages: FindingMessage[];
  /** Self-review: the user's checkout the branch came from. */
  localPath: string | null;
  includeDirty: boolean;
  dirtyFiles: number;
  /** Self-review: "What reviewers will ask". */
  reviewerQuestions: ReviewerQuestion[];
  /** Set when this review is a layer of a stack that's running Review all (the stack owns the run). */
  runningStack: { id: number; title: string; pos: number; size: number } | null;
}

export interface PrCheck {
  name: string;
  state: string; // SUCCESS | FAILURE | PENDING | SKIPPED | NEUTRAL | ...
  url: string | null;
}

export interface PrStatus {
  state: string; // OPEN | CLOSED | MERGED
  isDraft: boolean;
  headSha: string;
  reviewDecision: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
  mergeable: string; // MERGEABLE | CONFLICTING | UNKNOWN
  mergeStateStatus: string;
  checks: PrCheck[];
  reviews: Array<{ author: string; state: string; submittedAt: string }>;
  viewer: string;
  newCommitsSinceReview: boolean;
}

export interface StatsBucket {
  key: string;
  total: number;
  accepted: number;
  dismissed: number;
}

export interface Stats {
  reviews: number;
  submitted: number;
  findings: number;
  accepted: number;
  dismissed: number;
  bySeverity: StatsBucket[];
  byLens: StatsBucket[];
  recentDismissals: Array<{ title: string; lens: string | null; reason: string | null; repo: string; prNumber: number }>;
  estCostUsd: number;
  claudeMinutes: number;
}

export interface InboxPr {
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  updatedAt: string;
  isDraft: boolean;
}

/** An inbox PR plus the latest local review of it, if any. */
export type InboxEntry = InboxPr & {
  /** Set when the PR is part of a stack of open PRs. */
  stack?: StackBadge | null;
  review: { id: number; phase: Phase; headSha: string } | null;
  /** Who asked for your review, and when (assigned PRs only; null if GitHub didn't say). */
  requestedBy?: string | null;
  requestedAt?: string | null;
};

/** A repo in the switcher: ones you've reviewed in or been asked to review in, most recent first. */
export interface RepoOption {
  name: string; // owner/name
  /** Open PR count; null if GitHub couldn't be asked. */
  openCount: number | null;
  activity: { kind: "reviewed" | "requested" | "added"; at: string };
}

export interface Inbox {
  /** PRs waiting on your review, across every repo. */
  assigned: InboxEntry[];
  repos: RepoOption[];
  /** Repo of the most recent review, the default selection. */
  lastRepo: string | null;
  latestReviewId: number | null;
}

/** Latest self-review of a branch or PR, for the "Your branches" list. */
export interface SelfReviewState {
  id: number;
  phase: Phase;
  runNumber: number;
  findingsTotal: number;
  findingsUndecided: number;
  findingsOpen: number;
  openedPrNumber: number | null;
}

export interface SelfBranch {
  name: string;
  /** PR title if there's a PR, else the latest commit subject. */
  title: string;
  /** Commits ahead of origin's default branch. */
  ahead: number;
  current: boolean;
  /** Uncommitted files; only known for the checked-out branch. */
  dirtyFiles: number;
  pushed: boolean;
  upstream: string | null;
  updatedAt: string;
  pr: { number: number; isDraft: boolean; title: string } | null;
  review: SelfReviewState | null;
}

export interface MyPr {
  number: number;
  title: string;
  isDraft: boolean;
  headRefName: string;
  updatedAt: string;
  url: string;
}

/** What you could self-review in a repo: branches in your checkout, and your open PRs. */
export interface SelfSources {
  repo: string;
  /** Your checkout of the repo, if one was found. */
  localPath: string | null;
  defaultBase: string;
  bases: string[];
  branches: SelfBranch[];
  prs: Array<MyPr & { review: SelfReviewState | null }>;
}

export interface SuggestedReviewer {
  /** GitHub login, or `@org/team`. */
  handle: string;
  why: string;
}

/** A scan or deep review running right now, for the rail spinner and live cards. */
export interface ActiveRun {
  reviewId: number;
  repo: string;
  prNumber: number;
  title: string;
  author: string;
  mode: ReviewMode;
  headRef: string;
  stage: "recon" | "review";
  /** When the current run started (ISO). */
  startedAt: string;
  lines: Array<{ text: string; tool?: string; at: number }>;
}

/** Live events pushed over the websocket, scoped to one review. */
export type LiveEvent =
  | { type: "progress"; reviewId: number; runKind: ClaudeRun["kind"]; text: string; tool?: string; at: number }
  | { type: "phase"; reviewId: number; phase: Phase; error?: string | null }
  | { type: "run"; reviewId: number; run: ClaudeRun }
  | { type: "finding"; reviewId: number; findingId: number }
  | { type: "chat"; reviewId: number };

export type Stage = "recon" | "review" | "qa";
/** Claude: low…max. Codex: minimal…high. */
export type Effort = "default" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** The coding agent that runs reviews. */
export type Provider = "claude" | "codex";

/** An agent as found on this machine, for Settings. */
export interface AgentInfo {
  key: Provider;
  label: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  signedIn: boolean;
  account: string | null;
  plan: string | null;
  loginCmd: string;
  installCmd: string;
}

/** Per-agent choices shown in Settings. */
export interface ProviderOptions {
  label: string;
  hint: string;
  models: ModelOption[];
  efforts: Array<{ key: Effort; label: string }>;
  defaults: { models: Record<Stage, string>; effort: Record<Stage, Effort> };
}

export interface Settings {
  /** Which agent runs reviews. `models` and `effort` are for this agent. */
  provider: Provider;
  models: Record<Stage, string>;
  effort: Record<Stage, Effort>;
  /** Hours without activity before a review's checkout is removed. */
  worktreeTtlHours: number;
  /** Feed past dismissals for the repo into the review prompt. */
  dismissalMemory: boolean;
  /** How many past dismissals to include. */
  dismissalMemoryLimit: number;
  /** How far up/down the stack to load neighbour PR context. */
  stackContextDepth: number;
  /** Safety cap on Claude's tool-use turns for the deep review. */
  reviewMaxTurns: number;
  /** Turn cap for the overview. It uses no tools, so turns are only for retrying its answer. */
  reconMaxTurns: number;
  /** Stacks: which end Review all starts from. */
  stackOrder: "base" | "top";
  /** Stacks: deep reviews in parallel during Review all (1–3). */
  stackConcurrency: number;
  /** Stacks: Review all is offered for stacks this size or smaller. */
  stackMaxAll: number;
  /** Stacks: include layers already approved, merged or reviewed by you. */
  stackIncludeDone: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  note: string;
}

// ---------- one-time setup ----------

export interface GhInfo {
  installed: boolean;
  path: string | null;
  version: string | null;
  signedIn: boolean;
  user: string | null;
  /** Classic token scopes; empty when gh doesn't report them (e.g. a fine-grained GH_TOKEN). */
  scopes: string[];
  /** Scopes PR Bunny needs that the token lacks. Only checked when `scopes` is known. */
  missingScopes: string[];
  installCmd: string;
  loginCmd: string;
}

export interface CliInfo {
  name: string;
  /** Where the command is linked, e.g. `~/.local/bin/bunny`. */
  path: string;
  /** What the link points at: the installed binary, or bin/bunny.ts from source. */
  target: string;
  linked: boolean;
  /** Something else already at `path` (a file, or a link elsewhere); installing asks to replace it. */
  conflict: string | null;
  /** Whether the link's folder is on your login shell's PATH; null if unknown. Set by the setup checks. */
  onPath?: boolean | null;
}

export interface SetupChecks {
  agents: AgentInfo[];
  gh: GhInfo;
  cli: CliInfo;
}

export interface SetupRepo {
  repo: string; // owner/name
  path: string;
  /** `path` with ~ for home, for display. */
  displayPath: string;
  branch: string | null;
  /** `added`: saved in setup before; `found`: a checkout in the usual code folders. */
  source: "added" | "found";
  /** Saved choice: a file path, null = none. Undefined when never chosen (found automatically). */
  reviewSkill?: string | null;
}

export interface SkillCandidate {
  path: string;
  kind: "skill" | "command" | "section" | "instructions" | "docs";
  /** Why it matched: "Claude skill · review-pr", "“Code review” section", "Contributing guide"… */
  why: string;
  /** The best match (the first found, in the order of the locations list). */
  suggested: boolean;
}

export interface RepoSkills {
  repo: string;
  /** The ref the files were read from, e.g. `origin/main`. */
  ref: string;
  /** The default branch's name, e.g. `main`. */
  branch: string;
  candidates: SkillCandidate[];
  suggested: string | null;
}

export interface SkillPreview {
  path: string;
  lines: string[];
  truncated: boolean;
}

export interface SetupConfig {
  provider: Provider;
  models: Record<Stage, string>;
  effort: Record<Stage, Effort>;
  gh: { path: string | null; user: string | null };
  cli: { installed: boolean; path: string };
  repos: Array<{ repo: string; path: string; reviewSkill: string | null }>;
  onboardedAt: string;
}

export interface SetupState {
  completedAt: string | null;
  config: SetupConfig | null;
  /** Current settings, to prefill the agent step. */
  defaults: { provider: Provider; models: Record<Stage, string>; effort: Record<Stage, Effort> };
  /** Where review instructions are looked for, in order. */
  skillLocations: string[];
  /** The code folders searched for checkouts (only ones that exist). */
  searchRoots: string[];
  /** Where the finished setup is written, e.g. `~/.pr-bunny/config.json`. */
  configPath: string;
}

// ---------- updates ----------

export interface ReleaseInfo {
  version: string;
  /** The release's codename, e.g. "Clover". */
  name: string;
  notesUrl: string | null;
  publishedAt: string | null;
}

export interface UpdateState {
  status: "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "restarting" | "error" | "unsupported";
  current: { version: string; name: string };
  latest: ReleaseInfo | null;
  checkedAt: string | null;
  /** Download progress, 0–100. */
  progress: number;
  error: string | null;
  /** Why updates can't be installed here (running from source, turned off…). */
  note: string | null;
}

export interface SetupInput {
  provider: Provider;
  models?: Partial<Record<Stage, string>>;
  effort?: Partial<Record<Stage, Effort>>;
  installCli: boolean;
  /** Replace whatever is already at the command's path. */
  replaceCli?: boolean;
  /** `reviewSkill`: a file path from the repo's skill list, or null for generic criteria. */
  repos: Array<{ path: string; reviewSkill: string | null }>;
}

// ---------- stacks ----------

export type LayerState =
  | "waiting"
  | "scanning"
  | "readable"
  | "reviewing"
  | "decide"
  | "submitted"
  | "approved"
  | "failed"
  | "changed"
  | "merged"
  | "skipped";

export interface StackLayer {
  pr: number;
  title: string;
  author: string;
  headRef: string;
  baseRef: string;
  /** The PR this one is based on; null when it's on the base branch. */
  parentPr: number | null;
  /** 1 = on the base branch. */
  depth: number;
  additions: number;
  deletions: number;
  isDraft: boolean;
  url: string;
  /** Your own PR: reviewed as a self-review, never posted. */
  mine: boolean;
  state: LayerState;
  reviewId: number | null;
  /** Finding counts from this layer's own review (superseded ones left out). */
  counts: Record<Severity, number>;
  total: number;
  decided: number;
  /** Stack findings that involve this layer. */
  across: number;
  summary: string | null;
  /** Why it's changed / merged / failed, in a sentence. */
  note: string | null;
  /** The latest progress line while it's running. */
  line: { text: string; at: number } | null;
  startedAt: string | null;
  skipped: boolean;
}

export type StackFindingKind = "relies" | "repeated" | "fixed" | "breaks";

export interface StackFinding {
  id: number;
  kind: StackFindingKind;
  severity: Severity;
  lens: string | null;
  title: string;
  why: string;
  fix: string | null;
  fixedNote: string | null;
  fixedIn: number | null;
  /** Every PR it involves, base first. */
  prs: number[];
  confidence: "high" | "medium" | "low" | null;
  agentPrompt: string | null;
  /** Where it's posted: one finding per PR, decided together. */
  placements: Array<{ pr: number; findingId: number; reviewId: number; path: string | null; line: number | null; comment: string }>;
  decision: "accepted" | "dismissed" | null;
  dismissReason: string | null;
  soft: boolean;
}

export interface StackDetail {
  id: number;
  repo: string;
  baseRef: string;
  title: string;
  /** Layers in stack order: base first, children after their parent. */
  layers: StackLayer[];
  runState: "idle" | "running" | "paused";
  cross: { state: "pending" | "running" | "done" | "failed"; error: string | null; findings: StackFinding[]; lines: Array<{ text: string; at: number }> };
  /** Review all is offered for stacks this size or smaller (Settings › Stacks). */
  maxAll: number;
  order: "base" | "top";
  concurrency: number;
  /** Rough minutes left for the layers still to review. */
  minutesLeft: number | null;
  postedAt: string | null;
  summaryOn: boolean;
  summaryText: string;
  updatedAt: string;
}

export interface StackSummary {
  id: number;
  repo: string;
  title: string;
  baseRef: string;
  topRef: string;
  size: number;
  states: LayerState[];
  runState: StackDetail["runState"];
  running: boolean;
  /** "3 PRs ready to post", "Reviewing #1482 (2 of 5)"… */
  detail: string;
  updatedAt: string;
}

export interface StackSubmissionLayer {
  pr: number;
  reviewId: number;
  mine: boolean;
  /** Can be posted now (peer review with a finished deep review, not posted yet). */
  canPost: boolean;
  suggestedEvent: ReviewEvent;
  event: ReviewEvent;
  comments: number;
  undecided: number;
  /** Self-review: findings still to fix. */
  openFindings: number;
}

/** Where a PR sits in its stack, for badges ("2 of 5"). */
export interface StackBadge {
  pos: number;
  size: number;
  /** The saved stack this PR is a layer of (null until the stack's been opened). */
  stackId: number | null;
  /** That stack is running Review all, so it owns this PR's review. */
  running: boolean;
}
