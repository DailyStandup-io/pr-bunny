// Everything derived from the hand-written world (src/mock/world): file contents per branch, PR
// diffs and stats, finding line numbers, the JSON the fake `gh` prints, and the structured output
// the fake agents return. Pure and deterministic: no clock except the `now` passed in, no randomness.
import { createHash } from "node:crypto";
import type { PrFile, Recon } from "../shared/types";
import { groupAreas, heuristicMinutes } from "../server/areas";
import type { ReviewOutput, SelfReviewOutput } from "../server/prompts/review";
import type { StackOutput } from "../server/prompts/stack";
import { fileDiff, lines, stat } from "./diff";
import type { Anchor, Commit, Edit, FixtureBranch, FixturePr, FixtureRepo, FixtureStack, ReconScript, ReviewScript, ScriptFinding } from "./types";
import { apiBranches, apiPrs, apiRepo, refundsStack } from "./world/api";
import { checkoutPrs, checkoutRepo, checkoutStack } from "./world/checkout";
import { mobilePrs, mobileRepo } from "./world/mobile";
import { ORG, PEOPLE, VIEWER } from "./world/people";

export { ORG, PEOPLE, VIEWER };
export type { FixtureBranch, FixturePr, FixtureRepo, FixtureStack };

export const REPOS: FixtureRepo[] = [checkoutRepo, apiRepo, mobileRepo];
export const PRS: FixturePr[] = [...checkoutPrs, ...apiPrs, ...mobilePrs].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
export const BRANCHES: FixtureBranch[] = [...apiBranches];
export const STACKS: FixtureStack[] = [checkoutStack, refundsStack];

export const repoName = (r: FixtureRepo) => `${r.owner}/${r.name}`;
export const findRepo = (repo: string) => REPOS.find((r) => repoName(r).toLowerCase() === repo.toLowerCase()) ?? null;
export const findPr = (repo: string, number: number) => PRS.find((p) => p.repo.toLowerCase() === repo.toLowerCase() && p.number === number) ?? null;
export const findBranch = (repo: string, branch: string) => BRANCHES.find((b) => b.repo.toLowerCase() === repo.toLowerCase() && b.branch === branch) ?? null;
export const prsOf = (repo: string) => PRS.filter((p) => p.repo.toLowerCase() === repo.toLowerCase());
export const prUrl = (pr: { repo: string; number: number }) => `https://github.com/${pr.repo}/pull/${pr.number}`;

/** Stand-in commit ids for tests that don't build git repos. The demo uses real SHAs from src/mock/git.ts. */
export const pseudoSha = (key: string) => createHash("sha1").update(`pr-bunny-mock:${key}`).digest("hex");

// ---------- file states ----------

type Files = Map<string, string>;

export function applyEdits(files: Files, edits: Edit[], where: string): Files {
  const next = new Map(files);
  for (const e of edits) {
    if (e.remove) {
      if (!next.has(e.path)) throw new Error(`${where}: can't remove ${e.path}, it doesn't exist`);
      next.delete(e.path);
      continue;
    }
    if (e.add !== undefined) {
      next.set(e.path, e.add);
      continue;
    }
    let text = next.get(e.path);
    if (text === undefined) throw new Error(`${where}: can't edit ${e.path}, it doesn't exist`);
    for (const [find, replaceWith] of e.replace ?? []) {
      const at = text.indexOf(find);
      if (at < 0) throw new Error(`${where}: ${e.path} has no ${JSON.stringify(find.slice(0, 60))}`);
      if (text.indexOf(find, at + 1) >= 0) throw new Error(`${where}: ${e.path} has ${JSON.stringify(find.slice(0, 60))} more than once`);
      text = text.slice(0, at) + replaceWith + text.slice(at + find.length);
    }
    next.set(e.path, text);
  }
  return next;
}

const memo = new Map<string, Files>();
const cached = (key: string, make: () => Files) => memo.get(key) ?? (memo.set(key, make()), memo.get(key)!);

/** The default branch before any fixture PR (the "Initial import" commit). */
export const initialFiles = (repo: FixtureRepo): Files => cached(`init:${repoName(repo)}`, () => new Map(Object.entries(repo.files)));

/** Merged PRs, in the order they land on the default branch. */
export const mergedPrs = (repo: FixtureRepo) => prsOf(repoName(repo)).filter((p) => p.state === "MERGED");

