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

## `mac-client/capture.sh` — live mic capture on macOS

For real-time capture during conversations on a Mac. ffmpeg/avfoundation, 60 s chunks at 16 kHz mono, uploads as the conversation runs, spool-buffered (failed uploads retry; audio is never lost).

**Setup (Mac):**
```bash
# ffmpeg if not already
brew install ffmpeg

# token
export LIVECAPTURE_TOKEN="$(op read 'op://Fleet-Shared/livecapture-ingest-token/credential')"

# see your device names
ffmpeg -f avfoundation -list_devices true -i ""

# system-audio capture: install BlackHole 2ch (https://existential.audio/blackhole/, reboot to
# register the driver), then create the two composite devices (idempotent, persists across reboots):
swift ./tools/mac-client/setup-audio-devices.swift
#   NWS Multi-Output = speakers+BlackHole → set as system OUTPUT during calls (hear while capturing)
#   NWS Aggregate    = mic+BlackHole      → capture INPUT for both sides of a call
swift ./tools/mac-client/set-output.swift "NWS Multi-Output"      # flip output (volume keys won't work on it)
swift ./tools/mac-client/set-output.swift "MacBook Air Speakers"  # flip back after the call
```

**Run:**
```bash
# select device by exact NAME — avfoundation indices SHUFFLE when devices come/go
# (a Bluetooth headset connecting or a driver install reorders them; a raw index can
# silently land on the wrong device and record silence)
./tools/mac-client/capture.sh "MacBook Air Microphone" "wally-followup" work  # mic only
./tools/mac-client/capture.sh "NWS Aggregate" "wally-followup" work          # full call, both sides
```

Ctrl+C ends the session cleanly — final sweep ships the last partial chunk, then closes the session (clears the `/read/current` pointer), parity with the Windows client. If a chunk can't upload even at sweep time it stays in `~/NWS/livecapture-mac/spool/<session>/` for manual replay via `replay-file.ts`.

## Reading the transcripts back

```bash
# while a session is open
curl "$LIVECAPTURE_URL/read/current" -H "Authorization: Bearer $LIVECAPTURE_TOKEN" | jq

# any past session, full transcript
curl "$LIVECAPTURE_URL/read/sessions/<session_id>" -H "Authorization: Bearer $LIVECAPTURE_TOKEN" | jq

# search across all captured corpus
curl "$LIVECAPTURE_URL/read/search?q=wally" -H "Authorization: Bearer $LIVECAPTURE_TOKEN" | jq
```
