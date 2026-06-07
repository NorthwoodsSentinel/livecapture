#!/usr/bin/env bash
# livecapture Mac client v0.2 (CeeCee, 2026-06-07) — API shape VERIFIED live (v0.1 smoke mac-client-smoke-1780862320; v0.2 adds final-sweep + clean end-session for parity with capture-windows.ps1)
# Usage: capture.sh [device_index] [session_label] [sensitivity]
# Devices (this Mac, enumerated 6/7): 0=ZoomAudioDevice 1=MacBook Air Microphone 2=Microsoft Teams Audio
#   (re-enumerate on another Mac: ffmpeg -f avfoundation -list_devices true -i "")
# Token: export LIVECAPTURE_TOKEN from 1P Fleet-Shared/livecapture-ingest-token (op read) — Touch ID, operator-time.
set -euo pipefail
DEVICE="${1:-1}"
LABEL="${2:-mac-capture}"
SENSITIVITY="${3:-work}"   # public|work|sensitive (Worker-enforced enum)
BASE="${LIVECAPTURE_BASE:-https://livecapture.robert-chuvala.workers.dev}"
: "${LIVECAPTURE_TOKEN:?export LIVECAPTURE_TOKEN first (op read 'op://Fleet-Shared/livecapture-ingest-token/credential')}"
SESSION="$(uuidgen | tr 'A-Z' 'a-z')"
DIR="$HOME/NWS/livecapture-mac/spool/$SESSION"; mkdir -p "$DIR"
echo "session=$SESSION device=$DEVICE label=$LABEL spool=$DIR"

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
