-- Stack review: a stack of PRs reviewed together. Each layer is an ordinary review; the stack
-- ties them together, runs "Review all", and holds findings that span layers.
CREATE TABLE stacks (
  id            INTEGER PRIMARY KEY,
  repo_id       INTEGER NOT NULL REFERENCES repos(id),
  -- The PR at the bottom of the stack (its base is the repo's base branch).
  root_pr       INTEGER NOT NULL,
  base_ref      TEXT NOT NULL,
  title         TEXT NOT NULL,
  -- idle | running | paused
  run_state     TEXT NOT NULL DEFAULT 'idle',
  -- The "across the stack" pass: null (not run) | running | done | failed
  cross_state   TEXT,
  cross_error   TEXT,
  summary_on    INTEGER NOT NULL DEFAULT 0,
  summary_text  TEXT,
  posted_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_id, root_pr)
);

CREATE TABLE stack_layers (
  stack_id    INTEGER NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
  pr_number   INTEGER NOT NULL,
  -- 1 = on the base branch; a child is one more than its parent.
  depth       INTEGER NOT NULL,
  -- The PR this one is based on (null = the base branch).
  parent_pr   INTEGER,
  title       TEXT NOT NULL,
  author      TEXT NOT NULL,
  head_ref    TEXT NOT NULL,
  base_ref    TEXT NOT NULL,
  head_sha    TEXT NOT NULL,
  additions   INTEGER NOT NULL DEFAULT 0,
  deletions   INTEGER NOT NULL DEFAULT 0,
  is_draft    INTEGER NOT NULL DEFAULT 0,
  -- open | merged | closed
  gh_state    TEXT NOT NULL DEFAULT 'open',
  review_id   INTEGER REFERENCES reviews(id),
  -- Chosen on the Submit tab (null = the suggestion).
  post_event  TEXT,
  skipped     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (stack_id, pr_number)
);

-- Findings that span layers: code one PR adds and another relies on, a problem a later PR fixes,
-- the same finding repeated in several layers, or layers that clash. They're posted as ordinary
-- findings (findings.stack_finding_id) on the PRs in post_to.
CREATE TABLE stack_findings (
  id           INTEGER PRIMARY KEY,
  stack_id     INTEGER NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  -- relies | repeated | fixed | breaks
  kind         TEXT NOT NULL,
  severity     TEXT NOT NULL,
  lens         TEXT,
  title        TEXT NOT NULL,
  why          TEXT NOT NULL,
  fix          TEXT,
  fixed_note   TEXT,
  fixed_in     INTEGER,
  prs_json     TEXT NOT NULL,
  confidence   TEXT,
  agent_prompt TEXT
);

ALTER TABLE findings ADD COLUMN stack_finding_id INTEGER REFERENCES stack_findings(id) ON DELETE CASCADE;
-- Accepted as a heads-up: posted, but doesn't count towards requesting changes.
ALTER TABLE findings ADD COLUMN soft INTEGER NOT NULL DEFAULT 0;
-- A per-layer finding that a stack finding absorbed (e.g. the same issue found in two layers).
ALTER TABLE findings ADD COLUMN superseded_by INTEGER REFERENCES stack_findings(id) ON DELETE SET NULL;
