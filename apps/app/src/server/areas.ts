import type { PrFile } from "../shared/types";

export interface AreaGroup {
  path: string;
  files: number;
  additions: number;
  deletions: number;
}

/** Monorepo-ish roots where the interesting unit is one level deeper (services/api, packages/ui). */
const CONTAINER_DIRS = new Set(["services", "packages", "apps", "libs", "modules", "src", "infra", "docs", ".github"]);

/**
 * Groups changed files into areas: the owning package (e.g. `services/api`) plus the next
 * directory beneath it when that splits the change meaningfully.
 */
export function groupAreas(files: PrFile[]): AreaGroup[] {
  const fine = group(files, areaKey);
  // Too many slivers reads as noise — fall back to package level.
  return fine.length > 10 ? group(files, packageKey) : fine;
}

function group(files: PrFile[], keyOf: (path: string) => string): AreaGroup[] {
  const groups = new Map<string, AreaGroup>();
  for (const f of files) {
    const key = keyOf(f.path);
    const g = groups.get(key) ?? { path: key, files: 0, additions: 0, deletions: 0 };
    g.files++;
    g.additions += f.additions;
    g.deletions += f.deletions;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
}

function packageKey(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return "(root)";
  const depth = CONTAINER_DIRS.has(parts[0]!) ? 2 : 1;
  return parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
}

function areaKey(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return "(root)";
  let depth = CONTAINER_DIRS.has(parts[0]!) ? 2 : 1;
  // services/api/src/foo/bar.ts → services/api/src/foo; keep one meaningful level under the package.
  if (parts.length > depth + 1 && parts[depth] === "src") depth += 2;
  else if (parts.length > depth + 1) depth += 1;
  return parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
}

const TEST_RE = /(\.test\.|\.spec\.|__tests__|\/e2e\/|\.snap$)/;
const GENERATED_RE = /(\.lock$|lockfile|bun\.lockb?$|package-lock\.json$|\.min\.|\/generated\/|\.pb\.)/;

/**
 * Rough minutes to review carefully. Claude adjusts this; it's shown next to the adjusted
 * estimate so the heuristic stays honest.
 */
export function heuristicMinutes(files: PrFile[]): number {
  let lines = 0;
  let testLines = 0;
  for (const f of files) {
    if (GENERATED_RE.test(f.path)) continue;
    const n = f.additions + f.deletions;
    if (TEST_RE.test(f.path)) testLines += n;
    else lines += n;
  }
  const areas = groupAreas(files).length;
  // ~ 350 lines/hour of production code, tests at half weight, a context-switch cost per area.
  const minutes = (lines / 350) * 60 + (testLines / 700) * 60 + areas * 1.5 + 2;
  return Math.max(2, Math.round(minutes));
}
