-- 0002_transcription_preference.sql
--
-- Reframe: sensitivity tier no longer dictates which transcription engine runs.
-- A new column transcription_preference is principal-set per session.
--   - 'hosted-ok'  → Workers AI inside the principal's CF tenant is permitted (default)
--   - 'local-only' → defer all transcription to the local-Whisper pickup pipeline
--
-- Sensitivity tier still drives non-transcription decisions (retention, sharing,
-- audit posture). Tenant boundary remains the hard floor: third-party APIs are
-- never used for sensitive regardless of preference.

ALTER TABLE capture_sessions
  ADD COLUMN transcription_preference TEXT NOT NULL DEFAULT 'hosted-ok'
  CHECK (transcription_preference IN ('hosted-ok', 'local-only'));

CREATE INDEX IF NOT EXISTS idx_sessions_preference ON capture_sessions(transcription_preference);
