import type { Env, AudioChunk, SensitivityTier, TranscriptSegment } from "./types";
import {
  uuid,
  nowIso,
  getAudio,
  insertSegment,
  nextSegmentSequence,
} from "./lib";

// Workers AI Whisper output shape (varies a little across model versions).
interface WhisperResult {
  text: string;
  word_count?: number;
  words?: Array<{ word: string; start: number; end: number }>;
  vtt?: string;
}

const WHISPER_MODEL = "@cf/openai/whisper";

/**
 * Transcribe a chunk via Workers AI Whisper and persist segments to D1.
 * Called via ctx.waitUntil from /ingest — fire-and-forget.
 * Sensitive-tier callers MUST NOT invoke this; they defer to local-Whisper.
 */
export async function transcribeChunk(
  env: Env,
  chunk: AudioChunk,
  sensitivity: SensitivityTier,
): Promise<void> {
  if (sensitivity === "sensitive") {
    // Defense-in-depth: sensitive tier should never reach this function, but if
    // a future caller forgets, refuse rather than leaking audio to a hosted model.
    console.warn(`[transcribe] refused sensitive chunk ${chunk.id} — local-whisper only`);
    return;
  }

  const bytes = await getAudio(env.RAW_AUDIO, chunk.r2_key);
  if (!bytes) {
    console.error(`[transcribe] r2 miss for chunk ${chunk.id} key=${chunk.r2_key}`);
    return;
  }

  let result: WhisperResult;
  try {
    result = await env.AI.run(WHISPER_MODEL, {
      audio: [...new Uint8Array(bytes)],
    }) as unknown as WhisperResult;
  } catch (e) {
    console.error(`[transcribe] AI.run failed for chunk ${chunk.id}: ${(e as Error).message}`);
    return;
  }

  const text = (result.text ?? "").trim();
  if (!text) {
    // Silent chunk or transcription returned nothing — record nothing.
    return;
  }

  const sequence = await nextSegmentSequence(env.CAPTURE_DB, chunk.session_id);

  const segment: TranscriptSegment = {
    id: uuid(),
    session_id: chunk.session_id,
    chunk_id: chunk.id,
    sequence,
    start_ms: 0,
    end_ms: chunk.duration_ms,
    text,
    speaker: "unknown",
    engine: "workers-ai",
    confidence: null,
    transcribed_at: nowIso(),
  };

  await insertSegment(env.CAPTURE_DB, segment);
}
