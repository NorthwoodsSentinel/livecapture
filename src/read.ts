import type { Env, CurrentConversationResponse, SearchResponse } from "./types";
import {
  HttpError,
  requireBearer,
  getActivePointer,
  getSession,
  recentSegments,
  countSegments,
  listRecentSessions,
  allSegmentsFor,
  searchSegments,
} from "./lib";

export async function handleReadCurrent(request: Request, env: Env): Promise<Response> {
  requireBearer(request, env);
  if (request.method !== "GET") throw new HttpError(405, { error: "method_not_allowed", allow: "GET" });

  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 500);

  const ptr = await getActivePointer(env.SESSION_STATE);
  if (!ptr) {
    const body: CurrentConversationResponse = { session: null, recent_segments: [], segment_count_total: 0 };
    return Response.json(body);
  }

  const session = await getSession(env.CAPTURE_DB, ptr.session_id);
  const segs = session ? await recentSegments(env.CAPTURE_DB, session.id, limit) : [];
  const total = session ? await countSegments(env.CAPTURE_DB, session.id) : 0;

  const body: CurrentConversationResponse = {
    session,
    recent_segments: segs,
    segment_count_total: total,
  };
  return Response.json(body);
}

export async function handleReadSessions(request: Request, env: Env): Promise<Response> {
  requireBearer(request, env);
  if (request.method !== "GET") throw new HttpError(405, { error: "method_not_allowed", allow: "GET" });

  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), 25, 1, 200);
  const sessions = await listRecentSessions(env.CAPTURE_DB, limit);
  return Response.json({ sessions, count: sessions.length });
}

export async function handleReadSessionById(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  requireBearer(request, env);
  if (request.method !== "GET") throw new HttpError(405, { error: "method_not_allowed", allow: "GET" });

  const session = await getSession(env.CAPTURE_DB, sessionId);
  if (!session) throw new HttpError(404, { error: "session_not_found" });

  const segments = await allSegmentsFor(env.CAPTURE_DB, sessionId);
  return Response.json({ session, segments, count: segments.length });
}

export async function handleReadSearch(request: Request, env: Env): Promise<Response> {
  requireBearer(request, env);
  if (request.method !== "GET") throw new HttpError(405, { error: "method_not_allowed", allow: "GET" });

  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const limit = clampInt(url.searchParams.get("limit"), 25, 1, 200);

  if (q.length < 2) {
    throw new HttpError(400, { error: "query_too_short", detail: "q must be at least 2 chars" });
  }

  const hits = await searchSegments(env.CAPTURE_DB, q, limit);
  const body: SearchResponse = {
    query: q,
    matches: hits.map((h) => ({
      segment: {
        id: h.id,
        session_id: h.session_id,
        chunk_id: h.chunk_id,
        sequence: h.sequence,
        start_ms: h.start_ms,
        end_ms: h.end_ms,
        text: h.text,
        speaker: h.speaker,
        engine: h.engine,
        confidence: h.confidence,
        transcribed_at: h.transcribed_at,
      },
      session_label: h.session_label,
      session_started_at: h.session_started_at,
    })),
    total: hits.length,
  };
  return Response.json(body);
}

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
