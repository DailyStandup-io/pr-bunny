// The `bunny` terminal command: a symlink in ~/.local/bin to the app. Installed builds keep the
// binary in the data folder (~/.pr-bunny/bin/bunny, where updates replace it); from source the link
// points at bin/bunny.ts. Shared by `bunny setup` and the setup page. No app imports here beyond
// build info, so the terminal setup can load it without opening the database.
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CliInfo } from "../shared/types";
import { COMPILED } from "../build-info";

export const CLI_NAME = "bunny";
const BIN_DIR = resolve(import.meta.dir, "..", "..", "bin");
/** What the link points at: the running binary when installed, else the source entry point. */
export const CLI_TARGET = COMPILED ? process.execPath : join(BIN_DIR, `${CLI_NAME}.ts`);
export const CLI_LINK = join(homedir(), ".local", "bin", CLI_NAME);
/** Links earlier versions made: `rp` (review.pr) and `rb`/`rbot` in ~/.bun/bin, pointing at bin/<name>.ts. */
const LEGACY_LINKS = ["rp", "rb", "rbot"].map((n) => ({ link: join(homedir(), ".bun", "bin", n), target: join(BIN_DIR, `${n}.ts`) }));

const tildify = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

/** What's at `link`: null if nothing, else the symlink's target or "file"/"directory". */
function whatsAt(link: string): { symlink: string } | "file" | "directory" | null {
  try {
    const st = lstatSync(link);
    if (st.isSymbolicLink()) return { symlink: readlinkSync(link) };
    return st.isDirectory() ? "directory" : "file";
  } catch {
    return null;
  }
}

const linksTo = (link: string, target: string) => {
  const at = whatsAt(link);
  return typeof at === "object" && at !== null && resolve(dirname(link), at.symlink) === target;
};

/**
 * Whether the link's folder is on the PATH of the user's login shell (not this process's PATH:
 * launchd gives the service its own). Asked once per process; null if the shell didn't answer.
 */
let onPathCache: Promise<boolean | null> | null = null;
export function linkDirOnPath(): Promise<boolean | null> {
  onPathCache ??= (async () => {
    const shell = process.env.SHELL || "/bin/zsh";
    const proc = Bun.spawn([shell, "-lic", 'printf "\\n%s" "$PATH"'], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 4000 });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    // The last line is PATH; anything before it is the profile's own output.
    const dirs = out.trim().split("\n").pop()!.split(":").map((d) => d.replace(/\/+$/, ""));
    return dirs.includes(dirname(CLI_LINK));
  })().catch(() => null);
  return onPathCache;
}

export function cliInfo(): CliInfo {
  const at = whatsAt(CLI_LINK);
  const linked = linksTo(CLI_LINK, CLI_TARGET);
  const conflict = at === null || linked ? null : typeof at === "object" ? `${tildify(CLI_LINK)} → ${tildify(at.symlink)}` : `${tildify(CLI_LINK)} (a ${at})`;
  return { name: CLI_NAME, path: tildify(CLI_LINK), target: tildify(CLI_TARGET), linked, conflict };
}

/** Links the command. Throws if something else is there, unless `replace` (never a directory). */
export function linkCli(opts: { replace?: boolean } = {}): CliInfo {
  removeLegacyLinks();
  const info = cliInfo();
  if (info.linked) return info;
  if (info.conflict) {
    if (whatsAt(CLI_LINK) === "directory") throw new Error(`${info.path} is a directory; remove it by hand to install ${CLI_NAME}.`);
    if (!opts.replace) throw new Error(`Something else is already at ${info.path}. Replace it, or skip the command.`);
    unlinkSync(CLI_LINK);
  }
  mkdirSync(dirname(CLI_LINK), { recursive: true });
  symlinkSync(CLI_TARGET, CLI_LINK);
  return cliInfo();
}

/** Removes the command, only if the link is ours. */
export function unlinkCli(): CliInfo {
  if (linksTo(CLI_LINK, CLI_TARGET)) unlinkSync(CLI_LINK);
  return cliInfo();
}

/** Old names' links point at files that no longer exist; remove them if they're ours. */
export function removeLegacyLinks(dryRun = false) {
  if (dryRun) return;
  for (const { link, target } of LEGACY_LINKS) if (linksTo(link, target)) unlinkSync(link);
}
