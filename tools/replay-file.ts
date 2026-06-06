#!/usr/bin/env bun
/*
 * replay-file — pump an existing audio file through the livecapture /ingest pipeline.
 *
 * Use cases:
 *   - Validate the Whisper transcription path with real audio.
 *   - Backfill the substrate with PLAUD recordings, voice memos, podcast clips.
 *   - Smoke-test the pipeline end-to-end without a live capture client.
 *
 * Usage:
 *   bun run tools/replay-file.ts <audio-path> [--label NAME] [--sensitivity work|public|sensitive]
 *                                              [--consented true|false] [--chunk-sec N]
 *                                              [--end-session] [--dry-run]
 *
 * Requires: ffmpeg in PATH, LIVECAPTURE_URL + LIVECAPTURE_TOKEN env vars.
 */

import { spawn } from "node:child_process";
import { readFile, stat, mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface Args {
  path: string;
  label: string;
  sensitivity: "public" | "work" | "sensitive";
  preference: "hosted-ok" | "local-only";
  consented: boolean;
  chunkSec: number;
  endSession: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const path = positional[0];
  if (!path) die(`usage: replay-file <audio-path> [--label NAME] [--sensitivity work|public|sensitive] [--preference hosted-ok|local-only] [--consented true|false] [--chunk-sec N] [--end-session] [--dry-run]`);
  const flag = (k: string) => argv.includes(`--${k}`);
  const val = (k: string, def: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
  };
  const sensitivity = val("sensitivity", "work");
  if (sensitivity !== "public" && sensitivity !== "work" && sensitivity !== "sensitive") {
    die(`--sensitivity must be public|work|sensitive (got ${sensitivity})`);
  }
  const preference = val("preference", "hosted-ok");
  if (preference !== "hosted-ok" && preference !== "local-only") {
    die(`--preference must be hosted-ok|local-only (got ${preference})`);
  }
  const chunkSec = Number(val("chunk-sec", "20"));
  if (!Number.isFinite(chunkSec) || chunkSec < 5 || chunkSec > 60) {
    die(`--chunk-sec must be 5..60 (got ${chunkSec})`);
  }
  return {
    path,
    label: val("label", `replay-${path.split("/").pop() ?? "file"}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`),
    sensitivity,
    preference,
    consented: val("consented", "false") === "true",
    chunkSec,
    endSession: flag("end-session"),
    dryRun: flag("dry-run"),
  };
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) die(`required env var ${name} is not set (source /root/.env and set LIVECAPTURE_URL + LIVECAPTURE_TOKEN)`);
  return v;
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (b) => (stdout += b.toString()));
    p.stderr.on("data", (b) => (stderr += b.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

async function probeDuration(path: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  return Math.ceil(Number(stdout.trim()));
}

async function chunkAudio(srcPath: string, outDir: string, chunkSec: number): Promise<string[]> {
  // Re-encode to a Whisper-friendly format (16kHz mono WAV) for consistency, then split.
  await run("ffmpeg", [
    "-y",
    "-i", srcPath,
    "-ac", "1",
    "-ar", "16000",
    "-f", "segment",
    "-segment_time", String(chunkSec),
    "-reset_timestamps", "1",
    "-c:a", "pcm_s16le",
    join(outDir, "chunk_%05d.wav"),
  ]);
  const entries = (await readdir(outDir)).filter((n) => n.startsWith("chunk_") && n.endsWith(".wav")).sort();
  return entries.map((n) => join(outDir, n));
}

async function postChunk(opts: {
  url: string;
  token: string;
  sessionId: string;
  sequence: number;
  filePath: string;
  durationMs: number;
  recordedAt: string;
  headers: Record<string, string>;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const bytes = await readFile(opts.filePath);
  const qs = new URLSearchParams({
    session_id: opts.sessionId,
    sequence: String(opts.sequence),
    mime: "audio/wav",
    duration_ms: String(opts.durationMs),
    recorded_at: opts.recordedAt,
  });
  const res = await fetch(`${opts.url}/ingest?${qs}`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${opts.token}`,
      "content-type": "audio/wav",
      ...opts.headers,
    },
    body: bytes,
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  return { ok: res.ok, status: res.status, body };
}

async function endSession(opts: { url: string; token: string; sessionId: string }): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${opts.url}/sessions/${opts.sessionId}/end`, {
    method: "POST",
    headers: { "authorization": `Bearer ${opts.token}` },
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  return { ok: res.ok, status: res.status, body };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await stat(args.path).catch(() => die(`audio file not found: ${args.path}`));

  const url = env("LIVECAPTURE_URL").replace(/\/+$/, "");
  const token = env("LIVECAPTURE_TOKEN");

  const sessionId = crypto.randomUUID();
  const durationSec = await probeDuration(args.path);

  console.log(`replay-file → ${args.path}`);
  console.log(`  duration:    ${durationSec}s`);
  console.log(`  chunk size:  ${args.chunkSec}s`);
  console.log(`  session_id:  ${sessionId}`);
  console.log(`  label:       ${args.label}`);
  console.log(`  sensitivity: ${args.sensitivity}`);
  console.log(`  preference:  ${args.preference}`);
  console.log(`  target:      ${url}/ingest`);
  if (args.dryRun) {
    console.log(`  (dry-run: no chunks will be sent)`);
    return;
  }
  if (args.preference === "local-only") {
    console.warn(`  NOTE: preference=local-only — Workers AI will NOT transcribe these chunks.`);
    console.warn(`        Audio + metadata are stored; local-Whisper pickup pipeline will process them.`);
  }

  const workDir = await mkdtemp(join(tmpdir(), "livecapture-replay-"));
  let chunks: string[] = [];
  try {
    chunks = await chunkAudio(args.path, workDir, args.chunkSec);
    if (chunks.length === 0) die(`ffmpeg produced no chunks (silent file? unsupported format?)`);
    console.log(`  chunks:      ${chunks.length}`);
    console.log("");

    const startedAt = new Date().toISOString();
    const baseHeaders: Record<string, string> = {
      "x-session-label": args.label,
      "x-session-sensitivity": args.sensitivity,
      "x-session-transcription-preference": args.preference,
      "x-session-consented": args.consented ? "true" : "false",
      "x-client-id": "replay-file",
    };

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const chunkDurationMs = Math.min(args.chunkSec * 1000, (durationSec - i * args.chunkSec) * 1000);
      const recordedAt = new Date(Date.parse(startedAt) + i * args.chunkSec * 1000).toISOString();
      const headers = i === 0 ? baseHeaders : {};
      const result = await postChunk({
        url,
        token,
        sessionId,
        sequence: i,
        filePath: chunk,
        durationMs: chunkDurationMs,
        recordedAt,
        headers,
      });
      const status = result.ok ? "OK" : "FAIL";
      const body = result.body as { chunk_id?: string; transcription?: string };
      const summary = result.ok && body.chunk_id
        ? ` chunk_id=${body.chunk_id.slice(0, 8)} ${body.transcription ?? ""}`
        : ` ${JSON.stringify(result.body).slice(0, 160)}`;
      console.log(`  [${i + 1}/${chunks.length}] HTTP ${result.status} ${status}${summary}`);
      if (!result.ok) {
        console.error(`  aborting at chunk ${i} — server rejected upload`);
        process.exit(1);
      }
    }

    if (args.endSession) {
      console.log("");
      const endResult = await endSession({ url, token, sessionId });
      console.log(`  end-session: HTTP ${endResult.status} ${JSON.stringify(endResult.body)}`);
    } else {
      console.log("");
      console.log(`  session left OPEN. Close manually with:`);
      console.log(`    curl -X POST "$LIVECAPTURE_URL/sessions/${sessionId}/end" -H "Authorization: Bearer $LIVECAPTURE_TOKEN"`);
    }

    console.log("");
    console.log(`  read transcripts when ready:`);
    console.log(`    curl "$LIVECAPTURE_URL/read/sessions/${sessionId}" -H "Authorization: Bearer $LIVECAPTURE_TOKEN" | jq`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
