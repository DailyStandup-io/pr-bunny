-- One-time setup. Repos the user added (or confirmed) in setup; NULL = only seen through reviews.
ALTER TABLE repos ADD COLUMN added_at TEXT;
-- repos.skill_path (from schema.sql) now means: NULL = find the review skill automatically,
-- '' = none (generic criteria), else that file on the default branch.

-- The saved setup: a single row, rewritten each time setup is completed.
CREATE TABLE onboarding (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  completed_at  TEXT NOT NULL,
  config_json   TEXT NOT NULL
);
