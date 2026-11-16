// End-to-end tests through the Worker's fetch entry: routing, error mapping, /health, ingest, session end,
// the read API and the local-pickup API, all against the in-memory fakes. Synthetic data only.
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { HttpError } from "../src/lib";
import {
  LOCAL_PICKUP_TOKEN,
  bearer,
  chunkRow,
  makeHarness,
  segmentRow,
  sessionRow,
  type Harness,
} from "./helpers/fakes";

const BASE = "https://livecapture.example.test";

async function call(h: Harness, path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`${BASE}${path}`, init), h.env, h.ctx);
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const firstChunkHeaders = {
  ...bearer(),
  "x-session-label": "example-call",
  "x-session-sensitivity": "work",
  "x-client-id": "test-client",
  "x-session-consented": "true",
};

describe("routing and error mapping", () => {
  it("GET /health needs no auth and reports binding presence", async () => {
    const h = makeHarness({ tokens: false });
    const res = await call(h, "/health");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ service: "livecapture", status: "ready", version: "0.1.0" });
    expect(body.bindings).toEqual({ RAW_AUDIO: true, CAPTURE_DB: true, SESSION_STATE: true, AI: true });
  });

  it("answers 404 with the path for an unknown route", async () => {
    const res = await call(makeHarness(), "/nope");
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found", path: "/nope" });
  });

  it("maps an HttpError with an object body to that status and body", async () => {
    const res = await call(makeHarness(), "/read/sessions");
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: "unauthorized" });
  });

  it("wraps an HttpError with a string body as {error}", async () => {
    const h = makeHarness();
    h.db.override = () => {
      throw new HttpError(418, "teapot");
    };
    const res = await call(h, "/read/sessions", { headers: bearer() });
    expect(res.status).toBe(418);
    expect(await json(res)).toEqual({ error: "teapot" });
  });

  it("answers 500 internal_error for any other exception and logs it", async () => {
    const h = makeHarness();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    h.db.override = () => {
      throw new Error("d1 exploded");
    };
    const res = await call(h, "/read/sessions", { headers: bearer() });
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: "internal_error" });
    expect(log).toHaveBeenCalledWith("[unhandled]", "d1 exploded", expect.any(String));
  });
});

