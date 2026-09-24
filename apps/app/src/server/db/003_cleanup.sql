-- Code around findings that sit outside the diff, captured at review time so the walkthrough
-- can still show it after the checkout has been cleaned up.
ALTER TABLE findings ADD COLUMN file_snippet_json TEXT;
