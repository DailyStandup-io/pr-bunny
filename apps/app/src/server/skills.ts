// A repo's review skill: the file whose instructions become the deep review's criteria.
// Always read from the *default branch*, never the PR, so a PR can't rewrite the rules it's
// reviewed against. Setup lists candidates from the user's checkout; reviews read the choice
// from the app's own clone.
import { $ } from "bun";
import type { RepoSkills, SkillCandidate, SkillPreview } from "../shared/types";
import { db } from "./db/db";
import { defaultBase } from "./local";

/**
 * Where review instructions are looked for, best first (shown in setup as "Locations checked").
 * `section` files only count when they have a heading about review, and only that section is used.
 */
export const SKILL_LOCATIONS: Array<{ path: string; kind: SkillCandidate["kind"]; why: string; section?: boolean }> = [
  { path: ".claude/skills/pr-bunny/SKILL.md", kind: "skill", why: "Claude skill · pr-bunny" },
  { path: ".claude/skills/review-pr/SKILL.md", kind: "skill", why: "Claude skill · review-pr" },
  { path: ".claude/skills/code-review/SKILL.md", kind: "skill", why: "Claude skill · code-review" },
  { path: ".claude/skills/review/SKILL.md", kind: "skill", why: "Claude skill · review" },
  { path: ".claude/commands/review-pr.md", kind: "command", why: "Claude command · /review-pr" },
  { path: ".claude/commands/review.md", kind: "command", why: "Claude command · /review" },
  { path: "AGENTS.md", kind: "section", why: "Review section", section: true },
  { path: "CLAUDE.md", kind: "section", why: "Review section", section: true },
  { path: ".github/copilot-instructions.md", kind: "instructions", why: "Copilot instructions" },
  { path: "CONTRIBUTING.md", kind: "docs", why: "Contributing guide" },
  { path: "REVIEWING.md", kind: "docs", why: "Reviewing guide" },
  { path: "docs/code-review.md", kind: "docs", why: "Code review guide" },
];
export const locationLabels = () => SKILL_LOCATIONS.map((l) => (l.section ? `${l.path} (review section)` : l.path));

const isSectionFile = (path: string) => SKILL_LOCATIONS.some((l) => l.section && l.path.toLowerCase() === path.toLowerCase());

