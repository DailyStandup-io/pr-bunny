CREATE TABLE repos (
  id          INTEGER PRIMARY KEY,
  owner       TEXT NOT NULL,
  name        TEXT NOT NULL,
  local_path  TEXT,
  skill_path  TEXT,
  UNIQUE (owner, name)
);

CREATE TABLE reviews (
  id                 INTEGER PRIMARY KEY,
  repo_id            INTEGER NOT NULL REFERENCES repos(id),
  pr_number          INTEGER NOT NULL,
  title              TEXT NOT NULL,
  author             TEXT NOT NULL,
  url                TEXT NOT NULL,
  head_sha           TEXT NOT NULL,
  head_ref           TEXT NOT NULL,
  base_ref           TEXT NOT NULL,
  additions          INTEGER NOT NULL DEFAULT 0,
  deletions          INTEGER NOT NULL DEFAULT 0,
  changed_files      INTEGER NOT NULL DEFAULT 0,
  -- recon_running | recon_ready | read | reviewing | walkthrough | submitted | failed
  phase              TEXT NOT NULL,
  error              TEXT,
  files_json         TEXT,
  recon_json         TEXT,
  verdict            TEXT,
  review_session_id  TEXT,
  started_at         TEXT NOT NULL DEFAULT (datetime('now')),
  read_at            TEXT,
  submitted_at       TEXT,
  gh_review_id       INTEGER
);
CREATE INDEX reviews_by_pr ON reviews (repo_id, pr_number);

CREATE TABLE stack_links (
  review_id  INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  pr_number  INTEGER NOT NULL,
  relation   TEXT NOT NULL, -- parent | child
  depth      INTEGER NOT NULL,
  title      TEXT NOT NULL,
  head_ref   TEXT NOT NULL,
  base_ref   TEXT NOT NULL,
  PRIMARY KEY (review_id, pr_number)
);

CREATE TABLE findings (
  id               INTEGER PRIMARY KEY,
  review_id        INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  severity         TEXT NOT NULL,
  lens             TEXT,
  title            TEXT NOT NULL,
  path             TEXT,
  line             INTEGER,
  start_line       INTEGER,
  side             TEXT,
  why              TEXT NOT NULL,
  fix              TEXT,
  comment          TEXT NOT NULL,
  confidence       TEXT,
  anchorable       INTEGER NOT NULL DEFAULT 0,
  decision         TEXT, -- accepted | dismissed | null
  dismiss_reason   TEXT,
  carried_from_id  INTEGER REFERENCES findings(id)
);

CREATE TABLE finding_messages (
  id          INTEGER PRIMARY KEY,
  finding_id  INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  role        TEXT NOT NULL, -- user | assistant
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE claude_runs (
  id             INTEGER PRIMARY KEY,
  review_id      INTEGER REFERENCES reviews(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL, -- recon | review | qa
  session_id     TEXT,
  model          TEXT NOT NULL,
  status         TEXT NOT NULL, -- running | success | error
  cost_usd       REAL,
  duration_ms    INTEGER,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  error          TEXT,
  log_path       TEXT,
  started_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
