import type { Env, TranscriptSegment, TranscriptionPath } from "./types";
import {
  HttpError,
  uuid,
  nowIso,
  getAudio,
  getChunk,
  insertSegment,
  nextSegmentSequence,
  untranscribedLocalChunks,
  segmentExistsForChunkAndSequence,
} from "./lib";

// Separate bearer from the main ingest token so the local-runner credential can
// be revoked independently. Failure to set means /local-pickup/* is unavailable.
function requireLocalPickupBearer(request: Request, env: Env): void {
  const expected = (env as unknown as { LOCAL_PICKUP_TOKEN?: string }).LOCAL_PICKUP_TOKEN;
  if (!expected) {
    throw new HttpError(503, { error: "service_misconfigured", detail: "LOCAL_PICKUP_TOKEN not set" });
  }
  const got = request.headers.get("authorization") ?? "";
  if (!got.startsWith("Bearer ") || got.slice(7) !== expected) {
    throw new HttpError(401, { error: "unauthorized" });
  }
}

/**
 * GET /local-pickup/queue?limit=N
 * Returns chunks for local-only sessions that have no transcript segment yet.
 * Local runner uses this to find work.
 */
export async function handleLocalPickupQueue(request: Request, env: Env): Promise<Response> {
  requireLocalPickupBearer(request, env);
  if (request.method !== "GET") throw new HttpError(405, { error: "method_not_allowed", allow: "GET" });

  const url = new URL(request.url);
  const raw = url.searchParams.get("limit");
  const n = raw === null ? 20 : Number(raw);
  const limit = Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n))) : 20;

  const chunks = await untranscribedLocalChunks(env.CAPTURE_DB, limit);
  return Response.json({
    count: chunks.length,
    chunks: chunks.map((c) => ({
      chunk_id: c.id,
      session_id: c.session_id,
      sequence: c.sequence,
      mime_type: c.mime_type,
      duration_ms: c.duration_ms,
      recorded_at: c.recorded_at,
      size_bytes: c.size_bytes,
      audio_url: `/local-pickup/audio/${c.id}`,
    })),
  });
}

/**
 * GET /local-pickup/audio/:chunk_id
 * Streams the raw audio bytes from R2 to the local runner.
 * Same auth as the queue endpoint.
 */
export async function handleLocalPickupAudio(
  request: Request,
  env: Env,
  chunkId: string,
): Promise<Response> {
  requireLocalPickupBearer(request, env);
  if (request.method !== "GET") throw new HttpError(405, { error: "method_not_allowed", allow: "GET" });

  const chunk = await getChunk(env.CAPTURE_DB, chunkId);
  if (!chunk) throw new HttpError(404, { error: "chunk_not_found" });

  const bytes = await getAudio(env.RAW_AUDIO, chunk.r2_key);
  if (!bytes) throw new HttpError(404, { error: "audio_missing_in_r2", r2_key: chunk.r2_key });

  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": chunk.mime_type,
      "content-length": String(chunk.size_bytes),
      "x-chunk-id": chunk.id,
      "x-session-id": chunk.session_id,
    },
  });
}

interface IncomingSegment {
  chunk_id: string;
  text: string;
  start_ms?: number;
  end_ms?: number;
  speaker?: string;
  confidence?: number;
}

/**
 * POST /local-pickup/segments
 * Body: { segments: [{ chunk_id, text, start_ms?, end_ms?, speaker?, confidence? }] }
 * Inserts transcript segments produced by the local-Whisper runner.
 * Idempotent at (session_id, sequence) — re-posts skipped, not errored.
 */
export async function handleLocalPickupSegments(request: Request, env: Env): Promise<Response> {
  requireLocalPickupBearer(request, env);
  if (request.method !== "POST") throw new HttpError(405, { error: "method_not_allowed", allow: "POST" });

  let payload: { segments?: IncomingSegment[] };
  try {
    payload = await request.json();
  } catch {
    throw new HttpError(400, { error: "invalid_json" });
  }
  if (!payload.segments || !Array.isArray(payload.segments) || payload.segments.length === 0) {
    throw new HttpError(400, { error: "no_segments", detail: "Body must be { segments: [...] }" });
  }

  let inserted = 0;
  let skipped = 0;
  let invalid = 0;
  const errors: Array<{ chunk_id: string; error: string }> = [];

  for (const incoming of payload.segments) {
    if (!incoming.chunk_id || typeof incoming.text !== "string") {
      invalid++;
      continue;
    }
    const chunk = await getChunk(env.CAPTURE_DB, incoming.chunk_id);
    if (!chunk) {
      errors.push({ chunk_id: incoming.chunk_id, error: "chunk_not_found" });
      continue;
    }
    const sequence = await nextSegmentSequence(env.CAPTURE_DB, chunk.session_id);
    if (await segmentExistsForChunkAndSequence(env.CAPTURE_DB, chunk.session_id, sequence)) {
      // Race-condition guard; unlikely but cheap.
      skipped++;
      continue;
    }

    const segment: TranscriptSegment = {
      id: uuid(),
      session_id: chunk.session_id,
      chunk_id: chunk.id,
      sequence,
      start_ms: incoming.start_ms ?? 0,
      end_ms: incoming.end_ms ?? chunk.duration_ms,
      text: incoming.text.trim(),
      speaker: incoming.speaker ?? "unknown",
      engine: "local-whisper" satisfies TranscriptionPath,
      confidence: incoming.confidence ?? null,
      transcribed_at: nowIso(),
    };
    if (segment.text.length === 0) {
      invalid++;
      continue;
    }
    try {
      await insertSegment(env.CAPTURE_DB, segment);
      inserted++;
    } catch (e) {
      errors.push({ chunk_id: incoming.chunk_id, error: (e as Error).message.slice(0, 200) });
    }
  }

  return Response.json({ inserted, skipped, invalid, errors });
}
