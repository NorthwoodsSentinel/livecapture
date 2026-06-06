# capture-windows.ps1 — live mic capture on Windows; chunks every N seconds; POSTs to livecapture.
#
# Requirements:
#   - ffmpeg.exe in PATH (winget install Gyan.FFmpeg, or chocolatey ffmpeg)
#   - LIVECAPTURE_URL and LIVECAPTURE_TOKEN as user env vars (or pass via -Url / -Token)
#
# Usage:
#   .\capture-windows.ps1 -Label "wally-followup" -Sensitivity work -Consented $true
#   .\capture-windows.ps1 -Label "team-standup" -Sensitivity work -ChunkSec 20 -Device "Microphone (Realtek...)"
#
# To find your mic device name:
#   ffmpeg -list_devices true -f dshow -i dummy
# (Pick the audio line that starts with [dshow] @ ... and copy the name between the quotes.)
#
# Stop capture: Ctrl+C. The script ends the session and clears the KV pointer.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$Label,

    [ValidateSet("public", "work", "sensitive")]
    [string]$Sensitivity = "work",

    [bool]$Consented = $false,

    [ValidateRange(5, 60)]
    [int]$ChunkSec = 20,

    [string]$Device = "",

    [string]$Url = $env:LIVECAPTURE_URL,

    [string]$Token = $env:LIVECAPTURE_TOKEN,

    [string]$ClientId = "$env:COMPUTERNAME-mic"
)

# Discipline: do not log Token. Show length + prefix only.
function Mask-Secret([string]$v) {
    if ([string]::IsNullOrEmpty($v)) { return "<EMPTY>" }
    return "len=$($v.Length) prefix=$($v.Substring(0,[Math]::Min(6,$v.Length)))<REDACTED>"
}

if (-not $Url -or -not $Token) {
    Write-Error "LIVECAPTURE_URL and LIVECAPTURE_TOKEN must be set as env vars or passed via -Url / -Token."
    exit 2
}

$ffmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
    Write-Error "ffmpeg.exe not found in PATH. Install with: winget install Gyan.FFmpeg"
    exit 2
}

if (-not $Device) {
    Write-Host "No -Device specified. Listing dshow audio devices..."
    & ffmpeg.exe -list_devices true -f dshow -i dummy 2>&1 | Select-String -Pattern '\(audio\)'
    Write-Host ""
    Write-Error "Pass the audio device name with -Device 'Microphone (...)'"
    exit 2
}

$SessionId = [guid]::NewGuid().ToString()
$WorkDir = Join-Path $env:TEMP "livecapture-$($SessionId)"
New-Item -ItemType Directory -Path $WorkDir | Out-Null

Write-Host "livecapture session start"
Write-Host "  session_id:  $SessionId"
Write-Host "  label:       $Label"
Write-Host "  sensitivity: $Sensitivity"
Write-Host "  consented:   $Consented"
Write-Host "  device:      $Device"
Write-Host "  chunk_sec:   $ChunkSec"
Write-Host "  target:      $Url/ingest"
Write-Host "  token:       $(Mask-Secret $Token)"
Write-Host "  workdir:     $WorkDir"
Write-Host ""

if ($Sensitivity -eq "sensitive") {
    Write-Warning "sensitivity=sensitive — chunks will NOT be transcribed via Workers AI."
    Write-Warning "They will be stored in R2/D1 and queued for local-Whisper pickup."
}

# Start ffmpeg as background process — captures from dshow, segments into N-second WAVs.
$pattern = Join-Path $WorkDir "chunk_%05d.wav"
$ffmpegArgs = @(
    "-y",
    "-loglevel", "warning",
    "-f", "dshow",
    "-i", "audio=$Device",
    "-ac", "1",
    "-ar", "16000",
    "-f", "segment",
    "-segment_time", "$ChunkSec",
    "-reset_timestamps", "1",
    "-c:a", "pcm_s16le",
    $pattern
)
$ffmpegProcess = Start-Process -FilePath "ffmpeg.exe" -ArgumentList $ffmpegArgs -PassThru -NoNewWindow -RedirectStandardError (Join-Path $WorkDir "ffmpeg.err.log")

$sentSequences = New-Object 'System.Collections.Generic.HashSet[int]'
$startedAt = (Get-Date).ToUniversalTime().ToString("o")
$ctrlcHit = $false

