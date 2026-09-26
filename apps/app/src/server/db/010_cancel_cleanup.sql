-- Stop and tidy up. A stopped run leaves its review in phase 'cancelled' (no schema change).
-- Removing a review (Remove, Clear all finished, auto-clear) only hides it: Undo clears this again.
-- Nothing on GitHub is touched either way.
ALTER TABLE reviews ADD COLUMN cleared_at TEXT;

-- PRs hidden from the inbox. `key` is `pr:owner/name#123`, `review:<id>` or `branch:owner/name:<branch>`.
-- mode 'change' = hidden until it changes (the row's timestamp moves past `stamp`); 'good' = until restored.
CREATE TABLE inbox_hidden (
  key        TEXT PRIMARY KEY,
  mode       TEXT NOT NULL,
  stamp      TEXT,
  title      TEXT NOT NULL,
  meta       TEXT,
  hidden_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Housekeeping preferences (Settings › Housekeeping): auto-clear finished reviews, keep failed ones.
CREATE TABLE housekeeping (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
