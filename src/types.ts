// Data model for livecapture.
//
// A session is one conversation. It has a sensitivity tier that drives
// every downstream decision (transcription path, retention, sharing).
// Chunks are appended to a session as the conversation runs.

export type SensitivityTier = "public" | "work" | "sensitive";

export type TranscriptionPath = "workers-ai" | "local-whisper" | "external-api";

export type SessionStatus = "open" | "closed" | "archived";

export interface CaptureSession {
  /** UUID; primary key. */
  id: string;
  /** Human-friendly label set at session-start ("wally-call", "racine-roadmap"). */
  label: string;
  /** Drives transcription path, retention, sharing. Set at session-start, immutable. */
  sensitivity: SensitivityTier;
  /** Whether the other party was disclosed-to. Operator's declaration. */
  consented_recording: boolean;
  /** Capture client identifier (host + process). */
  client_id: string;
  /** ISO timestamp. */
  started_at: string;
  /** ISO timestamp; null while open. */
  ended_at: string | null;
  status: SessionStatus;
  /** Free-text context the operator can add at session-start or end. */
  notes: string | null;
}

export interface AudioChunk {
  /** UUID. */
  id: string;
  session_id: string;
  /** Monotonic per-session, starts at 0. */
  sequence: number;
  /** R2 object key for the raw audio bytes. */
  r2_key: string;
  /** Bytes. */
  size_bytes: number;
  /** Duration in milliseconds of THIS chunk. */
  duration_ms: number;
  /** ISO timestamp of recording start (relative to wall clock). */
  recorded_at: string;
  /** Format (webm/opus, wav, mp3, etc.). */
  mime_type: string;
}

export interface TranscriptSegment {
  /** UUID. */
  id: string;
  session_id: string;
  chunk_id: string;
  /** Monotonic per-session. */
  sequence: number;
  /** Start offset within the chunk, in milliseconds. */
  start_ms: number;
  /** End offset within the chunk, in milliseconds. */
  end_ms: number;
  /** The transcribed text. */
  text: string;
  /** Speaker label if diarization is on; "unknown" otherwise. */
  speaker: string;
  /** Transcription engine that produced this. */
  engine: TranscriptionPath;
  /** Engine confidence 0..1 if reported; null otherwise. */
  confidence: number | null;
  /** ISO timestamp the transcript was written. */
  transcribed_at: string;
}

/** The KV value pointing at the currently-open session, if any. */
export interface ActiveSessionPointer {
  session_id: string;
  started_at: string;
  client_id: string;
}

/** Read-API: shape of "get current conversation" response. */
export interface CurrentConversationResponse {
  session: CaptureSession | null;
  recent_segments: TranscriptSegment[];
  segment_count_total: number;
}

/** Read-API: shape of search response. */
export interface SearchResponse {
  query: string;
  matches: Array<{
    segment: TranscriptSegment;
    session_label: string;
    session_started_at: string;
  }>;
  total: number;
}

/** Internal envelope for an ingest request. */
export interface IngestRequest {
  session_id: string;
  sequence: number;
  recorded_at: string;
  mime_type: string;
  /** Audio bytes arrive as binary body, not in JSON. This envelope is for metadata. */
}

/** Worker bindings (set in wrangler.toml). */
export interface Env {
  RAW_AUDIO: R2Bucket;
  CAPTURE_DB: D1Database;
  SESSION_STATE: KVNamespace;
  AI: Ai;
  /** CF Access JWT verification — set when Access is in front of the Worker. */
  ACCESS_AUD: string;
}
