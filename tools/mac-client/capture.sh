#!/usr/bin/env bash
# livecapture Mac client v0.3 (CeeCee, 2026-06-07) — API shape VERIFIED live (v0.1 smoke mac-client-smoke-1780862320; v0.2 final-sweep + clean end-session; v0.3 device-by-NAME)
# Usage: capture.sh [device_name] [session_label] [sensitivity]
# v0.3: avfoundation indices SHUFFLE when devices come and go (XM6 connect reordered them 6/7;
#   BlackHole install reordered them again post-reboot — the 16:32 smoke recorded a Zoom device's
#   silence because of this). Select by exact NAME, resolved to an index at launch.
#   List names: ffmpeg -f avfoundation -list_devices true -i ""
#   Common picks: "MacBook Air Microphone" (mic only) · "BlackHole 2ch" (system audio only)
#                 "NWS Aggregate" (mic+BlackHole = full call, both sides)
#   A bare integer still works (passthrough, with a warning) for back-compat.
# Token: export LIVECAPTURE_TOKEN from 1P Fleet-Shared/livecapture-ingest-token (op read) — Touch ID, operator-time.
set -euo pipefail
DEVICE_ARG="${1:-MacBook Air Microphone}"
LABEL="${2:-mac-capture}"
SENSITIVITY="${3:-work}"   # public|work|sensitive (Worker-enforced enum)

resolve_device() {  # $1 = exact device name → echoes current avfoundation audio index
  local list line
  list=$(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 || true)
  list=${list#*AVFoundation audio devices:}   # drop the video-device section
  while IFS= read -r line; do
    [[ $line =~ \[([0-9]+)\]\ (.+)$ ]] || continue
    if [ "${BASH_REMATCH[2]}" = "$1" ]; then echo "${BASH_REMATCH[1]}"; return 0; fi
  done <<<"$list"
  return 1
}

if [[ $DEVICE_ARG =~ ^[0-9]+$ ]]; then
  DEVICE="$DEVICE_ARG"
  echo "WARNING: raw index $DEVICE — indices shuffle on device add/remove; prefer a name" >&2
else
  DEVICE=$(resolve_device "$DEVICE_ARG") || {
    echo "device not found: '$DEVICE_ARG' — available audio devices:" >&2
    ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | sed -n '/audio devices/,$p' | grep -o '\[[0-9]*\] .*' >&2 || true
    exit 1
  }
fi
BASE="${LIVECAPTURE_BASE:-https://livecapture.robert-chuvala.workers.dev}"
: "${LIVECAPTURE_TOKEN:?export LIVECAPTURE_TOKEN first (op read 'op://Fleet-Shared/livecapture-ingest-token/credential')}"
SESSION="$(uuidgen | tr 'A-Z' 'a-z')"
DIR="$HOME/NWS/livecapture-mac/spool/$SESSION"; mkdir -p "$DIR"
echo "session=$SESSION device=[$DEVICE] \"$DEVICE_ARG\" label=$LABEL spool=$DIR"

# VERIFIED SHAPE: POST /ingest?session_id=&sequence=N ; first chunk carries session metadata headers
upload_chunk() {  # $1 = wav path; returns curl's status
  local f="$1" seq
  seq=$((10#$(basename "$f" .wav | cut -d- -f2)))
  local HDRS=(-H "Authorization: Bearer $LIVECAPTURE_TOKEN" -H "Content-Type: audio/wav")
  if [ "$seq" -eq 0 ]; then
    HDRS+=(-H "X-Session-Label: $LABEL" -H "X-Session-Sensitivity: $SENSITIVITY" -H "X-Client-Id: ceecee-mac" -H "X-Session-Consented: true")
  fi
  if curl -sS -f -X POST "${HDRS[@]}" --data-binary "@$f" "$BASE/ingest?session_id=$SESSION&sequence=$seq" >/dev/null; then
    UPLOADED+=("$f"); echo "↑ $seq"
  else
    echo "upload failed for $seq — kept in spool, will retry next pass"  # never lose audio; spool is the buffer
    return 1
  fi
}

# 60s chunks, 16kHz mono (Whisper-friendly), segmenting continuously until Ctrl-C
ffmpeg -hide_banner -loglevel warning -f avfoundation -i ":$DEVICE" \
  -ac 1 -ar 16000 -f segment -segment_time 60 -reset_timestamps 1 \
  "$DIR/chunk-%04d.wav" &
FFPID=$!
trap 'kill $FFPID 2>/dev/null; echo "capture stopped"' INT TERM

# uploader loop: ship each completed chunk (skip the newest — still being written)
UPLOADED=()
while kill -0 $FFPID 2>/dev/null; do
  sleep 5
  for f in "$DIR"/chunk-*.wav; do
    [ -e "$f" ] || continue
    [[ " ${UPLOADED[*]-} " == *" $f "* ]] && continue
    newest=$(ls -t "$DIR"/chunk-*.wav | head -1)
    [ "$f" = "$newest" ] && continue
    upload_chunk "$f" || true
  done
done
wait $FFPID 2>/dev/null || true

# final sweep: ffmpeg is gone, every chunk (incl. the last partial) is complete — ship the stragglers
for f in "$DIR"/chunk-*.wav; do
  [ -e "$f" ] || continue
  [[ " ${UPLOADED[*]-} " == *" $f "* ]] && continue
  upload_chunk "$f" || echo "FINAL-SWEEP MISS: $f left in spool — replay manually (tools/replay-file.ts)"
done

# close the session cleanly (parity with capture-windows.ps1: clears the /read/current pointer)
if curl -sS -f -X POST -H "Authorization: Bearer $LIVECAPTURE_TOKEN" "$BASE/sessions/$SESSION/end" >/dev/null; then
  echo "session ended cleanly: $SESSION"
else
  echo "end-session failed — session left open; close manually: curl -X POST $BASE/sessions/$SESSION/end -H 'Authorization: Bearer …'"
fi
