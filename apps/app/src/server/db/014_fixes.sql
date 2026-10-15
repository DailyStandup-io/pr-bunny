-- Fixes: changes requested on one of your PRs, made by the agent in PR Bunny's own checkout for you
-- to approve (commit + push to the PR branch) or decline. One row per request you acted on.
CREATE TABLE fixes (
  id               INTEGER PRIMARY KEY,
  repo_id          INTEGER NOT NULL REFERENCES repos(id),
  pr_number        INTEGER NOT NULL,
  title            TEXT NOT NULL,
  url              TEXT NOT NULL,
  author           TEXT NOT NULL DEFAULT '',
  head_ref         TEXT,
  base_ref         TEXT,
  -- The PR commit the fix was made on; approving refuses if the PR moved on since.
  head_sha         TEXT,
  -- new | running | ready | failed | pushed | declined | skipped
  state            TEXT NOT NULL,
  error            TEXT,
  -- The "changes requested" reviews and their inline comments (JSON, FixRequest[]).
  requests_json    TEXT,
  worktree_path    TEXT,
  session_id       TEXT,
  summary          TEXT,
  commit_message   TEXT,
  addressed_json   TEXT,
  not_addressed_json TEXT,
  -- `git diff --cached --binary` of what the agent changed; applied again to commit it.
  diff_text        TEXT,
  files_json       TEXT,
  pushed_sha       TEXT,
  model            TEXT,
  cost_usd         REAL,
  duration_ms      INTEGER,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  log_path         TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at      TEXT,
  decided_at       TEXT
);
CREATE INDEX fixes_pr ON fixes (repo_id, pr_number);

-- A "changes requested" notification remembers the fix you chose for it, so the bell shows its state.
ALTER TABLE notifications ADD COLUMN fix_id INTEGER REFERENCES fixes(id);
