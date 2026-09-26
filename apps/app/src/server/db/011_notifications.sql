-- Notifications: what the bell shows (and what desktop alerts were raised for).
CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY,
  -- req | assign | stackUpd | myReview | overview | deep | failed | changed | all | across | update
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  repo        TEXT,
  pr_number   INTEGER,
  review_id   INTEGER,
  stack_id    INTEGER,
  -- Where a click goes: an app path, or a github.com URL.
  href        TEXT NOT NULL,
  tag         TEXT NOT NULL,
  face        TEXT NOT NULL,
  -- The same event is only recorded once.
  dedupe_key  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Seen: the bell was opened after it arrived. Read: it was clicked (or Mark all read).
  seen_at     TEXT,
  read_at     TEXT
);
CREATE INDEX notifications_created ON notifications (created_at);

-- What the GitHub pollers have already seen (review requests, reviews of your PRs, PR heads), so
-- only new things notify. Categories start with a silent baseline.
CREATE TABLE notify_seen (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL DEFAULT '',
  at     TEXT NOT NULL DEFAULT (datetime('now'))
);
