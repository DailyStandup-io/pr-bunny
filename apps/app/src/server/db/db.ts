import { Database } from "bun:sqlite";
import { DB_PATH } from "../config";
import schema from "./schema.sql" with { type: "text" };
import m002 from "./002_review.sql" with { type: "text" };
import m003 from "./003_cleanup.sql" with { type: "text" };
import m004 from "./004_settings.sql" with { type: "text" };
import m005 from "./005_run_turns.sql" with { type: "text" };
import m006 from "./006_pr_chat.sql" with { type: "text" };
import m007 from "./007_self_review.sql" with { type: "text" };
import m008 from "./008_onboarding.sql" with { type: "text" };
import m009 from "./009_stacks.sql" with { type: "text" };
import m010 from "./010_cancel_cleanup.sql" with { type: "text" };

/** Ordered migrations; index + 1 is the resulting `user_version`. Append only. */
const MIGRATIONS: string[] = [schema, m002, m003, m004, m005, m006, m007, m008, m009, m010];

export function openDb(path = DB_PATH): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database) {
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.run(MIGRATIONS[v]!);
      db.run(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

export const db = openDb();
