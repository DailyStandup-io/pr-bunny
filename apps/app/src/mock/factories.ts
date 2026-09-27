// Factories that write fixture reviews, findings, stacks, hidden inbox items, notifications and the
// setup row into PR Bunny's database, through the app's own db module (so tests get the throwaway
// PR_BUNNY_HOME from src/server/test-setup.ts). Pass `db` to write into another database opened with
// the app's `openDb`. The demo's lived-in scenario (src/mock/scenario.ts) is built from these.
import type { Database } from "bun:sqlite";
import type { NotifyKind, Phase, ReviewEvent, SetupConfig } from "../shared/types";
import { parseDiff, snippetFromDiff, snippetFromFile, validateAnchor } from "../server/anchors";
import { db as appDb } from "../server/db/db";
import type { OpenPr } from "../server/gh";
import { findStack } from "../server/stack";
import { unit } from "./agent";
import { saveSession } from "./agent";
import {
  findingOutput,
  findPr,
  headSha,
  minutesAgoIso,
  prBaseFiles,
  prChange,
  prHeadFiles,
  prsOf,
  prUrl,
  prViewJson,
  reconRecord,
  stackOutput,
  stackPrs,
  VIEWER,
  type FixturePr,
  type FixtureStack,
  type ShaMap,
} from "./fixtures";
import type { ScriptFinding } from "./types";
import { lines } from "./diff";

export interface Ctx {
  /** Defaults to the app's database. */
  db?: Database;
  /** "Now" for relative timestamps (default Date.now()). */
  now?: number;
  /** Real commit SHAs from src/mock/git.ts; tests without git get pseudo SHAs. */
  shas?: ShaMap;
}

const dbOf = (ctx: Ctx) => ctx.db ?? appDb;
const nowOf = (ctx: Ctx) => ctx.now ?? Date.now();