/** The default branch today: the initial import plus every merged PR (squashed). */
export const mainFiles = (repo: FixtureRepo): Files =>
  cached(`main:${repoName(repo)}`, () => mergedPrs(repo).reduce((files, pr) => applyEdits(files, pr.commits.flatMap((c) => c.edits), `#${pr.number}`), initialFiles(repo)));

/** Where a PR branches from: merged and closed PRs from the initial import, open ones from their base branch now. */
export function prBaseFiles(pr: FixturePr): Files {
  const repo = findRepo(pr.repo)!;
  if (pr.state !== "OPEN") return initialFiles(repo);
  return branchFiles(repo, pr.base);
}

/** A PR's files after its first `upTo` commits (all by default). */
export function prHeadFiles(pr: FixturePr, upTo = pr.commits.length): Files {
  return cached(`head:${pr.repo}#${pr.number}@${upTo}`, () =>
    pr.commits.slice(0, upTo).reduce((files, c, i) => applyEdits(files, c.edits, `${pr.repo}#${pr.number} commit ${i + 1}`), prBaseFiles(pr)),
  );
}

export function branchFiles(repo: FixtureRepo, branch: string): Files {
  if (branch === repo.defaultBranch) return mainFiles(repo);
  const pr = prsOf(repoName(repo)).find((p) => p.branch === branch);
  if (pr) return prHeadFiles(pr);
  const local = findBranch(repoName(repo), branch);
  if (local) return cached(`branch:${repoName(repo)}:${branch}`, () => local.commits.reduce((f, c) => applyEdits(f, c.edits, branch), branchFiles(repo, local.base)));
  throw new Error(`${repoName(repo)} has no branch ${branch}`);
}

// ---------- diffs ----------

export interface Change {
  diff: string;
  files: PrFile[];
  additions: number;
  deletions: number;
}

export function diffFiles(before: Files, after: Files): Change {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  let diff = "";
  const files: PrFile[] = [];
  for (const path of paths) {
    const a = before.get(path) ?? null;
    const b = after.get(path) ?? null;
    if (a === b) continue;
    diff += fileDiff(path, a, b);
    files.push({ path, ...stat(a, b) });
  }
  return { diff, files, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) };
}

/** What `gh pr diff` shows: the head (after `upTo` commits) against where the PR branched. */
export const prChange = (pr: FixturePr, upTo = pr.commits.length): Change => diffFiles(prBaseFiles(pr), prHeadFiles(pr, upTo));

/** A local branch against its base. */
export const branchChange = (b: FixtureBranch): Change => {
  const repo = findRepo(b.repo)!;
  return diffFiles(branchFiles(repo, b.base), branchFiles(repo, b.branch));
};

// ---------- anchors ----------

/** The 1-based line containing `match` (exactly one), or throws: fixture anchors must be unambiguous. */
export function lineOf(files: Files, anchor: Anchor, where: string): { line: number; startLine: number | null } {
  const text = files.get(anchor.path);
  if (text === undefined) throw new Error(`${where}: ${anchor.path} doesn't exist`);
  const hits = lines(text)
    .map((l, i) => (l.includes(anchor.match) ? i + 1 : 0))
    .filter(Boolean);
  if (hits.length !== 1) throw new Error(`${where}: ${JSON.stringify(anchor.match)} is on ${hits.length} lines of ${anchor.path}`);
  const line = hits[0]!;
  return { line, startLine: anchor.span && anchor.span > 1 ? Math.max(1, line - anchor.span + 1) : null };
}

// ---------- agent output ----------

export type Target = { kind: "pr"; pr: FixturePr } | { kind: "branch"; branch: FixtureBranch };

export const targetRepo = (t: Target) => (t.kind === "pr" ? t.pr.repo : t.branch.repo);
export const targetLabel = (t: Target) => (t.kind === "pr" ? `${t.pr.repo}#${t.pr.number}` : `${t.branch.repo}:${t.branch.branch}`);
export const targetChange = (t: Target, upTo?: number) => (t.kind === "pr" ? prChange(t.pr, upTo) : branchChange(t.branch));
const targetHead = (t: Target, upTo?: number) => (t.kind === "pr" ? prHeadFiles(t.pr, upTo) : branchFiles(findRepo(t.branch.repo)!, t.branch.branch));
const targetBase = (t: Target) => (t.kind === "pr" ? prBaseFiles(t.pr) : branchFiles(findRepo(t.branch.repo)!, t.branch.base));

