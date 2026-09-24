-- The turn cap a Claude run was given, so a run that hits it can say so and be continued.
ALTER TABLE claude_runs ADD COLUMN max_turns INTEGER;
ALTER TABLE claude_runs ADD COLUMN hit_turn_limit INTEGER NOT NULL DEFAULT 0;
-- Runs from before this column existed reported the limit as their error text.
UPDATE claude_runs SET hit_turn_limit = 1 WHERE error = 'error_max_turns';
-- The overview was hard-capped at 4 turns until the cap became a setting.
UPDATE claude_runs SET max_turns = 4 WHERE kind = 'recon' AND max_turns IS NULL;
