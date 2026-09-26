// One-time setup: what's installed and signed in, which repos and review skills to use, and saving
// it all as one config. Reads only, except on "Finish setup": settings, repos and the `bunny` link.
import { $ } from "bun";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { GhInfo, Provider, SetupChecks, SetupConfig, SetupInput, SetupRepo, SetupState } from "../shared/types";
import { detectAgents } from "./agents";
import { subscriptionEnv } from "./claude";
import { cliInfo, linkCli, linkDirOnPath, unlinkCli } from "./cli";
import { DATA_DIR } from "./config";
import { db } from "./db/db";
import { checkoutInfo, headBranch, scanCheckouts, SEARCH_ROOTS } from "./local";
import { checkSkillPath, defaultRef, listFiles, locationLabels } from "./skills";
import { applySettings, getSettings, NOTIFY_KINDS, updateSettings } from "./settings";

const tildify = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
const untildify = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Scopes the app's `gh` calls need: private repos and posting reviews, and org team lookups. */
const NEEDED_SCOPES = ["repo", "read:org"];

export async function ghInfo(): Promise<GhInfo> {
  const base: GhInfo = { installed: false, path: null, version: null, signedIn: false, user: null, scopes: [], missingScopes: [], installCmd: "brew install gh", loginCmd: "gh auth login" };
  const env = subscriptionEnv();
  const bin = Bun.which("gh", { PATH: env.PATH });
  if (!bin) return base;
  const [version, json] = await Promise.all([
    $`${bin} --version`.env(env).quiet().nothrow(),
    $`${bin} auth status --json hosts`.env(env).quiet().nothrow(),
  ]);
  const info: GhInfo = { ...base, installed: true, path: tildify(bin), version: version.stdout.toString().match(/\d+\.\d+\.\d+/)?.[0] ?? null };
  type Host = { state?: string; login?: string; scopes?: string; active?: boolean };
  let host: Host | undefined;
  try {
    const hosts = JSON.parse(json.stdout.toString()).hosts?.["github.com"] as Host[] | undefined;
    host = hosts?.find((h) => h.active) ?? hosts?.[0];
  } catch {
    // gh before `auth status --json`: read the text output (it goes to stderr).
    const text = await $`${bin} auth status --hostname github.com`.env(env).quiet().nothrow();
    const said = `${text.stdout.toString()}\n${text.stderr.toString()}`;
    const login = said.match(/Logged in to github\.com (?:account |as )(\S+)/)?.[1];
    host = login && text.exitCode === 0 ? { state: "success", login, scopes: said.match(/Token scopes: (.*)/)?.[1]?.replace(/'/g, "") } : undefined;
  }
  if (host?.state !== "success" || !host.login) return info;
  const scopes = (host.scopes ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { ...info, signedIn: true, user: host.login, scopes, missingScopes: scopes.length ? NEEDED_SCOPES.filter((s) => !scopes.includes(s)) : [] };
}

export async function setupChecks(): Promise<SetupChecks> {
  const [agents, gh, onPath] = await Promise.all([detectAgents(), ghInfo(), linkDirOnPath()]);
  return { agents, gh, cli: { ...cliInfo(), onPath } };
}

// ---------- repos ----------

/** A folder from the browser → the checkout it's in. Must be an existing git checkout with a GitHub origin. */
export async function resolveRepo(path: unknown): Promise<SetupRepo> {
  if (typeof path !== "string" || !path.trim()) throw new Error("Enter a folder path");
  const abs = resolve(untildify(path.trim()));
  if (!isAbsolute(abs) || !existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`${tildify(abs)} isn't a folder.`);
  const { repo, root } = await checkoutInfo(abs).catch((e: Error) => {
    throw new Error(e.message.includes("isn't inside") ? `${tildify(abs)} isn't a git repository.` : `${tildify(abs)} has no GitHub remote named origin.`);
  });
  const saved = savedRepos().find((r) => r.repo.toLowerCase() === repo.toLowerCase());
  return { repo, path: root, displayPath: tildify(root), branch: headBranch(root), source: saved ? "added" : "found", ...(saved ? { reviewSkill: saved.reviewSkill } : {}) };
}

function savedRepos(): Array<{ repo: string; path: string; reviewSkill: string | null | undefined }> {
  const rows = db
    .query("SELECT owner || '/' || name AS repo, local_path AS path, skill_path AS skill FROM repos WHERE added_at IS NOT NULL ORDER BY added_at, id")
    .all() as Array<{ repo: string; path: string | null; skill: string | null }>;
  return rows
    .filter((r): r is typeof r & { path: string } => Boolean(r.path))
    .map((r) => ({ repo: r.repo, path: r.path, reviewSkill: r.skill === null ? undefined : r.skill || null }));
}

/** Repos added in setup before (still on disk), then checkouts found in the usual code folders. */
export function setupRepos(): SetupRepo[] {
  const out: SetupRepo[] = savedRepos()
    .filter((r) => existsSync(join(r.path, ".git")))
    .map((r) => ({ repo: r.repo, path: r.path, displayPath: tildify(r.path), branch: headBranch(r.path), source: "added", ...(r.reviewSkill !== undefined ? { reviewSkill: r.reviewSkill } : {}) }));
  const known = new Set(out.map((r) => r.repo.toLowerCase()));
  for (const c of scanCheckouts()) {
    if (known.has(c.repo.toLowerCase())) continue;
    out.push({ repo: c.repo, path: c.root, displayPath: tildify(c.root), branch: headBranch(c.root), source: "found" });
  }
  return out;
}

/** The checkout a skill request is about. Only folders that are git checkouts, resolved like "Add folder". */
export async function checkoutFor(path: unknown): Promise<{ repo: string; root: string }> {
  const r = await resolveRepo(path);
  return { repo: r.repo, root: r.path };
}

// ---------- saving ----------

/** The finished setup, also written as a file (the database stays the source of truth). */
const CONFIG_FILE = join(DATA_DIR, "config.json");

/** "Create link" / "Replace" on the terminal step: links `bunny` right away. */
export async function setupLinkCli(replace: boolean) {
  return { ...linkCli({ replace }), onPath: await linkDirOnPath() };
}

/** The folder button: macOS's own folder picker, shown by the service (it runs as you). Null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (process.platform !== "darwin") throw new Error("The folder picker is macOS-only; type the path instead.");
  const script = 'POSIX path of (choose folder with prompt "Choose a checkout for PR Bunny")';
  const res = await $`osascript -e ${script}`.quiet().nothrow();
  if (res.exitCode !== 0) return null; // cancelled
  const path = res.stdout.toString().trim().replace(/\/$/, "");
  return path ? tildify(path) : null;
}

function savedConfig(): { completedAt: string; config: SetupConfig } | null {
  const row = db.query("SELECT completed_at AS completedAt, config_json AS json FROM onboarding WHERE id = 1").get() as { completedAt: string; json: string } | null;
  return row ? { completedAt: row.completedAt, config: JSON.parse(row.json) } : null;
}

export function setupState(): SetupState {
  const saved = savedConfig();
  const s = getSettings();
  return {
    completedAt: saved?.completedAt ?? null,
    config: saved?.config ?? null,
    defaults: { provider: s.provider, models: s.models, effort: s.effort },
    skillLocations: locationLabels(),
    searchRoots: SEARCH_ROOTS.filter((d) => existsSync(d)).map(tildify),
    configPath: tildify(CONFIG_FILE),
  };
}

/**
 * "Finish setup": checks everything first, then links (or unlinks) `bunny`, saves the agent choice,
 * the repos and their review skills, and the config. Throws before changing anything if a check fails.
 */
export async function completeSetup(input: SetupInput): Promise<SetupState> {
  const provider = input.provider as Provider;
  const checks = await setupChecks();
  const agent = checks.agents.find((a) => a.key === provider);
  if (!agent) throw new Error(`Unknown agent: ${input.provider}`);
  if (!agent.installed || !agent.signedIn) throw new Error(`${agent.label} isn't ${agent.installed ? "signed in" : "installed"} yet.`);
  if (!checks.gh.signedIn) throw new Error(checks.gh.installed ? "Sign in to GitHub with `gh auth login` first." : "Install the GitHub CLI (`brew install gh`) first.");
  if (!Array.isArray(input.repos)) throw new Error("Expected `repos`");
  if (input.repos.length > 200) throw new Error("Too many repos");

  const repos: SetupConfig["repos"] = [];
  for (const r of input.repos) {
    const { repo, path } = await resolveRepo(r?.path);
    if (repos.some((x) => x.repo.toLowerCase() === repo.toLowerCase())) throw new Error(`${repo} is in the list twice (${tildify(path)}).`);
    let reviewSkill: string | null = null;
    if (r.reviewSkill != null) {
      reviewSkill = checkSkillPath(r.reviewSkill);
      const { sha } = await defaultRef(path);
      if (!(await listFiles(path, sha)).includes(reviewSkill)) throw new Error(`${reviewSkill} isn't on ${repo}'s default branch.`);
    }
    repos.push({ repo, path, reviewSkill });
  }

  // Validate models/effort before changing anything, so a bad value leaves everything as it was.
  // The notifications step is optional: left out (skipped), the current notification settings stay.
  const notifications = input.notifications ? { desktop: Boolean(input.notifications.desktop), events: input.notifications.events ?? {} } : undefined;
  const settingsPatch = {
    provider,
    ...(input.models ? { models: input.models } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(notifications ? { notifications } : {}),
  } as Parameters<typeof updateSettings>[0];
  applySettings(getSettings(), settingsPatch);

  const cli = input.installCli ? linkCli({ replace: Boolean(input.replaceCli) }) : unlinkCli();
  const settings = updateSettings(settingsPatch);
  const completedAt = new Date().toISOString();
  const config: SetupConfig = {
    provider: settings.provider,
    models: settings.models,
    effort: settings.effort,
    gh: { path: checks.gh.path, user: checks.gh.user },
    cli: { installed: cli.linked, path: cli.path },
    repos: repos.map((r) => ({ ...r, path: tildify(r.path) })),
    notifications: notifications ? { desktop: settings.notifications.desktop, events: NOTIFY_KINDS.filter((k) => settings.notifications.events[k]) } : null,
    onboardedAt: completedAt,
  };

  const upsert = db.prepare(
    `INSERT INTO repos (owner, name, local_path, skill_path, added_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (owner, name) DO UPDATE SET local_path = excluded.local_path, skill_path = excluded.skill_path,
       added_at = COALESCE(repos.added_at, excluded.added_at)`,
  );
  const keep = new Set(repos.map((r) => r.repo.toLowerCase()));
  db.transaction(() => {
    for (const r of repos) {
      const [owner, name] = r.repo.split("/") as [string, string];
      upsert.run(owner, name, r.path, r.reviewSkill ?? "");
    }
    // Repos left out of the list are no longer "added"; their reviews and skill choice stay.
    for (const r of db.query("SELECT id, owner || '/' || name AS repo FROM repos WHERE added_at IS NOT NULL").all() as Array<{ id: number; repo: string }>) {
      if (!keep.has(r.repo.toLowerCase())) db.run("UPDATE repos SET added_at = NULL WHERE id = ?", [r.id]);
    }
    db.run(
      "INSERT INTO onboarding (id, completed_at, config_json) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET completed_at = excluded.completed_at, config_json = excluded.config_json",
      [completedAt, JSON.stringify(config)],
    );
  })();
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  return setupState();
}
