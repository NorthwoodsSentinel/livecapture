-- 0003_fts5_search.sql
--
-- Replace LIKE %query% with proper full-text search using SQLite FTS5.
-- transcript_segments.id is a TEXT UUID so we can't use content-rowid linking;
-- denormalize text + segment_id into the FTS5 table and keep them in sync via
-- triggers. Backfill existing rows on apply.

CREATE VIRTUAL TABLE IF NOT EXISTS transcript_segments_fts
  USING fts5(text, segment_id UNINDEXED, tokenize = 'porter unicode61');

INSERT INTO transcript_segments_fts(text, segment_id)
  SELECT text, id FROM transcript_segments;

CREATE TRIGGER IF NOT EXISTS transcript_segments_ai
AFTER INSERT ON transcript_segments BEGIN
  INSERT INTO transcript_segments_fts(text, segment_id) VALUES (new.text, new.id);
END;

CREATE TRIGGER IF NOT EXISTS transcript_segments_ad
AFTER DELETE ON transcript_segments BEGIN
  DELETE FROM transcript_segments_fts WHERE segment_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS transcript_segments_au
AFTER UPDATE ON transcript_segments BEGIN
  DELETE FROM transcript_segments_fts WHERE segment_id = old.id;
  INSERT INTO transcript_segments_fts(text, segment_id) VALUES (new.text, new.id);
END;
