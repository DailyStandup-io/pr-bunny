-- The update popup and What's new (Settings › About): switches, which version's popup was
-- dismissed, and the last version whose notes were seen. Key/value, values JSON-encoded.
CREATE TABLE update_prefs (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
