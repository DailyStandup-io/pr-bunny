-- Self-review: checking your own branch (or PR) before anyone else sees it.
-- mode: 'peer' (reviewing someone's PR, posts to GitHub) | 'self' (private, never posts findings).
ALTER TABLE reviews ADD COLUMN mode TEXT NOT NULL DEFAULT 'peer';
-- The user's own checkout the branch came from, and whether uncommitted work was included.
ALTER TABLE reviews ADD COLUMN local_path TEXT;
ALTER TABLE reviews ADD COLUMN include_dirty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN dirty_files INTEGER NOT NULL DEFAULT 0;
-- Self-reviews are re-run in place after fixes; this counts the runs.
ALTER TABLE reviews ADD COLUMN run_number INTEGER NOT NULL DEFAULT 1;
-- "What reviewers will ask", from the self-review overview.
ALTER TABLE reviews ADD COLUMN reviewer_questions_json TEXT;
-- Set once "Open PR" has created the pull request.
ALTER TABLE reviews ADD COLUMN opened_pr_number INTEGER;

-- Per finding, for self-review: a ready-to-paste prompt for a coding agent, and what re-runs found.
ALTER TABLE findings ADD COLUMN agent_prompt TEXT;
ALTER TABLE findings ADD COLUMN resolved_run INTEGER;
ALTER TABLE findings ADD COLUMN still_open_run INTEGER;
ALTER TABLE findings ADD COLUMN still_note TEXT;
