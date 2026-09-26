-- Self-review PR tracking: the PR's state when it was last fetched (PrSnapshot JSON, for the lists)
-- and the branch tip each run reviewed (to count commits pushed since).
ALTER TABLE reviews ADD COLUMN pr_snap_json TEXT;
ALTER TABLE reviews ADD COLUMN branch_sha TEXT;
