// Test fakes for the Worker bindings: an in-memory D1 that answers the exact queries src/lib.ts issues,
// plus KV, R2 and Workers AI stand-ins. Synthetic data only; nothing here reaches Cloudflare or the network.
// The fake D1 recognizes each statement by a distinctive fragment of its SQL; an unknown statement throws,
// so a query change in src/ shows up as a failing test rather than a silent empty result.
import type { Env } from "../../src/types";

export interface SessionRow {
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

export interface ChunkRow {
  id: string;
  session_id: string;
  sequence: number;
  r2_key: string;
  size_bytes: number;
  duration_ms: number;
  recorded_at: string;
  mime_type: string;
}

export interface SegmentRow {
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

type Method = "first" | "all" | "run";
/** Return a value to replace the fake's normal answer for one statement; return undefined to fall through. */
export type Override = (sql: string, args: unknown[], method: Method) => unknown;

export class FakeD1 {
  sessions: SessionRow[] = [];
  chunks: ChunkRow[] = [];
  segments: SegmentRow[] = [];
  calls: Array<{ sql: string; args: unknown[]; method: Method }> = [];
  override: Override | null = null;

  prepare(sql: string) {
    let args: unknown[] = [];
    const stmt = {
      bind: (...a: unknown[]) => {
        args = a;
        return stmt;
      },
      first: async () => this.exec(sql, args, "first"),
      all: async () => this.exec(sql, args, "all"),
      run: async () => this.exec(sql, args, "run"),
    };
    return stmt;
  }

  asBinding(): D1Database {
    return this as unknown as D1Database;
  }