describe("POST /ingest", () => {
  const ingestPath = "/ingest?session_id=session-0001&sequence=0&mime=audio/webm&duration_ms=5000";

  it("rejects a missing or wrong bearer and a non-POST method", async () => {
    const h = makeHarness();
    expect((await call(h, ingestPath, { method: "POST" })).status).toBe(401);
    const res = await call(h, ingestPath, { headers: bearer() });
    expect(res.status).toBe(405);
    expect(await json(res)).toEqual({ error: "method_not_allowed", allow: "POST" });
  });

  it.each([
    ["/ingest?sequence=0", "missing_session_id"],
    ["/ingest?session_id=session-0001", "missing_sequence"],
    ["/ingest?session_id=session-0001&sequence=-1", "bad_sequence"],
    ["/ingest?session_id=session-0001&sequence=1.5", "bad_sequence"],
    ["/ingest?session_id=session-0001&sequence=0&duration_ms=-5", "bad_duration_ms"],
    ["/ingest?session_id=session-0001&sequence=0&duration_ms=abc", "bad_duration_ms"],
    ["/ingest?session_id=short&sequence=0", "bad_session_id"],
  ])("answers 400 for %s", async (path, error) => {
    const res = await call(makeHarness(), path, { method: "POST", headers: bearer(), body: "abc" });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error });
  });

  it("requires session metadata headers on the first chunk", async () => {
    const h = makeHarness();
    const res = await call(h, ingestPath, { method: "POST", headers: bearer(), body: "abc" });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: "session_metadata_required_on_first_chunk" });
  });

  it("rejects a bad sensitivity tier or transcription preference", async () => {
    const h = makeHarness();
    let res = await call(h, ingestPath, {
      method: "POST",
      headers: { ...firstChunkHeaders, "x-session-sensitivity": "secret" },
      body: "abc",
    });
    expect(await json(res)).toMatchObject({ error: "bad_sensitivity" });
    res = await call(h, ingestPath, {
      method: "POST",
      headers: { ...firstChunkHeaders, "x-session-transcription-preference": "cloud" },
      body: "abc",
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: "bad_transcription_preference" });
    expect(h.db.sessions).toHaveLength(0);
  });

  it("creates the session, stores the chunk, sets the KV pointer and queues Workers AI (hosted-ok default)", async () => {
    const h = makeHarness();
    const res = await call(h, ingestPath, { method: "POST", headers: firstChunkHeaders, body: "abc" });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body).toMatchObject({
      ok: true,
      r2_key: "session-0001/000000.webm",
      size_bytes: 3,
      transcription: "queued_workers_ai",
      session: { id: "session-0001", sensitivity: "work", transcription_preference: "hosted-ok" },
    });
    expect(h.db.sessions[0]).toMatchObject({ consented_recording: 1, status: "open", client_id: "test-client" });
    expect(h.db.chunks[0]).toMatchObject({ sequence: 0, duration_ms: 5000, mime_type: "audio/webm" });
    expect(h.r2.objects.get("session-0001/000000.webm")?.contentType).toBe("audio/webm");
    expect(JSON.parse(h.kv.store.get("active_session")!)).toMatchObject({ session_id: "session-0001" });
    expect(h.ctx.waited).toHaveLength(1);
    await Promise.all(h.ctx.waited);
    expect(h.ai.calls).toHaveLength(1);
    expect(h.db.segments[0]).toMatchObject({ text: "hello from the fake model", engine: "workers-ai" });
  });

  it("defaults recorded_at, mime and duration, and treats consent other than true/1 as false", async () => {
    const h = makeHarness();
    const res = await call(h, "/ingest?session_id=session-0001&sequence=0", {
      method: "POST",
      headers: { ...firstChunkHeaders, "x-session-consented": "no" },
      body: "abc",
    });
    expect(res.status).toBe(201);
    expect(h.db.chunks[0]).toMatchObject({ mime_type: "audio/webm", duration_ms: 0 });
    expect(h.db.chunks[0]!.recorded_at).toMatch(/^\d{4}-/);
    expect(h.db.sessions[0]!.consented_recording).toBe(0);
  });

  it("accepts consent given as 1", async () => {
    const h = makeHarness();
    await call(h, ingestPath, {
      method: "POST",
      headers: { ...firstChunkHeaders, "x-session-consented": "1" },
      body: "abc",
    });
    expect(h.db.sessions[0]!.consented_recording).toBe(1);
  });

  it("defers transcription for a local-only session and never calls Workers AI", async () => {
    const h = makeHarness();
    const res = await call(h, ingestPath, {
      method: "POST",
      headers: { ...firstChunkHeaders, "x-session-transcription-preference": "local-only" },
      body: "abc",
    });
    expect(await json(res)).toMatchObject({
      transcription: "deferred_local_whisper",
      session: { transcription_preference: "local-only" },
    });
    expect(h.ctx.waited).toHaveLength(0);
    expect(h.ai.calls).toHaveLength(0);
  });

  it("appends to an existing open session without metadata headers", async () => {
    const h = makeHarness();
    h.db.sessions.push(sessionRow());
    const res = await call(h, "/ingest?session_id=session-0001&sequence=1", {
      method: "POST",
      headers: bearer(),
      body: "abcd",
    });
    expect(res.status).toBe(201);
    expect(h.db.sessions).toHaveLength(1);
    expect(h.kv.store.size).toBe(0);
  });

  it("answers 409 for a closed session", async () => {
    const h = makeHarness();
    h.db.sessions.push(sessionRow({ status: "closed" }));
    const res = await call(h, ingestPath, { method: "POST", headers: bearer(), body: "abc" });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: "session_not_open", status: "closed" });
  });

  it("is idempotent on (session_id, sequence)", async () => {
    const h = makeHarness();
    h.db.sessions.push(sessionRow());
    h.db.chunks.push(chunkRow());
    const res = await call(h, ingestPath, { method: "POST", headers: bearer(), body: "abc" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      ok: true,
      idempotent: true,
      chunk_id: "chunk-0001",
      r2_key: "session-0001/000000.webm",
      transcription: "skipped_idempotent",
    });
    expect(h.db.chunks).toHaveLength(1);
  });

  it("rejects an empty body", async () => {
    const h = makeHarness();
    h.db.sessions.push(sessionRow());
    const res = await call(h, ingestPath, { method: "POST", headers: bearer() });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "empty_body" });
  });
});

