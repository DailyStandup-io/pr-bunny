// Preloaded by `bun test` (bunfig.toml): point the app at a throwaway data dir so tests never
// touch the real database, settings or checkouts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PR_BUNNY_HOME = mkdtempSync(join(tmpdir(), "pr-bunny-test-"));
