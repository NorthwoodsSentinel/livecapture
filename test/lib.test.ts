// Unit tests for src/lib.ts: bearer auth, R2 key naming, D1 row mapping, the hallucination filter,
// the KV pointer and the transcription-engine policy. Synthetic data only.
import { describe, expect, it } from "vitest";
import {
  HttpError,
  allSegmentsFor,
  clearActivePointer,
  closeSession,
  countSegments,
  getActivePointer,
  getAudio,
  getChunk,
  getChunkBySequence,
  getSession,
  insertSession,
  isLikelyHallucination,
  isValidSensitivity,
  isValidTranscriptionPreference,
  listRecentSessions,
  nextSegmentSequence,
  nowIso,
  partitionSegmentsByHallucination,
  putAudio,
  r2KeyFor,
  recentSegments,
  requireBearer,
  searchSegments,
  segmentExistsForChunkAndSequence,
  setActivePointer,
  transcriptionEngineFor,
  untranscribedLocalChunks,
  uuid,
} from "../src/lib";
import { FakeD1, FakeKV, FakeR2, INGEST_TOKEN, makeHarness, segmentRow, sessionRow } from "./helpers/fakes";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/x", { headers });
}

function thrown(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("expected an HttpError");
}

describe("HttpError", () => {
  it("keeps status and body; message is the string body or the JSON of an object body", () => {
    const a = new HttpError(400, "plain");
    expect(a.status).toBe(400);
    expect(a.body).toBe("plain");
    expect(a.message).toBe("plain");
    const b = new HttpError(401, { error: "unauthorized" });
    expect(b.message).toBe('{"error":"unauthorized"}');
    expect(b).toBeInstanceOf(Error);
  });
});

describe("requireBearer", () => {
  it("answers 503 when INGEST_TOKEN is not configured", () => {
    const { env } = makeHarness({ tokens: false });
    const e = thrown(() => requireBearer(req({ authorization: `Bearer ${INGEST_TOKEN}` }), env));
    expect(e.status).toBe(503);
    expect(e.body).toEqual({ error: "service_misconfigured", detail: "INGEST_TOKEN not set" });
  });

  it("answers 401 with no header, a non-Bearer scheme, or the wrong token", () => {
    const { env } = makeHarness();
    expect(thrown(() => requireBearer(req(), env)).status).toBe(401);
    expect(thrown(() => requireBearer(req({ authorization: `Basic ${INGEST_TOKEN}` }), env)).status).toBe(401);
    expect(thrown(() => requireBearer(req({ authorization: "Bearer nope" }), env)).body).toEqual({
      error: "unauthorized",
    });
  });

  it("passes with the exact token", () => {
    const { env } = makeHarness();
    expect(() => requireBearer(req({ authorization: `Bearer ${INGEST_TOKEN}` }), env)).not.toThrow();
  });
});