describe("POST /sessions/:id/end", () => {
  it("rejects a non-POST method and an unknown session", async () => {
    const h = makeHarness();
    expect((await call(h, "/sessions/session-0001/end", { headers: bearer() })).status).toBe(405);
    const res = await call(h, "/sessions/session-0001/end", { method: "POST", headers: bearer() });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "session_not_found" });
  });

  it("closes an open session and clears the pointer when it points here", async () => {
    const h = makeHarness();
    h.db.sessions.push(sessionRow());
    await h.kv.put("active_session", JSON.stringify({ session_id: "session-0001", started_at: "t", client_id: "c" }));
    const res = await call(h, "/sessions/session-0001/end", { method: "POST", headers: bearer() });
    expect(await json(res)).toMatchObject({ ok: true, changed: true });
    expect(h.db.sessions[0]!.status).toBe("closed");
    expect(h.kv.store.has("active_session")).toBe(false);
  });

  it("leaves a pointer to another session alone", async () => {
    const h = makeHarness();
    h.db.sessions.push(sessionRow());
    await h.kv.put("active_session", JSON.stringify({ session_id: "other", started_at: "t", client_id: "c" }));
    await call(h, "/sessions/session-0001/end", { method: "POST", headers: bearer() });
    expect(h.kv.store.has("active_session")).toBe(true);
  });

  it("reports an already-closed session without changing it", async () => {
    const h = makeHarness();
    h.db.sessions.push(sessionRow({ status: "closed", ended_at: "2026-01-01T01:00:00.000Z" }));
    const res = await call(h, "/sessions/session-0001/end", { method: "POST", headers: bearer() });
    expect(await json(res)).toEqual({ ok: true, already: "closed", ended_at: "2026-01-01T01:00:00.000Z" });
  });
});

describe("read API", () => {
  function seeded(): Harness {
    const h = makeHarness();
    h.db.sessions.push(sessionRow(), sessionRow({ id: "s-older", started_at: "2025-12-01T00:00:00.000Z" }));
    h.db.segments.push(
      segmentRow({ id: "g0", sequence: 0, text: "we agreed on the budget" }),
      segmentRow({ id: "g1", sequence: 1, text: "ok" }),
      segmentRow({ id: "g2", sequence: 2, text: "the budget ships Friday" }),
    );
    return h;
  }

  it.each(["/read/current", "/read/sessions", "/read/sessions/session-0001", "/read/search?q=budget"])(
    "%s requires the bearer and GET",
    async (path) => {
      const h = seeded();
      expect((await call(h, path)).status).toBe(401);
      const res = await call(h, path, { method: "POST", headers: bearer() });
      expect(res.status).toBe(405);
      expect(await json(res)).toEqual({ error: "method_not_allowed", allow: "GET" });
    },
  );

  it("/read/current with no active session returns an empty shape", async () => {
    const res = await call(seeded(), "/read/current", { headers: bearer() });
    expect(await json(res)).toEqual({ session: null, recent_segments: [], segment_count_total: 0 });
  });

  it("/read/current filters hallucinations by default and reports how many", async () => {
    const h = seeded();
    await h.kv.put("active_session", JSON.stringify({ session_id: "session-0001", started_at: "t", client_id: "c" }));
    const body = await json(await call(h, "/read/current", { headers: bearer() }));
    expect((body.recent_segments as Array<{ id: string }>).map((s) => s.id)).toEqual(["g0", "g2"]);
    expect(body).toMatchObject({ segment_count_total: 3, hallucinations_filtered: 1 });
    // limit*3 over-fetch, capped at 500.
    const recent = h.db.calls.find((c) => c.sql.includes("ORDER BY sequence DESC"));
    expect(recent?.args).toEqual(["session-0001", 150]);
  });

  it("/read/current with include_hallucinations returns raw segments and clamps the limit", async () => {
    const h = seeded();
    await h.kv.put("active_session", JSON.stringify({ session_id: "session-0001", started_at: "t", client_id: "c" }));
    const body = await json(await call(h, "/read/current?include_hallucinations=true&limit=2", { headers: bearer() }));
    expect((body.recent_segments as Array<{ id: string }>).map((s) => s.id)).toEqual(["g1", "g2"]);
    expect(body.hallucinations_filtered).toBe(0);
    await call(h, "/read/current?limit=9999", { headers: bearer() });
    const calls = h.db.calls.filter((c) => c.sql.includes("ORDER BY sequence DESC"));
    expect(calls[calls.length - 1]?.args).toEqual(["session-0001", 500]);
  });

  it("/read/current with a pointer to a missing session returns null session and no segments", async () => {
    const h = seeded();
    await h.kv.put("active_session", JSON.stringify({ session_id: "gone", started_at: "t", client_id: "c" }));
    const body = await json(await call(h, "/read/current", { headers: bearer() }));
    expect(body).toMatchObject({ session: null, recent_segments: [], segment_count_total: 0 });
  });

  it("/read/sessions lists newest first and clamps limit (non-numeric falls back to the default)", async () => {
    const h = seeded();
    const body = await json(await call(h, "/read/sessions?limit=abc", { headers: bearer() }));
    expect(body.count).toBe(2);
    expect((body.sessions as Array<{ id: string }>)[0]!.id).toBe("session-0001");
    expect(h.db.calls[h.db.calls.length - 1]!.args).toEqual([25]);
    await call(h, "/read/sessions?limit=0", { headers: bearer() });
    expect(h.db.calls[h.db.calls.length - 1]!.args).toEqual([1]);
  });

  it("/read/sessions/:id returns 404 for an unknown session", async () => {
    const res = await call(seeded(), "/read/sessions/nope", { headers: bearer() });
    expect(res.status).toBe(404);
  });

  it("/read/sessions/:id filters by default and returns everything with include_hallucinations=1", async () => {
    const h = seeded();
    let body = await json(await call(h, "/read/sessions/session-0001", { headers: bearer() }));
    expect(body).toMatchObject({ count: 2, hallucinations_filtered: 1, total_with_hallucinations: 3 });
    body = await json(await call(h, "/read/sessions/session-0001?include_hallucinations=1", { headers: bearer() }));
    expect(body).toMatchObject({ count: 3, hallucinations_filtered: 0 });
  });

  it("/read/search rejects a query under two characters", async () => {
    const res = await call(seeded(), "/read/search?q=a", { headers: bearer() });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: "query_too_short" });
    expect((await call(seeded(), "/read/search", { headers: bearer() })).status).toBe(400);
  });

  it("/read/search returns bm25-ranked matches with session context, filtered by default", async () => {
    const h = seeded();
    h.db.segments.push(segmentRow({ id: "g3", sequence: 3, text: "budget budget budget budget" }));
    const body = await json(await call(h, "/read/search?q=budget&limit=10", { headers: bearer() }));
    expect(body).toMatchObject({ query: "budget", ranked_by: "bm25", total: 2 });
    const first = (body.matches as Array<Record<string, unknown>>)[0]!;
    expect(first).toMatchObject({ session_label: "example-call", session_started_at: "2026-01-01T00:00:00.000Z" });
    expect(Object.keys(first.segment as object).sort()).toEqual(
      [
        "chunk_id",
        "confidence",
        "end_ms",
        "engine",
        "id",
        "sequence",
        "session_id",
        "speaker",
        "start_ms",
        "text",
        "transcribed_at",
      ].sort(),
    );
    const raw = await json(
      await call(h, "/read/search?q=budget&limit=10&include_hallucinations=true", { headers: bearer() }),
    );
    expect(raw.total).toBe(3);
  });
});