const fallbackLabel = (path: string) =>
  path === "(root)"
    ? "Repo root"
    : path
        .split("/")
        .at(-1)!
        .replace(/[-_]/g, " ")
        .replace(/^\w/, (c) => c.toUpperCase());

/** The overview's structured output (what the agent returns), for these area paths. */
export function reconOutput(script: ReconScript, areaPaths: string[], self: boolean) {
  const out = {
    headline: script.headline,
    summary: script.summary,
    intent: script.intent,
    areas: areaPaths.map((path) => ({ path, label: script.areas[path]?.[0] ?? fallbackLabel(path), note: script.areas[path]?.[1] ?? "Supporting changes" })),
    riskFlags: script.risks.map(([level, text]) => ({ level, text })),
    estReviewMinutes: script.minutes[0],
    estAssistedMinutes: script.minutes[1],
    estReasoning: script.estReasoning,
    focusPoints: script.focus,
  };
  return self ? { ...out, reviewerQuestions: (script.questions ?? []).map(([question, hint]) => ({ question, hint })) } : out;
}

/** The overview as the app stores it (`reviews.recon_json`), built the way saveRecon builds it. */
export function reconRecord(script: ReconScript, files: PrFile[]): Recon {
  const areas = groupAreas(files);
  const out = reconOutput(script, areas.map((a) => a.path), false);
  return {
    ...out,
    areas: areas.map((a, i) => ({ ...a, label: out.areas[i]!.label, note: out.areas[i]!.note })),
    heuristicMinutes: heuristicMinutes(files),
    diffTruncated: false,
  };
}

export function findingOutput(f: ScriptFinding, head: Files, base: Files, where: string, self: boolean) {
  const side = f.at ? (f.at.side ?? "RIGHT") : null;
  const pos = f.at ? lineOf(side === "LEFT" ? base : head, f.at, `${where} "${f.title}"`) : null;
  const out = {
    severity: f.severity,
    lens: f.lens,
    title: f.title,
    path: f.at?.path ?? null,
    line: pos?.line ?? null,
    startLine: pos?.startLine ?? null,
    side,
    why: f.why,
    fix: f.fix,
    comment: f.comment,
    confidence: f.confidence,
  };
  return self ? { ...out, prompt: f.prompt ?? `Fix this: ${f.title}. ${f.fix ?? ""}`.trim() } : out;
}

/** A deep review's structured output for a PR or branch, anchored on its head (after `upTo` commits). */
export function reviewOutput(t: Target, script: ReviewScript, opts: { self?: boolean; upTo?: number } = {}): ReviewOutput | SelfReviewOutput {
  const head = targetHead(t, opts.upTo);
  const base = targetBase(t);
  return {
    findings: script.findings.map((f) => findingOutput(f, head, base, targetLabel(t), Boolean(opts.self))) as ReviewOutput["findings"],
    verdict: script.verdict,
    summary: script.summary,
    coverage: script.coverage,
  };
}

/** The "across the stack" output. `idsByTitle` maps per-layer finding titles to the ids the app gave them. */
export function stackOutput(stack: FixtureStack, idsByTitle: Map<string, number> = new Map()): StackOutput {
  return {
    findings: stack.cross.findings.map((f) => ({
      kind: f.kind,
      prs: f.prs,
      severity: f.severity,
      lens: f.lens,
      title: f.title,
      why: f.why,
      fix: f.fix,
      fixedNote: f.fixedNote,
      fixedIn: f.fixedIn,
      confidence: f.confidence,
      placements: f.placements.map((p) => {
        const pr = findPr(stack.repo, p.pr)!;
        const pos = p.at ? lineOf(prHeadFiles(pr), p.at, `stack ${stack.name} "${f.title}"`) : null;
        return { pr: p.pr, path: p.at?.path ?? null, line: pos?.line ?? null, comment: p.comment };
      }),
      replaces: f.replaces.map((t) => idsByTitle.get(t)).filter((n): n is number => n != null),
      prompt: f.prompt,
    })),
  };
}

export const stackOf = (repo: string, prs: number[]) => STACKS.find((s) => s.repo.toLowerCase() === repo.toLowerCase() && prs.includes(s.root)) ?? null;

