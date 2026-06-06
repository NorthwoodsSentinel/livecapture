// Shared helpers — auth, IDs, R2 keys, D1 helpers, KV helpers.

import type {
  Env,
  CaptureSession,
  AudioChunk,
  TranscriptSegment,
  ActiveSessionPointer,
  SensitivityTier,
  TranscriptionPreference,
} from "./types";

export class HttpError extends Error {
  constructor(public status: number, public body: string | object) {
    super(typeof body === "string" ? body : JSON.stringify(body));
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export function requireBearer(request: Request, env: Env): void {
  const expected = (env as unknown as { INGEST_TOKEN?: string }).INGEST_TOKEN;
  if (!expected) {
    throw new HttpError(503, { error: "service_misconfigured", detail: "INGEST_TOKEN not set" });
  }
  const got = request.headers.get("authorization") ?? "";
  if (!got.startsWith("Bearer ") || got.slice(7) !== expected) {
    throw new HttpError(401, { error: "unauthorized" });
  }
}

// ── IDs ──────────────────────────────────────────────────────────────────────

export const uuid = (): string => crypto.randomUUID();
export const nowIso = (): string => new Date().toISOString();

export function r2KeyFor(sessionId: string, sequence: number, mime: string): string {
  const ext = mimeToExt(mime);
  return `${sessionId}/${String(sequence).padStart(6, "0")}.${ext}`;
}

function mimeToExt(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("ogg") || mime.includes("opus")) return "ogg";
  if (mime.includes("flac")) return "flac";
  if (mime.includes("m4a") || mime.includes("mp4")) return "m4a";
  return "bin";
}

// ── D1 helpers ───────────────────────────────────────────────────────────────

const sessionCols =
  "id, label, sensitivity, transcription_preference, consented_recording, client_id, started_at, ended_at, status, notes";

export async function getSession(db: D1Database, id: string): Promise<CaptureSession | null> {
  const row = await db
    .prepare(`SELECT ${sessionCols} FROM capture_sessions WHERE id = ?`)
    .bind(id)
    .first<RawSession>();
  return row ? rowToSession(row) : null;
}

export async function insertSession(db: D1Database, s: CaptureSession): Promise<void> {
  await db
    .prepare(
      `INSERT INTO capture_sessions (id, label, sensitivity, transcription_preference, consented_recording, client_id, started_at, ended_at, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      s.id,
      s.label,
      s.sensitivity,
      s.transcription_preference,
      s.consented_recording ? 1 : 0,
      s.client_id,
      s.started_at,
      s.ended_at,
      s.status,
      s.notes,
    )
    .run();
}

export async function closeSession(db: D1Database, id: string, endedAt: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE capture_sessions SET ended_at = ?, status = 'closed' WHERE id = ? AND status = 'open'`,
    )
    .bind(endedAt, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function getChunkBySequence(
  db: D1Database,
  sessionId: string,
  sequence: number,
): Promise<AudioChunk | null> {
  const row = await db
    .prepare(
      `SELECT id, session_id, sequence, r2_key, size_bytes, duration_ms, recorded_at, mime_type
       FROM audio_chunks WHERE session_id = ? AND sequence = ?`,
    )
    .bind(sessionId, sequence)
    .first<RawChunk>();
  return row ? rowToChunk(row) : null;
}

export async function insertChunk(db: D1Database, c: AudioChunk): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audio_chunks (id, session_id, sequence, r2_key, size_bytes, duration_ms, recorded_at, mime_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(c.id, c.session_id, c.sequence, c.r2_key, c.size_bytes, c.duration_ms, c.recorded_at, c.mime_type)
    .run();
}

export async function getChunk(db: D1Database, id: string): Promise<AudioChunk | null> {
  const row = await db
    .prepare(
      `SELECT id, session_id, sequence, r2_key, size_bytes, duration_ms, recorded_at, mime_type
       FROM audio_chunks WHERE id = ?`,
    )
    .bind(id)
    .first<RawChunk>();
  return row ? rowToChunk(row) : null;
}

export async function insertSegment(db: D1Database, s: TranscriptSegment): Promise<void> {
  await db
    .prepare(
      `INSERT INTO transcript_segments
        (id, session_id, chunk_id, sequence, start_ms, end_ms, text, speaker, engine, confidence, transcribed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(s.id, s.session_id, s.chunk_id, s.sequence, s.start_ms, s.end_ms, s.text, s.speaker, s.engine, s.confidence, s.transcribed_at)
    .run();
}

export async function nextSegmentSequence(db: D1Database, sessionId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(MAX(sequence), -1) + 1 AS next FROM transcript_segments WHERE session_id = ?`)
    .bind(sessionId)
    .first<{ next: number }>();
  return row?.next ?? 0;
}

export async function recentSegments(
  db: D1Database,
  sessionId: string,
  limit: number,
): Promise<TranscriptSegment[]> {
  const res = await db
    .prepare(
      `SELECT id, session_id, chunk_id, sequence, start_ms, end_ms, text, speaker, engine, confidence, transcribed_at
       FROM transcript_segments WHERE session_id = ?
       ORDER BY sequence DESC LIMIT ?`,
    )
    .bind(sessionId, limit)
    .all<RawSegment>();
  return (res.results ?? []).reverse().map(rowToSegment);
}

export async function listRecentSessions(db: D1Database, limit: number): Promise<CaptureSession[]> {
  const res = await db
    .prepare(`SELECT ${sessionCols} FROM capture_sessions ORDER BY started_at DESC LIMIT ?`)
    .bind(limit)
    .all<RawSession>();
  return (res.results ?? []).map(rowToSession);
}

export async function allSegmentsFor(db: D1Database, sessionId: string): Promise<TranscriptSegment[]> {
  const res = await db
    .prepare(
      `SELECT id, session_id, chunk_id, sequence, start_ms, end_ms, text, speaker, engine, confidence, transcribed_at
       FROM transcript_segments WHERE session_id = ? ORDER BY sequence ASC`,
    )
    .bind(sessionId)
    .all<RawSegment>();
  return (res.results ?? []).map(rowToSegment);
}

export async function countSegments(db: D1Database, sessionId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM transcript_segments WHERE session_id = ?`)
    .bind(sessionId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

// FTS5 takes raw queries with magic chars (-, ", *, AND, OR, NEAR…). Wrap user
// input in double quotes so it's treated as a phrase; escape any internal quotes
// by doubling. This loses the power-query syntax for users who want it, but
// gains safety against accidental MATCH-syntax parse errors on natural queries.
function ftsSafeQuery(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

export async function searchSegments(
  db: D1Database,
  query: string,
  limit: number,
): Promise<Array<TranscriptSegment & { session_label: string; session_started_at: string; bm25_rank: number }>> {
  const res = await db
    .prepare(
      `SELECT s.id, s.session_id, s.chunk_id, s.sequence, s.start_ms, s.end_ms, s.text, s.speaker, s.engine, s.confidence, s.transcribed_at,
              cs.label AS session_label, cs.started_at AS session_started_at,
              fts.rank AS bm25_rank
       FROM transcript_segments_fts fts
       JOIN transcript_segments s ON s.id = fts.segment_id
       JOIN capture_sessions cs ON cs.id = s.session_id
       WHERE transcript_segments_fts MATCH ?
       ORDER BY fts.rank
       LIMIT ?`,
    )
    .bind(ftsSafeQuery(query), limit)
    .all<RawSegment & { session_label: string; session_started_at: string; bm25_rank: number }>();
  return (res.results ?? []).map((r) => ({
    ...rowToSegment(r),
    session_label: r.session_label,
    session_started_at: r.session_started_at,
    bm25_rank: r.bm25_rank,
  }));
}

// ── Whisper hallucination filter ─────────────────────────────────────────────
//
// Whisper produces predictable artifacts on near-silence: short language-of-the-
// month gibberish ("ㅋㅋㅋㅋㅋ", "아..."), repeated-word loops ("BAM BAM BAM BAM"),
// percentage fragments ("1.5%", "nd 1.5%"), pure punctuation. These pollute
// search and read responses on real captures. Conservative defaults — only drop
// when the heuristic is high-confidence. Non-English words alone do NOT count
// as hallucination (Rob's partner speaks Finnish; substantive non-English
// content must be preserved).

const ARTIFACT_PATTERNS: RegExp[] = [
  /^[\s]*nd\s+\d+(\.\d+)?%[\s]*$/i,
  /^[\s]*\d+(\.\d+)?%[\s]*$/,
  /^[\s]*\d+(\.\d+)?\s*cm(\s*x\s*\d+(\.\d+)?\s*cm)?[\s]*$/i,
];

const KOREAN_FILLER = /^[ㅋㅎㅠㅜ\s.,!?…]+$/;

export function isLikelyHallucination(rawText: string): boolean {
  const t = (rawText ?? "").trim();
  if (t.length === 0) return true;
  if (t.length < 4) return true;
  if (/^[\W_]+$/.test(t)) return true;
  if (KOREAN_FILLER.test(t)) return true;
  for (const p of ARTIFACT_PATTERNS) if (p.test(t)) return true;
  // Repeated-word loop detector: 4+ identical short tokens in a row.
  const tokens = t.split(/\s+/);
  if (tokens.length >= 4) {
    let runLen = 1;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === tokens[i - 1] && tokens[i]!.length <= 6) {
        runLen++;
        if (runLen >= 4) return true;
      } else {
        runLen = 1;
      }
    }
  }
  // Repeated-short-phrase detector: same 2-3-word phrase repeating 3+ times.
  if (tokens.length >= 6) {
    for (const span of [2, 3]) {
      const phrases: string[] = [];
      for (let i = 0; i + span <= tokens.length; i += span) {
        phrases.push(tokens.slice(i, i + span).join(" "));
      }
      let phraseRun = 1;
      for (let i = 1; i < phrases.length; i++) {
        if (phrases[i] === phrases[i - 1]) {
          phraseRun++;
          if (phraseRun >= 3) return true;
        } else {
          phraseRun = 1;
        }
      }
    }
  }
  return false;
}

export function partitionSegmentsByHallucination<T extends { text: string }>(
  segs: T[],
): { kept: T[]; filtered: T[] } {
  const kept: T[] = [];
  const filtered: T[] = [];
  for (const s of segs) (isLikelyHallucination(s.text) ? filtered : kept).push(s);
  return { kept, filtered };
}

// ── KV active-session pointer ────────────────────────────────────────────────

const ACTIVE_KEY = "active_session";

export async function getActivePointer(kv: KVNamespace): Promise<ActiveSessionPointer | null> {
  return kv.get<ActiveSessionPointer>(ACTIVE_KEY, "json");
}

export async function setActivePointer(kv: KVNamespace, p: ActiveSessionPointer): Promise<void> {
  await kv.put(ACTIVE_KEY, JSON.stringify(p));
}

export async function clearActivePointer(kv: KVNamespace): Promise<void> {
  await kv.delete(ACTIVE_KEY);
}

// ── R2 ───────────────────────────────────────────────────────────────────────

export async function putAudio(
  bucket: R2Bucket,
  key: string,
  bytes: ArrayBuffer,
  mime: string,
): Promise<number> {
  await bucket.put(key, bytes, { httpMetadata: { contentType: mime } });
  return bytes.byteLength;
}

export async function getAudio(bucket: R2Bucket, key: string): Promise<ArrayBuffer | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return obj.arrayBuffer();
}

// ── Transcription engine policy ──────────────────────────────────────────────
//
// Doctrine (per README "Doctrine refinement (2026-06-06)"): the principal
// chooses per session whether hosted models inside their own tenant may run.
// Engine selection is driven by `transcription_preference`, not by sensitivity.
// Sensitivity still drives retention, sharing, and audit posture upstream.

export function transcriptionEngineFor(
  preference: TranscriptionPreference,
): "workers-ai" | "local-whisper" {
  return preference === "local-only" ? "local-whisper" : "workers-ai";
}

export function isValidSensitivity(s: unknown): s is SensitivityTier {
  return s === "public" || s === "work" || s === "sensitive";
}

export function isValidTranscriptionPreference(s: unknown): s is TranscriptionPreference {
  return s === "hosted-ok" || s === "local-only";
}

// ── Row-to-object converters ─────────────────────────────────────────────────

interface RawSession {
  id: string;
  label: string;
  sensitivity: string;
  transcription_preference: string;
  consented_recording: number;
  client_id: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  notes: string | null;
}

interface RawChunk {
  id: string;
  session_id: string;
  sequence: number;
  r2_key: string;
  size_bytes: number;
  duration_ms: number;
  recorded_at: string;
  mime_type: string;
}

interface RawSegment {
  id: string;
  session_id: string;
  chunk_id: string;
  sequence: number;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker: string;
  engine: string;
  confidence: number | null;
  transcribed_at: string;
}

function rowToSession(r: RawSession): CaptureSession {
  return {
    id: r.id,
    label: r.label,
    sensitivity: r.sensitivity as SensitivityTier,
    transcription_preference: r.transcription_preference as TranscriptionPreference,
    consented_recording: r.consented_recording === 1,
    client_id: r.client_id,
    started_at: r.started_at,
    ended_at: r.ended_at,
    status: r.status as CaptureSession["status"],
    notes: r.notes,
  };
}

function rowToChunk(r: RawChunk): AudioChunk {
  return { ...r };
}

function rowToSegment(r: RawSegment): TranscriptSegment {
  return { ...r, engine: r.engine as TranscriptSegment["engine"] };
}