describe("local-pickup API", () => {
  function seeded(): Harness {
    const h = makeHarness();
    h.db.sessions.push(sessionRow({ transcription_preference: "local-only" }), sessionRow({ id: "hosted-1" }));
    h.db.chunks.push(
      chunkRow({ id: "c-late", recorded_at: "2026-01-01T00:00:10.000Z", sequence: 1 }),
      chunkRow({ id: "c-early", recorded_at: "2026-01-01T00:00:00.000Z" }),
      chunkRow({ id: "c-hosted", session_id: "hosted-1" }),
    );
    return h;
  }
  const pickup = { authorization: `Bearer ${LOCAL_PICKUP_TOKEN}` };

  it("answers 503 when LOCAL_PICKUP_TOKEN is unset, 401 on the ingest token, 405 on a wrong method", async () => {
    expect((await call(makeHarness({ tokens: false }), "/local-pickup/queue", { headers: pickup })).status).toBe(503);
    const h = seeded();
    expect((await call(h, "/local-pickup/queue", { headers: bearer() })).status).toBe(401);
    expect((await call(h, "/local-pickup/queue", { headers: { authorization: "Token x" } })).status).toBe(401);
    expect((await call(h, "/local-pickup/queue", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await call(h, "/local-pickup/queue")).status).toBe(401);
    expect((await call(h, "/local-pickup/queue", { method: "POST", headers: pickup })).status).toBe(405);
    expect((await call(h, "/local-pickup/audio/c-early", { method: "POST", headers: pickup })).status).toBe(405);
    expect((await call(h, "/local-pickup/segments", { headers: pickup })).status).toBe(405);
  });

  it("queue lists only untranscribed local-only chunks, oldest first, with audio URLs", async () => {
    const h = seeded();
    const body = await json(await call(h, "/local-pickup/queue", { headers: pickup }));
    expect(body.count).toBe(2);
    const chunks = body.chunks as Array<Record<string, unknown>>;
    expect(chunks.map((c) => c.chunk_id)).toEqual(["c-early", "c-late"]);
    expect(chunks[0]).toMatchObject({ audio_url: "/local-pickup/audio/c-early", mime_type: "audio/webm" });
    expect(h.db.calls[h.db.calls.length - 1]!.args).toEqual([20]);
  });

  it("queue clamps limit to 1..100 and falls back to 20 on a non-number", async () => {
    const h = seeded();
    const lastLimit = () => h.db.calls[h.db.calls.length - 1]!.args[0];
    await call(h, "/local-pickup/queue?limit=500", { headers: pickup });
    expect(lastLimit()).toBe(100);
    await call(h, "/local-pickup/queue?limit=0", { headers: pickup });
    expect(lastLimit()).toBe(1);
    await call(h, "/local-pickup/queue?limit=xyz", { headers: pickup });
    expect(lastLimit()).toBe(20);
  });

  it("audio streams the R2 bytes with chunk headers, 404 on unknown chunk or missing object", async () => {
    const h = seeded();
    await h.r2.put("session-0001/000000.webm", new Uint8Array([7, 8, 9]).buffer);
    const res = await call(h, "/local-pickup/audio/c-early", { headers: pickup });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/webm");
    expect(res.headers.get("x-chunk-id")).toBe("c-early");
    expect(res.headers.get("x-session-id")).toBe("session-0001");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));
    const missing = await call(h, "/local-pickup/audio/nope", { headers: pickup });
    expect(await json(missing)).toEqual({ error: "chunk_not_found" });
    h.r2.objects.clear();
    const gone = await call(h, "/local-pickup/audio/c-early", { headers: pickup });
    expect(gone.status).toBe(404);
    expect(await json(gone)).toMatchObject({ error: "audio_missing_in_r2" });
  });

  it("segments rejects invalid JSON and an empty or missing segments array", async () => {
    const h = seeded();
    const post = (body: string) => call(h, "/local-pickup/segments", { method: "POST", headers: pickup, body });
    expect(await json(await post("{not json"))).toEqual({ error: "invalid_json" });
    expect((await json(await post("{}"))).error).toBe("no_segments");
    expect((await json(await post('{"segments":"x"}'))).error).toBe("no_segments");
    expect((await json(await post('{"segments":[]}'))).error).toBe("no_segments");
  });

  it("segments inserts valid rows, counts invalid ones and reports unknown chunks", async () => {
    const h = seeded();
    const res = await call(h, "/local-pickup/segments", {
      method: "POST",
      headers: pickup,
      body: JSON.stringify({
        segments: [
          {
            chunk_id: "c-early",
            text: "  first local line  ",
            start_ms: 10,
            end_ms: 20,
            speaker: "A",
            confidence: 0.9,
          },
          { chunk_id: "c-late", text: "second local line" },
          { chunk_id: "c-early", text: "   " },
          { chunk_id: "", text: "no chunk id" },
          { chunk_id: "c-early", text: 42 },
          { chunk_id: "ghost", text: "unknown chunk" },
        ],
      }),
    });
    expect(await json(res)).toEqual({
      inserted: 2,
      skipped: 0,
      invalid: 3,
      errors: [{ chunk_id: "ghost", error: "chunk_not_found" }],
    });
    expect(h.db.segments[0]).toMatchObject({
      text: "first local line",
      start_ms: 10,
      end_ms: 20,
      speaker: "A",
      confidence: 0.9,
      engine: "local-whisper",
      sequence: 0,
    });
    expect(h.db.segments[1]).toMatchObject({
      start_ms: 0,
      end_ms: 5000,
      speaker: "unknown",
      confidence: null,
      sequence: 1,
    });
  });

  it("segments skips when the computed sequence already exists (race guard)", async () => {
    const h = seeded();
    h.db.override = (sql) => (sql.includes("SELECT 1 AS x") ? { x: 1 } : undefined);
    const res = await call(h, "/local-pickup/segments", {
      method: "POST",
      headers: pickup,
      body: JSON.stringify({ segments: [{ chunk_id: "c-early", text: "line" }] }),
    });
    expect(await json(res)).toMatchObject({ inserted: 0, skipped: 1 });
  });

  it("segments records an insert failure, truncating the message to 200 characters", async () => {
    const h = seeded();
    h.db.override = (sql) => {
      if (sql.includes("INSERT INTO transcript_segments")) throw new Error("x".repeat(300));
      return undefined;
    };
    const body = await json(
      await call(h, "/local-pickup/segments", {
        method: "POST",
        headers: pickup,
        body: JSON.stringify({ segments: [{ chunk_id: "c-early", text: "line" }] }),
      }),
    );
    expect(body.inserted).toBe(0);
    const errors = body.errors as Array<{ chunk_id: string; error: string }>;
    expect(errors[0]!.chunk_id).toBe("c-early");
    expect(errors[0]!.error).toHaveLength(200);
  });
});
