// Unit tests for src/transcribe.ts: the local-only refusal, R2 misses, model failures, silent results,
// and the segment written on success. Synthetic data only; the model is a fake.
import { describe, expect, it, vi } from "vitest";
import { transcribeChunk } from "../src/transcribe";
import { chunkRow, makeHarness, segmentRow } from "./helpers/fakes";

describe("transcribeChunk", () => {
  it("refuses a local-only session before touching R2 or the model", async () => {
    const h = makeHarness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await transcribeChunk(h.env, chunkRow(), "local-only");
    expect(warn).toHaveBeenCalledOnce();
    expect(h.ai.calls).toHaveLength(0);
    expect(h.db.calls).toHaveLength(0);
  });

  it("logs and stops on an R2 miss", async () => {
    const h = makeHarness();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await transcribeChunk(h.env, chunkRow(), "hosted-ok");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("r2 miss"));
    expect(h.ai.calls).toHaveLength(0);
  });

  it("logs and stops when the model call throws", async () => {
    const h = makeHarness();
    await h.r2.put("session-0001/000000.webm", new Uint8Array([1, 2]).buffer);
    h.ai.error = new Error("model down");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await transcribeChunk(h.env, chunkRow(), "hosted-ok");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("model down"));
    expect(h.db.segments).toHaveLength(0);
  });

  it("writes nothing for an empty, whitespace or missing text result", async () => {
    const h = makeHarness();
    await h.r2.put("session-0001/000000.webm", new Uint8Array([1]).buffer);
    for (const result of [{ text: "" }, { text: "   " }, {}]) {
      h.ai.result = result;
      await transcribeChunk(h.env, chunkRow(), "hosted-ok");
    }
    expect(h.db.segments).toHaveLength(0);
  });

  it("sends the audio bytes to Whisper and writes one trimmed segment at the next sequence", async () => {
    const h = makeHarness();
    await h.r2.put("session-0001/000000.webm", new Uint8Array([5, 6, 7]).buffer);
    h.db.segments.push(segmentRow({ sequence: 2 }));
    h.ai.result = { text: "  the transcribed words  " };
    await transcribeChunk(h.env, chunkRow({ duration_ms: 4200 }), "hosted-ok");
    expect(h.ai.calls[0]).toEqual({ model: "@cf/openai/whisper", input: { audio: [5, 6, 7] } });
    expect(h.db.segments[1]).toMatchObject({
      session_id: "session-0001",
      chunk_id: "chunk-0001",
      sequence: 3,
      start_ms: 0,
      end_ms: 4200,
      text: "the transcribed words",
      speaker: "unknown",
      engine: "workers-ai",
      confidence: null,
    });
  });
});