describe("ids and keys", () => {
  it("uuid and nowIso have the expected shapes", () => {
    expect(uuid()).toMatch(/^[0-9a-f-]{36}$/);
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("r2KeyFor pads the sequence and maps each mime family to an extension", () => {
    const cases: Array<[string, string]> = [
      ["audio/webm;codecs=opus", "webm"],
      ["audio/wav", "wav"],
      ["audio/mpeg", "mp3"],
      ["audio/mp3", "mp3"],
      ["audio/ogg", "ogg"],
      ["audio/opus", "ogg"],
      ["audio/flac", "flac"],
      ["audio/m4a", "m4a"],
      ["audio/mp4", "m4a"],
      ["application/octet-stream", "bin"],
    ];
    for (const [mime, ext] of cases) expect(r2KeyFor("s1", 7, mime)).toBe(`s1/000007.${ext}`);
  });
});

describe("D1 helpers", () => {
  it("getSession maps the row (consented 1 -> true, 0 -> false) and returns null on a miss", async () => {
    const db = new FakeD1();
    db.sessions.push(sessionRow(), sessionRow({ id: "s2", consented_recording: 0 }));
    expect(await getSession(db.asBinding(), "session-0001")).toMatchObject({ consented_recording: true });
    expect(await getSession(db.asBinding(), "s2")).toMatchObject({ consented_recording: false });
    expect(await getSession(db.asBinding(), "missing")).toBeNull();
  });

  it("insertSession binds consented_recording as 1 or 0", async () => {
    const db = new FakeD1();
    const base = {
      id: "a",
      label: "l",
      sensitivity: "work" as const,
      transcription_preference: "hosted-ok" as const,
      consented_recording: true,
      client_id: "c",
      started_at: "2026-01-01T00:00:00.000Z",
      ended_at: null,
      status: "open" as const,
      notes: null,
    };
    await insertSession(db.asBinding(), base);
    await insertSession(db.asBinding(), { ...base, id: "b", consented_recording: false });
    expect(db.sessions.map((s) => s.consented_recording)).toEqual([1, 0]);
  });

  it("closeSession reports whether a row changed, treating a missing meta as no change", async () => {
    const db = new FakeD1();
    db.sessions.push(sessionRow());
    expect(await closeSession(db.asBinding(), "session-0001", "2026-01-02T00:00:00.000Z")).toBe(true);
    expect(await closeSession(db.asBinding(), "session-0001", "2026-01-02T00:00:00.000Z")).toBe(false);
    db.override = (_sql, _args, method) => (method === "run" ? {} : undefined);
    expect(await closeSession(db.asBinding(), "session-0001", "x")).toBe(false);
  });

  it("getChunkBySequence and getChunk return the row or null", async () => {
    const db = new FakeD1();
    db.chunks.push({
      id: "c1",
      session_id: "s1",
      sequence: 2,
      r2_key: "k",
      size_bytes: 1,
      duration_ms: 1,
      recorded_at: "t",
      mime_type: "audio/wav",
    });
    expect(await getChunkBySequence(db.asBinding(), "s1", 2)).toMatchObject({ id: "c1" });
    expect(await getChunkBySequence(db.asBinding(), "s1", 3)).toBeNull();
    expect(await getChunk(db.asBinding(), "c1")).toMatchObject({ sequence: 2 });
    expect(await getChunk(db.asBinding(), "nope")).toBeNull();
  });

  it("nextSegmentSequence starts at 0, follows the max, and falls back to 0 on a null row", async () => {
    const db = new FakeD1();
    expect(await nextSegmentSequence(db.asBinding(), "session-0001")).toBe(0);
    db.segments.push(segmentRow({ sequence: 4 }));
    expect(await nextSegmentSequence(db.asBinding(), "session-0001")).toBe(5);
    db.override = (sql) => (sql.includes("COALESCE") ? null : undefined);
    expect(await nextSegmentSequence(db.asBinding(), "session-0001")).toBe(0);
  });

  it("countSegments counts and falls back to 0 on a null row", async () => {
    const db = new FakeD1();
    db.segments.push(segmentRow(), segmentRow({ id: "x", sequence: 1 }));
    expect(await countSegments(db.asBinding(), "session-0001")).toBe(2);
    db.override = (sql) => (sql.includes("COUNT(*)") ? null : undefined);
    expect(await countSegments(db.asBinding(), "session-0001")).toBe(0);
  });

  it("segmentExistsForChunkAndSequence is true only for a matching row", async () => {
    const db = new FakeD1();
    db.segments.push(segmentRow({ sequence: 3 }));
    expect(await segmentExistsForChunkAndSequence(db.asBinding(), "session-0001", 3)).toBe(true);
    expect(await segmentExistsForChunkAndSequence(db.asBinding(), "session-0001", 4)).toBe(false);
  });

  it("recentSegments returns the newest N in ascending order", async () => {
    const db = new FakeD1();
    for (let i = 0; i < 5; i++) db.segments.push(segmentRow({ id: `g${i}`, sequence: i }));
    const rows = await recentSegments(db.asBinding(), "session-0001", 3);
    expect(rows.map((r) => r.sequence)).toEqual([2, 3, 4]);
  });

  it("list helpers return [] when D1 gives no results array", async () => {
    const db = new FakeD1();
    db.override = (_sql, _args, method) => (method === "all" ? {} : undefined);
    const b = db.asBinding();
    expect(await untranscribedLocalChunks(b, 5)).toEqual([]);
    expect(await recentSegments(b, "s", 5)).toEqual([]);
    expect(await listRecentSessions(b, 5)).toEqual([]);
    expect(await allSegmentsFor(b, "s")).toEqual([]);
    expect(await searchSegments(b, "q", 5)).toEqual([]);
  });

  it("searchSegments wraps the query as an FTS5 phrase with inner quotes doubled", async () => {
    const db = new FakeD1();
    db.sessions.push(sessionRow());
    db.segments.push(segmentRow({ text: 'she said "ship it" today' }));
    const hits = await searchSegments(db.asBinding(), '"ship it"', 10);
    const call = db.calls.find((c) => c.sql.includes("transcript_segments_fts"));
    expect(call?.args).toEqual(['"""ship it"""', 10]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ session_label: "example-call", bm25_rank: -0 });
  });
});

describe("isLikelyHallucination", () => {
  it.each([
    ["", "empty"],
    ["   ", "whitespace"],
    ["ok.", "shorter than four characters"],
    ["....!!", "punctuation only"],
    // Korean filler is caught by the punctuation-only check: without the u flag, \W matches Hangul jamo.
    ["ㅋㅋㅋㅋㅋ", "Korean filler"],
    ["nd 1.5%", "percentage fragment"],
    ["12.5%", "bare percentage"],
    ["3 cm x 4.5 cm", "measurement fragment"],
    ["BAM BAM BAM BAM", "repeated short word"],
    ["thank you thank you thank you", "repeated two-word phrase"],
    ["so it is so it is so it is", "repeated three-word phrase"],
  ])("flags %j (%s)", (text) => {
    expect(isLikelyHallucination(text)).toBe(true);
  });

  it.each([
    ["we should move the meeting to Friday", "ordinary English"],
    ["Hyvää huomenta, mitä kuuluu tänään", "substantive non-English"],
    ["go go go home now please", "a run of three is not a loop"],
    ["absolutely absolutely absolutely absolutely", "repeated words longer than six characters"],
    ["one two one two three four five six", "phrases that do not repeat three times"],
  ])("keeps %j (%s)", (text) => {
    expect(isLikelyHallucination(text)).toBe(false);
  });

  it("treats a null-ish input as empty", () => {
    expect(isLikelyHallucination(undefined as unknown as string)).toBe(true);
  });

  it("partitionSegmentsByHallucination splits kept from filtered, preserving order", () => {
    const { kept, filtered } = partitionSegmentsByHallucination([
      { text: "a real sentence here" },
      { text: "ok" },
      { text: "another real sentence" },
    ]);
    expect(kept.map((s) => s.text)).toEqual(["a real sentence here", "another real sentence"]);
    expect(filtered.map((s) => s.text)).toEqual(["ok"]);
  });
});

describe("KV pointer and R2", () => {
  it("sets, reads and clears the active-session pointer", async () => {
    const kv = new FakeKV();
    const b = kv.asBinding();
    expect(await getActivePointer(b)).toBeNull();
    await setActivePointer(b, { session_id: "s", started_at: "t", client_id: "c" });
    expect(await getActivePointer(b)).toEqual({ session_id: "s", started_at: "t", client_id: "c" });
    await clearActivePointer(b);
    expect(await getActivePointer(b)).toBeNull();
  });

  it("putAudio stores bytes with the content type and returns the length; getAudio returns null on a miss", async () => {
    const r2 = new FakeR2();
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    expect(await putAudio(r2.asBinding(), "k", bytes, "audio/wav")).toBe(3);
    expect(r2.objects.get("k")?.contentType).toBe("audio/wav");
    expect(new Uint8Array((await getAudio(r2.asBinding(), "k"))!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await getAudio(r2.asBinding(), "missing")).toBeNull();
  });
});

describe("policy and validators", () => {
  it("routes local-only to local-whisper and everything else to workers-ai", () => {
    expect(transcriptionEngineFor("local-only")).toBe("local-whisper");
    expect(transcriptionEngineFor("hosted-ok")).toBe("workers-ai");
  });

  it("validates sensitivity tiers and transcription preferences", () => {
    for (const s of ["public", "work", "sensitive"]) expect(isValidSensitivity(s)).toBe(true);
    for (const s of ["secret", "", null, 1]) expect(isValidSensitivity(s)).toBe(false);
    for (const s of ["hosted-ok", "local-only"]) expect(isValidTranscriptionPreference(s)).toBe(true);
    for (const s of ["local", undefined]) expect(isValidTranscriptionPreference(s)).toBe(false);
  });
});
