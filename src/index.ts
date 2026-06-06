import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        service: "livecapture",
        status: "ready",
        version: "0.0.1",
        ts: new Date().toISOString(),
        bindings: {
          RAW_AUDIO: !!env.RAW_AUDIO,
          CAPTURE_DB: !!env.CAPTURE_DB,
          SESSION_STATE: !!env.SESSION_STATE,
          AI: !!env.AI,
        },
      });
    }

    return new Response("livecapture — see /health", { status: 404 });
  },
};
