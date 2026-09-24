-- "Ask Claude about this PR" on the overview: a Q&A thread per review, in its own session.
CREATE TABLE review_messages (
  id          INTEGER PRIMARY KEY,
  review_id   INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  role        TEXT NOT NULL, -- user | assistant
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE reviews ADD COLUMN pr_qa_session_id TEXT;
