import type { Env, CaptureSession, AudioChunk, SensitivityTier } from "./types";
import {
  HttpError,
  uuid,
  nowIso,
  r2KeyFor,
  requireBearer,
  getSession,
  insertSession,
  closeSession,
  getChunkBySequence,
  insertChunk,
  putAudio,
  setActivePointer,
  getActivePointer,
  clearActivePointer,
  transcriptionEngineFor,
  isValidSensitivity,
} from "./lib";
import { transcribeChunk } from "./transcribe";

interface IngestQuery {
  session_id: string;
  sequence: number;
  recorded_at: string;
  mime: string;
  duration_ms: number;
}

function parseIngestQuery(url: URL): IngestQuery {
  const session_id = url.searchParams.get("session_id");
  const sequenceRaw = url.searchParams.get("sequence");
  const recorded_at = url.searchParams.get("recorded_at") ?? nowIso();
  const mime = url.searchParams.get("mime") ?? "audio/webm";
  const durationRaw = url.searchParams.get("duration_ms") ?? "0";

  if (!session_id) throw new HttpError(400, { error: "missing_session_id" });
  if (sequenceRaw === null) throw new HttpError(400, { error: "missing_sequence" });

  const sequence = Number(sequenceRaw);
  const duration_ms = Number(durationRaw);
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new HttpError(400, { error: "bad_sequence", detail: "must be non-negative integer" });
  }
  if (!Number.isFinite(duration_ms) || duration_ms < 0) {
    throw new HttpError(400, { error: "bad_duration_ms" });
  }

  return { session_id, sequence, recorded_at, mime, duration_ms };
}

async function ensureSession(env: Env, request: Request, q: IngestQuery): Promise<CaptureSession> {
  const existing = await getSession(env.CAPTURE_DB, q.session_id);
  if (existing) return existing;

  // First chunk of a new session — require session metadata in headers.
  const label = request.headers.get("x-session-label");
  const sensitivityRaw = request.headers.get("x-session-sensitivity");
  const consented = request.headers.get("x-session-consented");
  const client_id = request.headers.get("x-client-id");

  if (!label || !sensitivityRaw || !client_id) {
    throw new HttpError(400, {
      error: "session_metadata_required_on_first_chunk",
      detail: "Send X-Session-Label, X-Session-Sensitivity, X-Client-Id, X-Session-Consented headers when creating a new session.",
    });
  }
  if (!isValidSensitivity(sensitivityRaw)) {
    throw new HttpError(400, { error: "bad_sensitivity", detail: "must be public|work|sensitive" });
  }

  const session: CaptureSession = {
    id: q.session_id,
    label,
    sensitivity: sensitivityRaw,
    consented_recording: consented === "true" || consented === "1",
    client_id,
    started_at: nowIso(),
    ended_at: null,
    status: "open",
    notes: null,
  };
  await insertSession(env.CAPTURE_DB, session);
  await setActivePointer(env.SESSION_STATE, {
    session_id: session.id,
    started_at: session.started_at,
    client_id: session.client_id,
  });
  return session;
}

export async function handleIngest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  requireBearer(request, env);

  if (request.method !== "POST") {
    throw new HttpError(405, { error: "method_not_allowed", allow: "POST" });
  }

  const url = new URL(request.url);
  const q = parseIngestQuery(url);

  if (q.session_id.length < 8) {
    throw new HttpError(400, { error: "bad_session_id" });
  }

  const session = await ensureSession(env, request, q);
  if (session.status !== "open") {
    throw new HttpError(409, { error: "session_not_open", status: session.status });
  }

  // Idempotency: if the same sequence already exists, return its chunk_id.
  const existingChunk = await getChunkBySequence(env.CAPTURE_DB, q.session_id, q.sequence);
  if (existingChunk) {
    return Response.json({
      ok: true,
      idempotent: true,
      chunk_id: existingChunk.id,
      r2_key: existingChunk.r2_key,
      transcription: "skipped_idempotent",
    });
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw new HttpError(400, { error: "empty_body" });
  }

  const chunkId = uuid();
  const r2Key = r2KeyFor(q.session_id, q.sequence, q.mime);
  await putAudio(env.RAW_AUDIO, r2Key, bytes, q.mime);

  const chunk: AudioChunk = {
    id: chunkId,
    session_id: q.session_id,
    sequence: q.sequence,
    r2_key: r2Key,
    size_bytes: bytes.byteLength,
    duration_ms: q.duration_ms,
    recorded_at: q.recorded_at,
    mime_type: q.mime,
  };
  await insertChunk(env.CAPTURE_DB, chunk);

  // Transcription policy by sensitivity tier.
  const engine = transcriptionEngineFor(session.sensitivity);
  let transcriptionStatus: string;
  if (engine === "workers-ai") {
    // Fire-and-forget transcription; the ingest response doesn't block on it.
    ctx.waitUntil(transcribeChunk(env, chunk, session.sensitivity));
    transcriptionStatus = "queued_workers_ai";
  } else if (engine === "local-whisper") {
    // Sensitive tier — Worker does NOT transcribe. Local-Whisper pipeline picks up via the unprocessed-chunks query.
    transcriptionStatus = "deferred_local_whisper";
  } else {
    transcriptionStatus = "no_engine_for_tier";
  }

  return Response.json(
    {
      ok: true,
      chunk_id: chunkId,
      r2_key: r2Key,
      size_bytes: bytes.byteLength,
      transcription: transcriptionStatus,
      session: {
        id: session.id,
        sensitivity: session.sensitivity,
      },
    },
    { status: 201 },
  );
}

export async function handleEndSession(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  requireBearer(request, env);
  if (request.method !== "POST") {
    throw new HttpError(405, { error: "method_not_allowed", allow: "POST" });
  }

  const session = await getSession(env.CAPTURE_DB, sessionId);
  if (!session) throw new HttpError(404, { error: "session_not_found" });
  if (session.status !== "open") {
    return Response.json({ ok: true, already: session.status, ended_at: session.ended_at });
  }

  const endedAt = nowIso();
  const changed = await closeSession(env.CAPTURE_DB, sessionId, endedAt);
  // Clear the KV pointer only if it still points at this session.
  const ptr = await getActivePointer(env.SESSION_STATE);
  if (ptr?.session_id === sessionId) await clearActivePointer(env.SESSION_STATE);

  return Response.json({ ok: true, changed, ended_at: endedAt });
}