/** SQLite's datetime('now') format (UTC, no zone), `minutes` before now. */
export const sqlTime = (minutes: number, now = Date.now()) =>
  new Date(now - minutes * 60_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");

// ---------- repos ----------

export function ensureRepo(repo: string, opts: { localPath?: string | null; added?: boolean; skillPath?: string | null } = {}, ctx: Ctx = {}): number {
  const db = dbOf(ctx);
  const [owner, name] = repo.split("/") as [string, string];
  db.run("INSERT INTO repos (owner, name) VALUES (?, ?) ON CONFLICT (owner, name) DO NOTHING", [owner, name]);
  if (opts.localPath !== undefined) db.run("UPDATE repos SET local_path = ? WHERE owner = ? AND name = ?", [opts.localPath, owner, name]);
  if (opts.skillPath !== undefined) db.run("UPDATE repos SET skill_path = ? WHERE owner = ? AND name = ?", [opts.skillPath, owner, name]);
  if (opts.added) db.run("UPDATE repos SET added_at = COALESCE(added_at, ?) WHERE owner = ? AND name = ?", [sqlTime(60 * 24 * 20, nowOf(ctx)), owner, name]);
  return (db.query("SELECT id FROM repos WHERE owner = ? AND name = ?").get(owner, name) as { id: number }).id;
}

// ---------- findings ----------

export type Decision = "accepted" | "dismissed" | null | ["dismissed", string] | ["accepted", "soft"];

export interface FindingsOpts {
  pr: FixturePr;
  /** The commit the review looked at (default: the PR's head). */
  upTo?: number;
  self?: boolean;
  /** One per finding, in order; missing = undecided. */
  decisions?: Decision[];
  /** Mark accepted, anchorable findings as posted (a submitted review). */
  posted?: boolean;
  /** Minutes ago the decisions were made. */
  decidedMinutesAgo?: number;
}

/**
 * Stores scripted findings the way the deep review does (deep.ts insertFindings): anchors validated
 * against the diff, and code outside the diff captured as a snippet so it shows without a checkout.
 */
export function makeFindings(reviewId: number, findings: ScriptFinding[], opts: FindingsOpts, ctx: Ctx = {}): number[] {
  const db = dbOf(ctx);
  const diff = parseDiff(prChange(opts.pr, opts.upTo).diff);
  const head = prHeadFiles(opts.pr, opts.upTo);
  const base = prBaseFiles(opts.pr);
  const start = (db.query("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM findings WHERE review_id = ?").get(reviewId) as { n: number }).n;
  const ids: number[] = [];
  findings.forEach((f, i) => {
    const out = findingOutput(f, head, base, `${opts.pr.repo}#${opts.pr.number}`, Boolean(opts.self)) as ReturnType<typeof findingOutput> & { prompt?: string };
    const a = validateAnchor(diff, { path: out.path, line: out.line, startLine: out.startLine, side: out.side });
    let snippet: string | null = null;
    if (!snippetFromDiff(diff, a) && a.path && a.line) {
      const text = head.get(a.path);
      if (text) {
        const from = Math.max(1, (a.startLine ?? a.line) - 4);
        snippet = JSON.stringify(snippetFromFile(lines(text).slice(from - 1, a.line + 4), from, { from: a.startLine ?? a.line, to: a.line }));
      }
    }
    const d = opts.decisions?.[i] ?? null;
    const decision = Array.isArray(d) ? d[0] : d;
    const reason = Array.isArray(d) && d[0] === "dismissed" ? d[1] : null;
    const soft = Array.isArray(d) && d[1] === "soft" ? 1 : 0;
    const posted = opts.posted && decision === "accepted" && a.anchorable ? 1 : 0;
    const { id } = db
      .query(
        `INSERT INTO findings (review_id, position, severity, lens, title, path, line, start_line, side, why, fix, comment, confidence, anchorable,
                               file_snippet_json, agent_prompt, decision, dismiss_reason, decided_at, posted, soft)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        reviewId, start + i, out.severity, out.lens, out.title, a.path, a.line, a.startLine, a.side, out.why, out.fix, out.comment, out.confidence,
        a.anchorable ? 1 : 0, snippet, out.prompt ?? null, decision, reason, decision ? sqlTime((opts.decidedMinutesAgo ?? 30) - i, nowOf(ctx)) : null, posted, soft,
      ) as { id: number };
    ids.push(id);
  });
  return ids;
}

// ---------- reviews ----------

export interface ReviewOpts {
  pr: FixturePr | { repo: string; number: number };
  phase: Phase;
  /** Default: self when the viewer wrote the PR. */
  mode?: "peer" | "self";
  /** Review of an earlier commit (1 = after the first commit). Default: the head. */
  upTo?: number;
  /** Override the reviewed commit id (e.g. "old", so the PR looks changed since). */
  headSha?: string;
  /** Store the overview. Default: yes, unless the phase is recon_running or it was stopped/failed during the overview. */
  recon?: boolean;
  /** Store the deep review's findings. Default: for walkthrough and submitted. */
  findings?: boolean;
  decisions?: Decision[];
  posted?: { event: ReviewEvent; minutesAgo: number };
  startedMinutesAgo?: number;
  readMinutesAgo?: number | null;
  error?: string | null;
  /** Agent runs to record (for Analytics and the run list). Default: what the phase implies. */
  runs?: Array<{ kind: "recon" | "review" | "qa"; status?: "success" | "error"; error?: string; maxTurns?: number; hitTurnLimit?: boolean; sessionId?: string | null }>;
  /** The deep review's agent session (Q&A forks it). Seeded as a mock session file when the demo state is available. */
  sessionId?: string | null;
  parentReviewId?: number | null;
  cleared?: boolean;
}

const OPEN_PRS = (repo: string, shas?: ShaMap): OpenPr[] =>
  prsOf(repo)
    .filter((p) => p.state === "OPEN")
    .map((p) => ({ number: p.number, title: p.title, headRefName: p.branch, baseRefName: p.base, headRefOid: headSha(p, shas), author: p.author, isDraft: Boolean(p.draft) }));

/** A review of a fixture PR in any phase, with its overview, findings, stack links and agent runs. */
export function makeReview(opts: ReviewOpts, ctx: Ctx = {}): number {
  const db = dbOf(ctx);
  const now = nowOf(ctx);
  const pr = "title" in opts.pr ? opts.pr : findPr(opts.pr.repo, opts.pr.number);
  if (!pr) throw new Error(`No fixture PR ${opts.pr.repo}#${opts.pr.number}`);
  const upTo = opts.upTo ?? pr.commits.length;
  const change = prChange(pr, upTo);
  const mode = opts.mode ?? (pr.author === VIEWER.login ? "self" : "peer");
  const repoId = ensureRepo(pr.repo, {}, ctx);
  const started = opts.startedMinutesAgo ?? 60;
  const hasRecon = opts.recon ?? (opts.phase !== "recon_running" && !(opts.phase === "failed" && !opts.findings && opts.runs?.every((r) => r.kind === "recon")));
  const recon = hasRecon && pr.recon ? reconRecord(pr.recon, change.files) : null;
  const script = opts.upTo && opts.upTo < pr.commits.length ? pr.review : (pr.rereview && opts.parentReviewId ? pr.rereview : pr.review);
  const withFindings = opts.findings ?? (opts.phase === "walkthrough" || opts.phase === "submitted");

  const { id } = db
    .query(
      `INSERT INTO reviews (repo_id, pr_number, title, author, url, head_sha, head_ref, base_ref, additions, deletions, changed_files, phase, error,
                            files_json, recon_json, reviewer_questions_json, diff_text, mode, started_at, read_at, parent_review_id, cleared_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      repoId, pr.number, pr.title, pr.author, prUrl(pr), opts.headSha ?? headSha(pr, ctx.shas, upTo), pr.branch, pr.base, change.additions, change.deletions, change.files.length,
      opts.phase, opts.error ?? null, JSON.stringify(change.files), recon ? JSON.stringify(recon) : null,
      mode === "self" && recon && pr.recon?.questions ? JSON.stringify(pr.recon.questions.map(([question, hint]) => ({ question, hint }))) : null,
      recon || opts.phase !== "recon_running" ? change.diff : null, mode, sqlTime(started, now),
      opts.readMinutesAgo === null ? null : withFindings || opts.phase === "reviewing" || opts.phase === "cancelled" ? sqlTime(opts.readMinutesAgo ?? started - 3, now) : null,
      opts.parentReviewId ?? null, opts.cleared ? sqlTime(5, now) : null,
    ) as { id: number };

  // The stack around it, as the overview saves it.
  if (pr.state === "OPEN") {
    const insertLink = db.prepare("INSERT OR REPLACE INTO stack_links (review_id, pr_number, relation, depth, title, head_ref, base_ref) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const s of findStack({ number: pr.number, headRefName: pr.branch, baseRefName: pr.base }, OPEN_PRS(pr.repo, ctx.shas)))
      insertLink.run(id, s.number, s.relation, s.depth, s.title, s.headRef, s.baseRef);
  }

  if (withFindings && script) {
    makeFindings(id, script.findings, { pr, upTo, self: mode === "self", decisions: opts.decisions, posted: Boolean(opts.posted), decidedMinutesAgo: Math.max(1, started - 10) }, ctx);
    db.run("UPDATE reviews SET verdict = ?, review_summary = ?, coverage = ? WHERE id = ?", [script.verdict, script.summary, script.coverage, id]);
  }
  const sessionId = opts.sessionId === undefined ? (withFindings ? `seed-${pr.repo.replace("/", "-")}-${pr.number}-${id}` : null) : opts.sessionId;
  if (sessionId) db.run("UPDATE reviews SET review_session_id = ? WHERE id = ?", [sessionId, id]);
  // So asking about a finding (which forks this session) knows which PR it's about.
  if (sessionId && withFindings) seedSession(sessionId, pr, mode === "self" ? "self-review" : "review", 0, true);
  if (opts.posted) {
    db.run("UPDATE reviews SET posted_event = ?, posted_body = review_summary, submitted_at = ?, gh_review_id = ? WHERE id = ?", [
      opts.posted.event,
      sqlTime(opts.posted.minutesAgo, now),
      2900000 + id,
      id,
    ]);
  }

  // Agent runs: the overview, then the deep review, as the phase implies.
  const runs =
    opts.runs ??
    [
      ...(recon || opts.phase === "recon_running" ? [{ kind: "recon" as const, status: opts.phase === "recon_running" ? undefined : ("success" as const) }] : []),
      ...(withFindings ? [{ kind: "review" as const, status: "success" as const, sessionId }] : []),
    ];
  runs.forEach((r, i) => {
    const u = unit(`${pr.repo}#${pr.number}:${r.kind}:${i}`);
    const isRecon = r.kind === "recon";
    const status = r.status ?? "running";
    const done = status !== "running";
    db.run(
      `INSERT INTO claude_runs (review_id, kind, session_id, model, status, cost_usd, duration_ms, input_tokens, output_tokens, error, max_turns, hit_turn_limit, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, r.kind, r.sessionId ?? (isRecon ? null : sessionId), isRecon ? "sonnet" : "opus", status,
        done ? Math.round((isRecon ? 0.03 + 0.04 * u : 0.6 + 1.1 * u) * 10000) / 10000 : null,
        done ? Math.round(isRecon ? 14_000 + 12_000 * u : 110_000 + 190_000 * u) : null,
        done ? Math.round(isRecon ? 9_000 + 6_000 * u : 60_000 + 90_000 * u) : null,
        done ? Math.round(isRecon ? 900 + 500 * u : 3_000 + 4_000 * u) : null,
        r.error ?? null, r.maxTurns ?? (isRecon ? 10 : 250), r.hitTurnLimit ? 1 : 0, sqlTime(Math.max(0, started - (isRecon ? 0 : 2)), now),
      ],
    );
  });
  return id;
}

// ---------- stacks ----------

export interface StackOpts {
  stack: FixtureStack;
  /** Layer reviews by PR number (missing = not reviewed yet). */
  reviews?: Record<number, number>;
  runState?: "idle" | "running" | "paused";
  /** Run and store the across-the-stack output (placed on layers whose reviews are still to decide). */
  cross?: "done" | "failed" | "stopped" | null;
  updatedMinutesAgo?: number;
}

/** A saved stack (Stacks page) from a fixture stack, its layers linked to the given reviews. */
export function makeStack(opts: StackOpts, ctx: Ctx = {}): number {
  const db = dbOf(ctx);
  const now = nowOf(ctx);
  const prs = stackPrs(opts.stack);
  const root = prs[0]!;
  const repoId = ensureRepo(opts.stack.repo, {}, ctx);
  const { id } = db
    .query(
      `INSERT INTO stacks (repo_id, root_pr, base_ref, title, run_state, cross_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, root_pr) DO UPDATE SET run_state = excluded.run_state, cross_state = excluded.cross_state RETURNING id`,
    )
    .get(repoId, root.number, root.base, root.title, opts.runState ?? "idle", opts.cross ?? null, sqlTime((opts.updatedMinutesAgo ?? 30) + 60, now), sqlTime(opts.updatedMinutesAgo ?? 30, now)) as { id: number };
  prs.forEach((pr, i) => {
    const change = prChange(pr);
    db.run(
      `INSERT OR REPLACE INTO stack_layers (stack_id, pr_number, depth, parent_pr, title, author, head_ref, base_ref, head_sha, additions, deletions, is_draft, gh_state, review_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [id, pr.number, i + 1, i ? prs[i - 1]!.number : null, pr.title, pr.author, pr.branch, pr.base, headSha(pr, ctx.shas), change.additions, change.deletions, pr.draft ? 1 : 0, opts.reviews?.[pr.number] ?? null],
    );
  });
  if (opts.cross === "done") makeCrossFindings(id, opts.stack, opts.reviews ?? {}, ctx);
  return id;
}

/** The across-the-stack findings, stored the way stacks.ts saveCross does (placements + superseded per-layer findings). */
export function makeCrossFindings(stackId: number, stack: FixtureStack, reviews: Record<number, number>, ctx: Ctx = {}) {
  const db = dbOf(ctx);
  const reviewIds = Object.values(reviews);
  const ids = new Map<string, number>();
  if (reviewIds.length)
    for (const f of db.query(`SELECT id, title FROM findings WHERE review_id IN (${reviewIds.map(() => "?").join(",")}) AND stack_finding_id IS NULL`).all(...reviewIds) as Array<{ id: number; title: string }>)
      ids.set(f.title, f.id);
  const out = stackOutput(stack, ids);
  db.run("DELETE FROM stack_findings WHERE stack_id = ?", [stackId]);
  out.findings.forEach((f, i) => {
    const { id: sfId } = db
      .query(
        `INSERT INTO stack_findings (stack_id, position, kind, severity, lens, title, why, fix, fixed_note, fixed_in, prs_json, confidence, agent_prompt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(stackId, i, f.kind, f.severity, f.lens, f.title, f.why, f.fix, f.fixedNote, f.fixedIn, JSON.stringify(f.prs), f.confidence, f.prompt) as { id: number };
    for (const p of f.placements) {
      const reviewId = reviews[p.pr];
      if (!reviewId) continue;
      const pr = findPr(stack.repo, p.pr)!;
      const a = validateAnchor(parseDiff(prChange(pr).diff), { path: p.path, line: p.line, startLine: null, side: p.path && p.line ? "RIGHT" : null });
      const { n } = db.query("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM findings WHERE review_id = ?").get(reviewId) as { n: number };
      db.run(
        `INSERT INTO findings (review_id, position, severity, lens, title, path, line, side, why, fix, comment, confidence, anchorable, agent_prompt, stack_finding_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [reviewId, n, f.severity, f.lens, f.title, p.path, p.line, p.path && p.line ? "RIGHT" : null, f.why, f.fix, p.comment, f.confidence, a.anchorable ? 1 : 0, f.prompt, sfId],
      );
    }
    if (f.replaces.length)
      db.run(`UPDATE findings SET superseded_by = ? WHERE id IN (${f.replaces.map(() => "?").join(",")})`, [sfId, ...f.replaces]);
  });
}

/** Decides a stack finding for every PR it's placed on (like decideStackFinding). */
export function decideCross(stackId: number, title: string, decision: "accepted" | "dismissed", opts: { soft?: boolean; reason?: string; minutesAgo?: number } = {}, ctx: Ctx = {}) {
  const db = dbOf(ctx);
  const sf = db.query("SELECT id FROM stack_findings WHERE stack_id = ? AND title = ?").get(stackId, title) as { id: number } | null;
  if (!sf) throw new Error(`No stack finding "${title}"`);
  db.run("UPDATE findings SET decision = ?, dismiss_reason = ?, soft = ?, decided_at = ? WHERE stack_finding_id = ?", [
    decision,
    decision === "dismissed" ? (opts.reason ?? null) : null,
    opts.soft ? 1 : 0,
    sqlTime(opts.minutesAgo ?? 30, nowOf(ctx)),
    sf.id,
  ]);
}

// ---------- inbox, notifications, setup ----------

/** Hides PRs from the inbox: "change" = until it changes (stamped with its current updatedAt), "good" = for good. */
export function seedHidden(items: Array<{ pr: FixturePr; mode: "change" | "good"; minutesAgo?: number }>, ctx: Ctx = {}) {
  const db = dbOf(ctx);
  const now = nowOf(ctx);
  for (const { pr, mode, minutesAgo } of items)
    db.run(
      `INSERT INTO inbox_hidden (key, mode, stamp, title, meta, hidden_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET mode = excluded.mode, stamp = excluded.stamp`,
      [`pr:${pr.repo}#${pr.number}`, mode, mode === "change" ? minutesAgoIso(pr.updatedMinutesAgo, now) : null, pr.title, `${pr.repo} #${pr.number} · ${pr.author}`, sqlTime(minutesAgo ?? 60, now)],
    );
}

/**
 * Reviews for the PRs the inbox shows, in the given phases (plus hidden items). Returns the review
 * ids by PR number. This is the inbox half of the lived-in demo; tests use it to get badges.
 */
export function seedInbox(
  entries: Array<{ pr: FixturePr } & Omit<ReviewOpts, "pr">>,
  hidden: Parameters<typeof seedHidden>[0] = [],
  ctx: Ctx = {},
): Record<string, number> {
  const ids: Record<string, number> = {};
  for (const e of entries) ids[`${e.pr.repo}#${e.pr.number}`] = makeReview(e, ctx);
  seedHidden(hidden, ctx);
  return ids;
}

export interface SeedNotification {
  kind: NotifyKind;
  title: string;
  body: string;
  summary: string;
  pr?: FixturePr;
  reviewId?: number;
  stackId?: number;
  href?: string;
  face: string;
  minutesAgo: number;
  seen?: boolean;
  read?: boolean;
}

export function seedNotifications(items: SeedNotification[], ctx: Ctx = {}) {
  const db = dbOf(ctx);
  const now = nowOf(ctx);
  for (const [i, n] of items.entries()) {
    const at = sqlTime(n.minutesAgo, now);
    db.run(
      `INSERT INTO notifications (kind, title, body, summary, subject, repo, pr_number, review_id, stack_id, href, tag, face, dedupe_key, created_at, seen_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        n.kind, n.title, n.body, n.summary, n.pr?.title ?? "", n.pr?.repo ?? null, n.pr?.number ?? null, n.reviewId ?? null, n.stackId ?? null,
        n.href ?? (n.reviewId ? `/review/${n.reviewId}` : n.stackId ? `/stack/${n.stackId}` : n.pr ? prUrl(n.pr) : "/"),
        n.pr ? `pr:${n.pr.repo}#${n.pr.number}` : n.stackId ? `stack:${n.stackId}` : `seed:${i}`, n.face, `seed:${n.kind}:${i}:${n.minutesAgo}`, at,
        n.seen || n.read ? at : null, n.read ? at : null,
      ],
    );
  }
}

/** Finished setup: the onboarding row, repos with their checkouts, and config.json-shaped config. */
export function seedOnboarding(repos: Array<{ repo: string; path: string; reviewSkill?: string | null }>, ctx: Ctx = {}): SetupConfig {
  const db = dbOf(ctx);
  const now = nowOf(ctx);
  for (const r of repos) ensureRepo(r.repo, { localPath: r.path, added: true, skillPath: r.reviewSkill === undefined ? null : (r.reviewSkill ?? "") }, ctx);
  const config: SetupConfig = {
    provider: "claude",
    models: { recon: "sonnet", review: "opus", qa: "opus" },
    effort: { recon: "default", review: "default", qa: "default" },
    gh: { path: "gh", user: VIEWER.login },
    cli: { installed: false, path: "~/.local/bin/bunny" },
    repos: repos.map((r) => ({ repo: r.repo, path: r.path, reviewSkill: r.reviewSkill ?? null })),
    notifications: null,
    onboardedAt: new Date(now - 20 * 86_400_000).toISOString(),
  };
  db.run("INSERT OR REPLACE INTO onboarding (id, completed_at, config_json) VALUES (1, ?, ?)", [config.onboardedAt, JSON.stringify(config)]);
  return config;
}

/**
 * A mock agent session, so Continue / Resume / Q&A on a seeded review pick up where the "earlier"
 * run left off. Needs the mock state folder (PR_BUNNY_MOCK_STATE); a no-op in tests without it.
 */
export function seedSession(id: string, pr: FixturePr, stage: "review" | "recon" | "self-review", step: number, done: boolean) {
  if (!process.env.PR_BUNNY_MOCK_STATE) return;
  saveSession({ id, stage, repo: pr.repo, pr: pr.number, branch: null, finding: null, step, done });
}

export { prViewJson };
