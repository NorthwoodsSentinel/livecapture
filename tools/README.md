# tools/

Two ways to feed audio into livecapture.

## `replay-file.ts` — pump an existing recording through `/ingest`

Use this to:
- Validate the Whisper pipeline end-to-end with real audio (fastest first-confidence test).
- Backfill the substrate with prior recordings (PLAUD captures, voice memos, podcasts).
- Smoke-test before bothering with the live capture client.

**Setup (Lares / WSL):**
```bash
export LIVECAPTURE_URL="https://livecapture.robert-chuvala.workers.dev"
export LIVECAPTURE_TOKEN="$(op item get 'livecapture-ingest-token' --vault Fleet-Shared --field credential --reveal)"
```

**Run:**
```bash
# Smoke test against a small file
bun run tools/replay-file.ts /path/to/voice-memo.m4a --label "smoke-real-audio"

# PLAUD recording from G: drive, full pipeline, close session at end
bun run tools/replay-file.ts "/mnt/g/My Drive/00_INBOX_CAPTURE/2026-06-05-wally-meeting.mp3" \
  --label "wally-2026-06-05" \
  --sensitivity work \
  --consented true \
  --chunk-sec 20 \
  --end-session

# Dry run — see what would happen, don't post
bun run tools/replay-file.ts file.mp3 --dry-run
```

Requirements: `ffmpeg` and `ffprobe` in PATH.

The script re-encodes to 16 kHz mono WAV before chunking (Whisper-native, deterministic), so source format compatibility is broad — MP3, M4A, AAC, OGG, FLAC, WAV, WebM all work.

## `capture-windows.ps1` — live mic capture on Windows

For real-time capture during conversations. Chunks every N seconds and POSTs as the conversation runs.

**Setup (Windows host):**
```powershell
# install ffmpeg.exe if not already
winget install Gyan.FFmpeg

# set env vars (PowerShell user profile)
[System.Environment]::SetEnvironmentVariable("LIVECAPTURE_URL", "https://livecapture.robert-chuvala.workers.dev", "User")
[System.Environment]::SetEnvironmentVariable("LIVECAPTURE_TOKEN", "<paste from 1P Fleet-Shared/livecapture-ingest-token>", "User")

# find your mic name
ffmpeg -list_devices true -f dshow -i dummy
```

**Run:**
```powershell
.\capture-windows.ps1 -Label "wally-followup" -Sensitivity work -Consented $true -Device "Microphone (Realtek High Definition Audio)"
```

Ctrl+C ends the session cleanly (closes session, clears KV pointer).

## Reading the transcripts back

```bash
# while a session is open
curl "$LIVECAPTURE_URL/read/current" -H "Authorization: Bearer $LIVECAPTURE_TOKEN" | jq

# any past session, full transcript
curl "$LIVECAPTURE_URL/read/sessions/<session_id>" -H "Authorization: Bearer $LIVECAPTURE_TOKEN" | jq

# search across all captured corpus
curl "$LIVECAPTURE_URL/read/search?q=wally" -H "Authorization: Bearer $LIVECAPTURE_TOKEN" | jq
```
