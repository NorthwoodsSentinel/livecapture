# livecapture

Live audio capture → Cloudflare substrate → fleet-readable transcript. The fleet (Margin, CeeCee, Caddie, others) gains the ability to follow a live conversation Rob is having and pull relevant memory, surface context, or assist post-meeting without Rob having to re-narrate.

Origin: 2026-06-06. Wally meeting on 2026-06-05 exposed the gap — Rob walked out of a substantive conversation carrying context only he could replay. The build is the substrate-side fix.

Sits alongside the sovereignty-essay arc: substrate sovereignty (CF tenant), classifier sovereignty (Rob-shaped overseer), cognition sovereignty (local-inference fallback). Live-capture is the **input** layer that adds to the years-of-interaction substrate the classifier-sovereignty layer trains on.

---

## Architecture (at a glance)

```
Windows host                  Cloudflare tenant              Fleet
─────────────                  ─────────────────              ──────
[capture client] ─audio──>    [Worker /ingest]
                                    │
                                    ├── R2: raw audio chunks
                                    │
                                    ├── transcription path:
                                    │     - Workers AI (default) OR
                                    │     - local Whisper (sensitive) OR
                                    │     - external API (low-risk)
                                    │
                                    ├── D1: transcript chunks + metadata
                                    │
                                    └── KV: active-session pointer

                              [Worker /read]  <───────────  fleet members
                                  - get current conversation
                                  - get recent capture
                                  - search capture corpus
```

## Components

| Component | Purpose | Lives in |
|---|---|---|
| **Capture client** | Records audio on Windows; chunks + ships to ingest | Windows host (process or tray app) |
| **Ingest Worker** | Receives chunks, writes raw + dispatches transcription | Cloudflare Worker |
| **Transcription path** | Audio → text. Multi-tier (sovereignty-graded) | Workers AI / local Surface Pro / external |
| **Storage** | R2 (raw), D1 (transcripts), KV (session pointer) | Cloudflare |
| **Read Worker / MCP tool** | Fleet-facing query surface | Cloudflare Worker + later daemon MCP tool |

## Data shape (sovereignty-graded sessions)

A `session` is one conversation. It carries a sensitivity tier that drives every downstream decision (transcription path, retention, sharing). Tiers:

- **`public`** — meetings the other party knows are recorded; talks, podcasts. External transcription API allowed.
- **`work`** — internal meetings, customer calls. Workers AI default; local Whisper option.
- **`sensitive`** — privileged conversations (legal, medical, intimate). Local Whisper **only**. Never leaves the boundary.

Sensitivity is declared at session-start by the capture client (user picks before Record). Default = `work`. Sensitive mode never falls back to external on any failure path — it fails closed, not open.

## Open architectural decisions

These need Rob's input or are stake-in-the-ground choices to confirm or override:

1. **Capture client substrate.** Three candidates on Windows:
   - PowerShell + WASAPI loopback (system audio) + mic — native, scriptable, no install
   - Python pyaudio + pywin32 — flexible, cross-platform-portable, needs runtime
   - Small Tauri/Electron tray app — best UX, biggest build cost
   - **Working assumption**: start with PowerShell script for mic-only in-person meetings; add WASAPI loopback for Discord/Signal later.
2. **Auth shape.** CF Access service-token (matches the NIT pattern and the rest of the sovereign stack) vs. a bearer token in 1Password. **Working assumption**: CF Access service-token, vault item `livecapture-ingest`, follow the credentials-via-1password-doctrine pattern.
3. **Worker domain.** Subdomain on `northwoodssentinel.com` (e.g. `capture.northwoodssentinel.com`)? Separate workers.dev hostname? **Working assumption**: `capture.northwoodssentinel.com` under CF Access for ingest, separate `/read` route gated by fleet-member auth.
4. **Retention.** How long does raw audio live in R2? Transcripts in D1? **Working assumption**: raw audio 90 days then archived to cold tier; transcripts permanent. Sensitive-tier audio + transcripts: principal-controlled deletion at any time, no automated retention extension.
5. **Default transcription tier in MVP.** Workers AI is fastest path to "works end-to-end." Local Whisper is the sovereignty-correct default for the security-research arc but is a separate build. **Working assumption**: Workers AI for MVP; local-Whisper routing path stubbed in code so we can plug it in without restructuring.

If any of these working assumptions is wrong, change it before code goes too far.

## Build status

- [x] Repo scaffold (`bun init`, TypeScript strict, `wrangler.toml` skeleton)
- [x] Data model in `src/types.ts`
- [x] Minimal `/health` route on the Worker
- [ ] R2 bucket + D1 schema
- [ ] `/ingest` route accepting audio chunks
- [ ] Workers AI Whisper transcription handler
- [ ] `/read` query surface
- [ ] Capture client (Windows PowerShell MVP)
- [ ] CF Access policy + service-token in 1Password
- [ ] Fleet read MCP tool on daemon

## Sovereignty discipline (carry-forward from credentials doctrine)

- Audio of third-party voices is captured under per-conversation consent that the user declares at session-start. Recording without disclosure is the user's responsibility; the system does not pretend to be a consent-management layer.
- Sensitive-tier never leaves the principal's tenant. Local Whisper or no transcription.
- Credentials follow the `credentials-via-1password-doctrine` from fleet-bridge: 1P vault, op CLI, session-init populates env, biometric/YubiKey unlock.
- Verification of credential install: length + first-N-chars + HTTP probe code. Never echo raw values.

— Margin, 2026-06-06
