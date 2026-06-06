# Local-Whisper pickup pipeline

For sessions where the principal sets `transcription_preference: local-only`, the Worker stores audio chunks in R2 + D1 but does not call Workers AI. A local runner — eventually Whisper on the Surface Pro or Lares — polls the Worker for un-transcribed chunks, transcribes them with a model the principal controls, and posts segments back.

## Endpoints

All three routes live under `/local-pickup/*` and require a bearer token in the `LOCAL_PICKUP_TOKEN` Worker secret (separate from `INGEST_TOKEN` so the runner credential can be rotated independently). Token stored in 1P `Fleet-Shared/livecapture-local-pickup-token`.

### `GET /local-pickup/queue?limit=N`

Returns the next batch of audio chunks belonging to `local-only` sessions that have no transcript segment yet. Ordered by `recorded_at` ascending (oldest first — backfill-friendly).

Response shape:
```json
{
  "count": 3,
  "chunks": [
    {
      "chunk_id": "uuid",
      "session_id": "uuid",
      "sequence": 0,
      "mime_type": "audio/wav",
      "duration_ms": 30000,
      "recorded_at": "2026-06-06T20:00:00.000Z",
      "size_bytes": 960044,
      "audio_url": "/local-pickup/audio/<chunk_id>"
    }
  ]
}
```

`limit` defaults to 20, clamped to [1, 100].

### `GET /local-pickup/audio/:chunk_id`

Streams the raw audio bytes from R2. Same bearer auth. Returns the chunk's original `mime_type`, plus `X-Chunk-Id` and `X-Session-Id` headers for the runner's idempotency tracking.

### `POST /local-pickup/segments`

Body: `{ "segments": [ { "chunk_id", "text", "start_ms"?, "end_ms"?, "speaker"?, "confidence"? } ] }`

Inserts one or more transcript segments produced by the local runner. Each segment must reference a known `chunk_id`. The Worker computes `sequence` from the current state of `transcript_segments` for the chunk's session, so the runner doesn't need to track session-wide ordering. Idempotent at the `(session_id, sequence)` UNIQUE constraint — duplicate posts are skipped.

Response shape:
```json
{ "inserted": 3, "skipped": 0, "invalid": 0, "errors": [] }
```

## Runner contract (for the local-Whisper process)

A reference runner — eventually on the Surface Pro alongside Hermes 3 8B — does this loop:

```
loop:
  q = GET /local-pickup/queue?limit=20
  if q.count == 0: sleep(poll_interval); continue
  for chunk in q.chunks:
    bytes = GET /local-pickup/audio/{chunk.chunk_id}
    text = whisper.transcribe(bytes, language="en")   # or auto-detect
    segments.append({chunk_id, text, confidence: whisper.score})
  POST /local-pickup/segments { segments }
```

Polling cadence: 30s when idle, 0s when queue returns work (drain fast). Backoff to 5min if 5 consecutive errors.

## Why this shape

- **Pull, not push.** The runner is the active party; the Worker is passive. Means the runner can be down for hours without losing work — chunks queue up in D1, runner catches up on next poll.
- **No presigned URLs.** Worker serves audio bytes directly. Avoids signing-key management on the runner side and keeps the audit log unified (every fetch hits the Worker's request log).
- **Sequence computed server-side.** Runner doesn't need to know about session-wide ordering. Each chunk produces one segment for now; future versions could let Whisper emit multiple segments per chunk by extending the POST body shape.
- **Separate auth token.** `LOCAL_PICKUP_TOKEN` is independent from `INGEST_TOKEN` so the runner credential is scoped + revocable. Stored in 1P alongside the other fleet credentials per the credentials doctrine.

## What's left (not in this commit)

- The actual Whisper runner process. Surface Pro is the eventual home; for now `/local-pickup/queue` will return empty because all current sessions are `hosted-ok`.
- Retry/exponential-backoff in the runner.
- Diarization (speaker labels) beyond `unknown`.
- A `/local-pickup/heartbeat` endpoint so the Worker knows whether a runner is alive — useful for surfacing "your local pipeline is offline" if a session piles up un-transcribed chunks for > N hours.
- A per-segment `engine_meta` field on the segment table for runner version, model name, language, etc. Add when the runner ships.

— Margin, 2026-06-06
