-- livecapture initial schema.
-- Matches src/types.ts. Sensitivity tier drives all downstream behavior.

CREATE TABLE IF NOT EXISTS capture_sessions (
  id                    TEXT PRIMARY KEY,
  label                 TEXT NOT NULL,
  sensitivity           TEXT NOT NULL CHECK (sensitivity IN ('public','work','sensitive')),
  consented_recording   INTEGER NOT NULL DEFAULT 0,
  client_id             TEXT NOT NULL,
  started_at            TEXT NOT NULL,
  ended_at              TEXT,
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
  notes                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status_started ON capture_sessions(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_sensitivity ON capture_sessions(sensitivity);

CREATE TABLE IF NOT EXISTS audio_chunks (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES capture_sessions(id) ON DELETE CASCADE,
  sequence              INTEGER NOT NULL,
  r2_key                TEXT NOT NULL UNIQUE,
  size_bytes            INTEGER NOT NULL,
  duration_ms           INTEGER NOT NULL,
  recorded_at           TEXT NOT NULL,
  mime_type             TEXT NOT NULL,
  UNIQUE (session_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_chunks_session_sequence ON audio_chunks(session_id, sequence);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES capture_sessions(id) ON DELETE CASCADE,
  chunk_id              TEXT NOT NULL REFERENCES audio_chunks(id) ON DELETE CASCADE,
  sequence              INTEGER NOT NULL,
  start_ms              INTEGER NOT NULL,
  end_ms                INTEGER NOT NULL,
  text                  TEXT NOT NULL,
  speaker               TEXT NOT NULL DEFAULT 'unknown',
  engine                TEXT NOT NULL CHECK (engine IN ('workers-ai','local-whisper','external-api')),
  confidence            REAL,
  transcribed_at        TEXT NOT NULL,
  UNIQUE (session_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_segments_session_sequence ON transcript_segments(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_segments_text ON transcript_segments(text);
