import type { Env } from "./types";
import { HttpError } from "./lib";
import { handleIngest, handleEndSession } from "./ingest";
import {
  handleReadCurrent,
  handleReadSessions,
  handleReadSessionById,
  handleReadSearch,
} from "./read";
import {
  handleLocalPickupQueue,
  handleLocalPickupAudio,
  handleLocalPickupSegments,
} from "./local-pickup";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        const body = typeof e.body === "string" ? { error: e.body } : e.body;
        return Response.json(body, { status: e.status });
      }
      console.error("[unhandled]", (e as Error).message, (e as Error).stack);
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Health — no auth, no side effects.
  if (path === "/health") {
    return Response.json({
      service: "livecapture",
      status: "ready",
      version: "0.1.0",
      ts: new Date().toISOString(),
      bindings: {
        RAW_AUDIO: !!env.RAW_AUDIO,
        CAPTURE_DB: !!env.CAPTURE_DB,
        SESSION_STATE: !!env.SESSION_STATE,
        AI: !!env.AI,
      },
    });
  }

  if (path === "/ingest") return handleIngest(request, env, ctx);

  // Session lifecycle.
  const endMatch = path.match(/^\/sessions\/([^/]+)\/end$/);
  if (endMatch) return handleEndSession(request, env, endMatch[1]!);

  // Read API.
  if (path === "/read/current") return handleReadCurrent(request, env);
  if (path === "/read/sessions") return handleReadSessions(request, env);
  const sessionMatch = path.match(/^\/read\/sessions\/([^/]+)$/);
  if (sessionMatch) return handleReadSessionById(request, env, sessionMatch[1]!);
  if (path === "/read/search") return handleReadSearch(request, env);

  // Local-Whisper pickup pipeline (separate auth token).
  if (path === "/local-pickup/queue") return handleLocalPickupQueue(request, env);
  if (path === "/local-pickup/segments") return handleLocalPickupSegments(request, env);
  const audioMatch = path.match(/^\/local-pickup\/audio\/([^/]+)$/);
  if (audioMatch) return handleLocalPickupAudio(request, env, audioMatch[1]!);

  return Response.json({ error: "not_found", path }, { status: 404 });
}
