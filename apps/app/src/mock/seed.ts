// Seeds the lived-in demo database. Run by scripts/demo.ts in a child process whose environment
// already points PR_BUNNY_HOME / PR_BUNNY_MOCK_STATE at the demo folder, so the app's db module
// opens the demo database. Prints the scenario (review and stack ids, cheat-sheet) as JSON.
//
//   bun src/mock/seed.ts --home <fake home> [--agent claude|codex]
import { ensureOrigins } from "./git";
import { seedLivedIn } from "./scenario";

if (!process.env.PR_BUNNY_HOME || !process.env.PR_BUNNY_MOCK_STATE || process.env.PR_BUNNY_DEMO !== "1") {
  console.error("seed.ts only runs inside a demo folder (PR_BUNNY_HOME, PR_BUNNY_MOCK_STATE and PR_BUNNY_DEMO=1). Use `bun run demo`.");
  process.exit(1);
}
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const home = arg("--home");
if (!home) {
  console.error("Missing --home");
  process.exit(1);
}

const shas = await ensureOrigins();
const out = seedLivedIn({ shas, home });
if (arg("--agent") === "codex") {
  const { updateSettings } = await import("../server/settings");
  updateSettings({ provider: "codex" });
}
console.log(JSON.stringify(out));