/** A Markdown heading about review ("## Code review", "# Reviewing PRs"), with the section under it. */
export function reviewSection(text: string): { heading: string; body: string } | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s+.*\breview/i.test(l) && !/\bpreview\b/i.test(l));
  if (start < 0) return null;
  const level = lines[start]!.match(/^#+/)![0].length;
  let end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l) && l.match(/^#+/)![0].length <= level);
  if (end < 0) end = lines.length;
  return { heading: lines[start]!.replace(/^#+\s+/, "").trim(), body: lines.slice(start, end).join("\n").trim() };
}

/**
 * The review-instruction files in a repo, in SKILL_LOCATIONS order; the first is suggested.
 * `read` fetches a file's text (only called for AGENTS.md / CLAUDE.md, to find a review section).
 */
export async function skillCandidates(files: string[], read: (path: string) => Promise<string | null>): Promise<SkillCandidate[]> {
  const byLower = new Map(files.map((f) => [f.toLowerCase(), f]));
  const out: SkillCandidate[] = [];
  for (const loc of SKILL_LOCATIONS) {
    const path = byLower.get(loc.path.toLowerCase());
    if (!path) continue;
    let why = loc.why;
    if (loc.section) {
      const section = reviewSection((await read(path)) ?? "");
      if (!section) continue;
      why = `\u201c${section.heading}\u201d section`;
    }
    out.push({ path, kind: loc.kind, why, suggested: out.length === 0 });
  }
  return out;
}

/** The criteria text from a chosen file: just the review section of AGENTS.md / CLAUDE.md if it has one. */
export const criteriaFrom = (path: string, text: string) => (isSectionFile(path) ? (reviewSection(text)?.body ?? text) : text);

/** A skill path from the browser: relative, inside the repo, no tricks. */
export function checkSkillPath(path: unknown): string {
  if (typeof path !== "string" || !path || path.length > 300 || path.startsWith("/") || path.startsWith("-") || path.split("/").includes("..") || /[\0\n]/.test(path)) {
    throw new Error("Invalid file path");
  }
  return path;
}

// ---------- reading a checkout's default branch ----------

/** File listings are cached per commit; a checkout's default branch rarely moves during setup. */
const listings = new Map<string, string[]>();

/** The ref for the default branch in a checkout: origin's if fetched, else the local branch. */
export async function defaultRef(root: string): Promise<{ ref: string; sha: string }> {
  const base = await defaultBase(root);
  for (const ref of [`origin/${base}`, base, "HEAD"]) {
    const res = await $`git rev-parse --verify --quiet ${`${ref}^{commit}`}`.cwd(root).quiet().nothrow();
    if (res.exitCode === 0) return { ref, sha: res.stdout.toString().trim() };
  }
  throw new Error(`${root} has no commits yet.`);
}

export async function listFiles(root: string, sha: string): Promise<string[]> {
  const key = `${root}\0${sha}`;
  const hit = listings.get(key);
  if (hit) return hit;
  const res = await $`git ls-tree -r --name-only -z ${sha}`.cwd(root).quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`Couldn't list files in ${root}: ${res.stderr.toString().trim()}`);
  const files = res.stdout.toString().split("\0").filter(Boolean);
  listings.set(key, files);
  return files;
}

async function readAt(root: string, sha: string, path: string): Promise<string | null> {
  const res = await $`git cat-file blob ${`${sha}:${path}`}`.cwd(root).quiet().nothrow();
  return res.exitCode === 0 ? res.stdout.toString() : null;
}

export async function repoSkills(repo: string, root: string): Promise<RepoSkills> {
  const { ref, sha } = await defaultRef(root);
  const candidates = await skillCandidates(await listFiles(root, sha), (p) => readAt(root, sha, p));
  return { repo, ref, branch: ref.replace(/^origin\//, ""), candidates, suggested: candidates[0]?.path ?? null };
}

/** Any file on the default branch whose path contains `q`; Markdown first. For "Choose another file…". */
export async function searchFiles(root: string, q: string, limit = 50): Promise<string[]> {
  const { sha } = await defaultRef(root);
  const needle = q.trim().toLowerCase();
  const text = /\.(md|mdc|markdown|txt)$/i;
  return (await listFiles(root, sha))
    .filter((f) => !needle || f.toLowerCase().includes(needle))
    .sort((a, b) => Number(!text.test(a)) - Number(!text.test(b)) || a.length - b.length)
    .slice(0, limit);
}

const PREVIEW_BYTES = 64 * 1024;

/** The first lines of a file on the default branch. It must be in the listing (no arbitrary reads). */
export async function previewSkill(root: string, path: string, lines = 20): Promise<SkillPreview> {
  checkSkillPath(path);
  const { sha } = await defaultRef(root);
  if (!(await listFiles(root, sha)).includes(path)) throw new Error(`${path} isn't on the default branch.`);
  const res = await $`git cat-file blob ${`${sha}:${path}`}`.cwd(root).quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`Couldn't read ${path}.`);
  const all = res.stdout.subarray(0, PREVIEW_BYTES).toString("utf8").split("\n");
  return { path, lines: all.slice(0, lines), truncated: all.length > lines || res.stdout.length > PREVIEW_BYTES };
}

// ---------- at review time ----------

/** The saved choice: undefined = find automatically, null = none (generic criteria), else a path. */
export function skillChoice(owner: string, repo: string): string | null | undefined {
  const row = db.query("SELECT skill_path FROM repos WHERE owner = ? AND name = ?").get(owner, repo) as { skill_path: string | null } | null;
  if (!row || row.skill_path === null) return undefined;
  return row.skill_path === "" ? null : row.skill_path;
}

export type ReviewSkill = { path: string; text: string } | { path: string; missing: true } | null;

/** The review criteria from the app's clone of the repo (`origin/HEAD` = the default branch). */
export async function readReviewSkill(clone: string, owner: string, repo: string): Promise<ReviewSkill> {
  const choice = skillChoice(owner, repo);
  if (choice === null) return null;
  const read = async (path: string) => {
    const res = await $`git show ${`origin/HEAD:${path}`}`.cwd(clone).quiet().nothrow();
    return res.exitCode === 0 ? res.stdout.toString() : null;
  };
  if (choice !== undefined) {
    const text = await read(choice);
    return text === null ? { path: choice, missing: true } : { path: choice, text: criteriaFrom(choice, text) };
  }
  // Never chosen: the same search setup does, best match first.
  const files = await $`git ls-tree -r --name-only -z origin/HEAD`.cwd(clone).quiet().nothrow();
  if (files.exitCode !== 0) return null;
  const [best] = await skillCandidates(files.stdout.toString().split("\0").filter(Boolean), read);
  const text = best ? await read(best.path) : null;
  return best && text !== null ? { path: best.path, text: criteriaFrom(best.path, text) } : null;
}
