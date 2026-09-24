ALTER TABLE reviews ADD COLUMN diff_text TEXT;
ALTER TABLE reviews ADD COLUMN worktree_path TEXT;
ALTER TABLE reviews ADD COLUMN merge_base TEXT;
ALTER TABLE reviews ADD COLUMN review_summary TEXT;
ALTER TABLE reviews ADD COLUMN coverage TEXT;
ALTER TABLE reviews ADD COLUMN posted_event TEXT;
ALTER TABLE reviews ADD COLUMN posted_body TEXT;
ALTER TABLE reviews ADD COLUMN parent_review_id INTEGER REFERENCES reviews(id);
ALTER TABLE reviews ADD COLUMN prior_status_json TEXT;

ALTER TABLE findings ADD COLUMN qa_session_id TEXT;
ALTER TABLE findings ADD COLUMN posted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE findings ADD COLUMN decided_at TEXT;