/** Every PR in a stack, base first (following base branches from the root). */
export function stackPrs(stack: FixtureStack): FixturePr[] {
  const out: FixturePr[] = [];
  let cur = findPr(stack.repo, stack.root);
  while (cur) {
    out.push(cur);
    const head: string = cur.branch;
    cur = prsOf(stack.repo).find((p) => p.base === head && p.state === "OPEN") ?? null;
  }
  return out;
}

// ---------- what `gh` reports ----------

export const minutesAgoIso = (minutes: number, now: number) => new Date(now - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

export interface ShaMap {
  /** `owner/name#123` → head; `owner/name#123@1` → after the first commit; `owner/name:branch` → branch tip. */
  [key: string]: string;
}

export const headSha = (pr: FixturePr, shas?: ShaMap, upTo = pr.commits.length) =>
  shas?.[upTo === pr.commits.length ? `${pr.repo}#${pr.number}` : `${pr.repo}#${pr.number}@${upTo}`] ?? pseudoSha(`${pr.repo}#${pr.number}@${upTo}`);

/** `gh pr view --json …` for every field the app asks for. */
export function prViewJson(pr: FixturePr, now: number, shas?: ShaMap, extraReviews: Array<{ author: string; state: string; submittedAt: string }> = []) {
  const change = prChange(pr);
  const checks = (pr.github?.checks ?? []).map(([name, state]) => ({
    __typename: "CheckRun",
    name,
    workflowName: "CI",
    status: state === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
    conclusion: state === "PENDING" ? "" : state,
    detailsUrl: `https://github.com/${pr.repo}/actions/runs/${pr.number}0${name.length}`,
  }));
  const reviews = [
    ...(pr.github?.reviews ?? []).map((r) => ({ author: { login: r.author }, state: r.state, submittedAt: minutesAgoIso(r.minutesAgo, now) })),
    ...extraReviews.map((r) => ({ author: { login: r.author }, state: r.state, submittedAt: r.submittedAt })),
  ];
  const latest = new Map(reviews.map((r) => [r.author.login, r]));
  const lastState = [...latest.values()].at(-1)?.state;
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: prUrl(pr),
    author: { login: pr.author, is_bot: pr.author.endsWith("[bot]") },
    isDraft: Boolean(pr.draft),
    state: pr.state,
    headRefName: pr.branch,
    headRefOid: headSha(pr, shas),
    baseRefName: pr.base,
    additions: change.additions,
    deletions: change.deletions,
    changedFiles: change.files.length,
    labels: (pr.labels ?? []).map((name) => ({ name })),
    files: change.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
    updatedAt: minutesAgoIso(pr.updatedMinutesAgo, now),
    createdAt: minutesAgoIso(pr.updatedMinutesAgo + 60 * 3, now),
    reviewDecision: extraReviews.length && lastState ? (lastState === "APPROVED" ? "APPROVED" : lastState === "CHANGES_REQUESTED" ? "CHANGES_REQUESTED" : (pr.github?.decision ?? "REVIEW_REQUIRED")) : (pr.github?.decision ?? "REVIEW_REQUIRED"),
    mergeable: pr.state === "OPEN" ? (pr.github?.mergeable ?? "MERGEABLE") : "UNKNOWN",
    mergeStateStatus: pr.state !== "OPEN" ? "UNKNOWN" : pr.draft ? "DRAFT" : checks.some((c) => c.conclusion === "FAILURE") ? "UNSTABLE" : "BLOCKED",
    statusCheckRollup: checks,
    latestReviews: [...latest.values()],
    reviewRequests: pr.requestedBy ? [{ login: VIEWER.login }] : [],
    assignees: pr.assigned ? [{ login: VIEWER.login }] : [],
    repository: { name: pr.repo.split("/")[1], nameWithOwner: pr.repo },
    commits: pr.commits.map((c, i) => ({ oid: headSha(pr, shas, i + 1), messageHeadline: c.message })),
  };
}

/** Everything in PRS whose commits apply cleanly, for the sanity test. Throws with the first problem. */
export function checkWorld(): void {
  for (const repo of REPOS) mainFiles(repo);
  for (const pr of PRS) for (let i = 1; i <= pr.commits.length; i++) prHeadFiles(pr, i);
  for (const b of BRANCHES) branchChange(b);
}

export type { Commit };