  private exec(sql: string, args: unknown[], method: Method): unknown {
    this.calls.push({ sql, args, method });
    if (this.override) {
      const v = this.override(sql, args, method);
      if (v !== undefined) return v;
    }
    const has = (frag: string) => sql.includes(frag);

    if (has("INSERT INTO capture_sessions")) {
      const [
        id,
        label,
        sensitivity,
        transcription_preference,
        consented_recording,
        client_id,
        started_at,
        ended_at,
        status,
        notes,
      ] = args as [string, string, string, string, number, string, string, string | null, string, string | null];
      this.sessions.push({
        id,
        label,
        sensitivity,
        transcription_preference,
        consented_recording,
        client_id,
        started_at,
        ended_at,
        status,
        notes,
      });
      return { meta: { changes: 1 } };
    }
    if (has("UPDATE capture_sessions SET ended_at")) {
      const [endedAt, id] = args as [string, string];
      const s = this.sessions.find((r) => r.id === id && r.status === "open");
      if (!s) return { meta: { changes: 0 } };
      s.ended_at = endedAt;
      s.status = "closed";
      return { meta: { changes: 1 } };
    }
    if (has("FROM capture_sessions WHERE id = ?")) {
      return this.sessions.find((r) => r.id === args[0]) ?? null;
    }
    if (has("FROM capture_sessions ORDER BY started_at DESC")) {
      const sorted = [...this.sessions].sort((a, b) => b.started_at.localeCompare(a.started_at));
      return { results: sorted.slice(0, args[0] as number) };
    }
    if (has("INSERT INTO audio_chunks")) {
      const [id, session_id, sequence, r2_key, size_bytes, duration_ms, recorded_at, mime_type] = args as [
        string,
        string,
        number,
        string,
        number,
        number,
        string,
        string,
      ];
      this.chunks.push({ id, session_id, sequence, r2_key, size_bytes, duration_ms, recorded_at, mime_type });
      return { meta: { changes: 1 } };
    }
    if (has("FROM audio_chunks c")) {
      const pending = this.chunks
        .filter((c) => {
          const s = this.sessions.find((r) => r.id === c.session_id);
          return s?.transcription_preference === "local-only" && !this.segments.some((t) => t.chunk_id === c.id);
        })
        .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
      return { results: pending.slice(0, args[0] as number) };
    }
    if (has("FROM audio_chunks WHERE session_id = ? AND sequence = ?")) {
      return this.chunks.find((c) => c.session_id === args[0] && c.sequence === args[1]) ?? null;
    }
    if (has("FROM audio_chunks WHERE id = ?")) {
      return this.chunks.find((c) => c.id === args[0]) ?? null;
    }
    if (has("INSERT INTO transcript_segments")) {
      const [id, session_id, chunk_id, sequence, start_ms, end_ms, text, speaker, engine, confidence, transcribed_at] =
        args as [string, string, string, number, number, number, string, string, string, number | null, string];
      this.segments.push({
        id,
        session_id,
        chunk_id,
        sequence,
        start_ms,
        end_ms,
        text,
        speaker,
        engine,
        confidence,
        transcribed_at,
      });
      return { meta: { changes: 1 } };
    }
    if (has("COALESCE(MAX(sequence), -1) + 1 AS next")) {
      const seqs = this.segments.filter((t) => t.session_id === args[0]).map((t) => t.sequence);
      return { next: seqs.length ? Math.max(...seqs) + 1 : 0 };
    }
    if (has("SELECT 1 AS x FROM transcript_segments")) {
      return this.segments.some((t) => t.session_id === args[0] && t.sequence === args[1]) ? { x: 1 } : null;
    }
    if (has("COUNT(*) AS c FROM transcript_segments")) {
      return { c: this.segments.filter((t) => t.session_id === args[0]).length };
    }
    if (has("transcript_segments_fts")) {
      // The worker wraps the query as an FTS5 phrase ("..." with inner quotes doubled); unwrap it here.
      const phrase = (args[0] as string).slice(1, -1).replace(/""/g, '"').toLowerCase();
      const hits = this.segments
        .filter((t) => t.text.toLowerCase().includes(phrase))
        .map((t, i) => {
          const s = this.sessions.find((r) => r.id === t.session_id);
          return { ...t, session_label: s?.label ?? "", session_started_at: s?.started_at ?? "", bm25_rank: -i };
        });
      return { results: hits.slice(0, args[1] as number) };
    }
    if (has("ORDER BY sequence DESC LIMIT ?")) {
      const rows = this.segments
        .filter((t) => t.session_id === args[0])
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, args[1] as number);
      return { results: rows };
    }
    if (has("ORDER BY sequence ASC")) {
      return { results: this.segments.filter((t) => t.session_id === args[0]).sort((a, b) => a.sequence - b.sequence) };
    }
    throw new Error(`FakeD1: unrecognized statement: ${sql}`);
  }
}

export class FakeKV {
  store = new Map<string, string>();
  async get(key: string, type?: string): Promise<unknown> {
    const v = this.store.get(key);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  asBinding(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}

export class FakeR2 {
  objects = new Map<string, { bytes: ArrayBuffer; contentType: string | undefined }>();
  async put(key: string, bytes: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<void> {
    this.objects.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
  }
  async get(key: string): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return { arrayBuffer: async () => o.bytes };
  }
  asBinding(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

export class FakeAI {
  calls: Array<{ model: string; input: unknown }> = [];
  result: unknown = { text: "hello from the fake model" };
  error: Error | null = null;
  async run(model: string, input: unknown): Promise<unknown> {
    this.calls.push({ model, input });
    if (this.error) throw this.error;
    return this.result;
  }
  asBinding(): Ai {
    return this as unknown as Ai;
  }
}

export interface Harness {
  env: Env;
  db: FakeD1;
  kv: FakeKV;
  r2: FakeR2;
  ai: FakeAI;
  ctx: ExecutionContext & { waited: Promise<unknown>[] };
}

export const INGEST_TOKEN = "test-ingest-token-synthetic";
export const LOCAL_PICKUP_TOKEN = "test-pickup-token-synthetic";

/** Build an Env with fresh fakes. Pass `tokens: false` to leave both bearer secrets unset. */
export function makeHarness(opts: { tokens?: boolean } = {}): Harness {
  const db = new FakeD1();
  const kv = new FakeKV();
  const r2 = new FakeR2();
  const ai = new FakeAI();
  const base = {
    RAW_AUDIO: r2.asBinding(),
    CAPTURE_DB: db.asBinding(),
    SESSION_STATE: kv.asBinding(),
    AI: ai.asBinding(),
    ACCESS_AUD: "test-aud",
  };
  const env = (opts.tokens === false ? base : { ...base, INGEST_TOKEN, LOCAL_PICKUP_TOKEN }) as Env;
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waited,
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext & { waited: Promise<unknown>[] };
  return { env, db, kv, r2, ai, ctx };
}

export function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-0001",
    label: "example-call",
    sensitivity: "work",
    transcription_preference: "hosted-ok",
    consented_recording: 1,
    client_id: "test-client",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: null,
    status: "open",
    notes: null,
    ...over,
  };
}

export function chunkRow(over: Partial<ChunkRow> = {}): ChunkRow {
  return {
    id: "chunk-0001",
    session_id: "session-0001",
    sequence: 0,
    r2_key: "session-0001/000000.webm",
    size_bytes: 3,
    duration_ms: 5000,
    recorded_at: "2026-01-01T00:00:00.000Z",
    mime_type: "audio/webm",
    ...over,
  };
}

export function segmentRow(over: Partial<SegmentRow> = {}): SegmentRow {
  return {
    id: "segment-0001",
    session_id: "session-0001",
    chunk_id: "chunk-0001",
    sequence: 0,
    start_ms: 0,
    end_ms: 5000,
    text: "a substantive sentence about the plan",
    speaker: "unknown",
    engine: "workers-ai",
    confidence: null,
    transcribed_at: "2026-01-01T00:00:05.000Z",
    ...over,
  };
}

export function bearer(token: string = INGEST_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
