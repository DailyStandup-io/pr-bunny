// Demo mode (PR_BUNNY_DEMO=1, set by `bun run demo`): the app runs unchanged against the fake `gh`,
// `claude` and `codex` in src/mock/bin. Refuses to start unless all three resolve there, so a demo
// can never reach real GitHub or a real agent. Deliberately imports nothing from the app, so the
// check runs before anything else touches disk.
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEMO = (process.env.PR_BUNNY_DEMO ?? process.env.REVIEW_PR_DEMO ?? process.env.REVIEW_DESK_DEMO) === "1";

/** The fakes, next to the app's source (a compiled build has no src/mock, so demo mode can't start there). */
export const MOCK_BIN = join(import.meta.dir, "..", "mock", "bin");

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** The tools demo mode needs to be fakes, and where each one resolves now (null = not found). */
export function demoToolProblems(path = process.env.PATH ?? ""): string[] {
  const bin = real(MOCK_BIN);
  const problems: string[] = [];
  for (const tool of ["gh", "claude", "codex"]) {
    const found = Bun.which(tool, { PATH: path });
    // Symlinks are followed (the demo links the fakes into its HOME so paths read like a real install).
    const target = found ? real(found) : null;
    if (!bin || !target || dirname(target) !== bin) problems.push(`${tool} resolves to ${target ?? found ?? "nothing"}, not ${MOCK_BIN}/${tool}`);
  }
  return problems;
}

if (DEMO) {
  const problems = demoToolProblems();
  if (problems.length) {
    console.error(`PR_BUNNY_DEMO=1 but the fake tools aren't first on PATH, so the demo could reach real GitHub or a real agent. Refusing to start.\n  ${problems.join("\n  ")}\nStart it with \`bun run demo\`.`);
    process.exit(1);
  }
}