# Register Ctrl+C handler so we end the session cleanly.
[Console]::TreatControlCAsInput = $false
$null = Register-EngineEvent PowerShell.Exiting -Action {
    Write-Host "exit handler fired"
}

function Post-Chunk([string]$filePath, [int]$sequence, [int]$durationMs) {
    $headers = @{
        "Authorization" = "Bearer $Token"
        "Content-Type"  = "audio/wav"
    }
    if ($sequence -eq 0) {
        $headers["X-Session-Label"] = $Label
        $headers["X-Session-Sensitivity"] = $Sensitivity
        $headers["X-Session-Consented"] = if ($Consented) { "true" } else { "false" }
        $headers["X-Client-Id"] = $ClientId
    }
    $recordedAt = (Get-Date).ToUniversalTime().AddSeconds(- $ChunkSec).ToString("o")
    $qs = "session_id=$SessionId&sequence=$sequence&mime=audio/wav&duration_ms=$durationMs&recorded_at=$recordedAt"
    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    try {
        $resp = Invoke-WebRequest -Uri "$Url/ingest?$qs" -Method Post -Headers $headers -Body $bytes -ContentType "audio/wav" -ErrorAction Stop
        $obj = $resp.Content | ConvertFrom-Json
        if ($obj.ok) {
            $cid = $obj.chunk_id.Substring(0, 8)
            Write-Host ("  [seq {0:D3}] OK chunk_id={1} {2}" -f $sequence, $cid, $obj.transcription)
        } else {
            Write-Warning "  [seq $sequence] non-ok body: $($resp.Content)"
        }
    } catch {
        Write-Warning "  [seq $sequence] POST failed: $($_.Exception.Message)"
    }
}

function End-Session {
    Write-Host ""
    Write-Host "ending session..."
    try {
        $resp = Invoke-WebRequest -Uri "$Url/sessions/$SessionId/end" -Method Post -Headers @{ "Authorization" = "Bearer $Token" } -ErrorAction Stop
        Write-Host "  $($resp.Content)"
    } catch {
        Write-Warning "  end-session failed: $($_.Exception.Message)"
    }
    Write-Host ""
    Write-Host "read transcripts when ready:"
    Write-Host "  curl `"$Url/read/sessions/$SessionId`" -H `"Authorization: Bearer `$LIVECAPTURE_TOKEN`""
}

# Main polling loop — watch the workdir for completed chunks ffmpeg has rotated past.
# A chunk is "complete" when a higher-numbered chunk has started (file size > 0 for chunk+1).
try {
    while ($true) {
        if ($ffmpegProcess.HasExited) {
            Write-Warning "ffmpeg exited unexpectedly (code $($ffmpegProcess.ExitCode)). See $WorkDir\ffmpeg.err.log"
            break
        }
        $files = Get-ChildItem -Path $WorkDir -Filter "chunk_*.wav" | Sort-Object Name
        for ($i = 0; $i -lt $files.Count - 1; $i++) {
            $name = $files[$i].Name
            $seq = [int]($name.Substring(6, 5))
            if ($sentSequences.Contains($seq)) { continue }
            $bytes = $files[$i].Length
            if ($bytes -lt 1024) { continue }   # too small to be a valid wav
            Post-Chunk -filePath $files[$i].FullName -sequence $seq -durationMs ($ChunkSec * 1000)
            $sentSequences.Add($seq) | Out-Null
            Remove-Item $files[$i].FullName -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    if (-not $ffmpegProcess.HasExited) {
        Stop-Process -Id $ffmpegProcess.Id -Force -ErrorAction SilentlyContinue
    }
    # Send any final chunk that ffmpeg left in the workdir.
    $finalFiles = Get-ChildItem -Path $WorkDir -Filter "chunk_*.wav" -ErrorAction SilentlyContinue | Sort-Object Name
    foreach ($f in $finalFiles) {
        $seq = [int]($f.Name.Substring(6, 5))
        if ($sentSequences.Contains($seq)) { continue }
        if ($f.Length -lt 1024) { continue }
        Post-Chunk -filePath $f.FullName -sequence $seq -durationMs ($ChunkSec * 1000)
        $sentSequences.Add($seq) | Out-Null
    }
    End-Session
    Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
}
