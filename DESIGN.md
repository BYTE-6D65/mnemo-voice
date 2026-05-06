# AI-tubing — WebSocket Voice Channel for Hermes

## What

A standalone WebSocket voice server + React frontend that acts as a channel for the Hermes agent. Browser connects, talks, AI-tubing handles the audio pipeline (VAD → STT → TTS), the Hermes gateway handles the agent (tools, memory, reasoning). Two separate processes communicating over HTTP.

## Why decoupled

The voice server is a *channel*, like Telegram or Discord. It connects to the Hermes gateway over HTTP — it doesn't run inside it. This means:

- **Independent restarts** — rebuild the frontend, restart AI-tubing, update TTS models, all without touching the gateway
- **Failure isolation** — if the voice server crashes, Telegram keeps working
- **Development** — run in echo mode without the gateway, test the full audio pipeline standalone
- **Resource isolation** — ML models (Whisper, Kokoros) don't inflate the gateway's memory

## Architecture

```
┌──────────────────────────────┐
│        AI-tubing :8765       │
│    (standalone process)      │
│                              │
│  Browser ── /ws ──▶ VAD     │
│                    │         │
│                    ▼         │
│                  Whisper     │        POST /voice/message
│                    │         │ ──────────────────────────▶ Gateway :8766
│                    ▼         │ ◀────────────────────────── {response}
│              text ───────────┤         (agent runs here)
│                    │         │
│                    ▼         │
│               Kokoros TTS    │
│                    │         │
│                    ▼         │
│              PCM ──▶ Browser │
│                              │
│  / (static React frontend)   │
└──────────────────────────────┘
```

## Pipeline

```
1. Browser captures mic audio (Web Audio API, 16kHz PCM)
2. Streams PCM chunks to /ws via WebSocket
3. Silero VAD detects speech boundaries
4. On speech end: buffer → Whisper STT → text
5. Utterance merge: hold 1.8s, merge if user resumes
6. POST text to gateway webhook → agent processes → response
7. Kokoros TTS → PCM chunks → WebSocket → browser playback
8. Barge-in: client sends signal, server stops TTS delivery
```

## Components

### Server (`server/`)
- `main.py` — VoiceServer: standalone aiohttp app (WebSocket + HTTP + static)
- `vad.py` — Silero VAD + EnergyVAD wrappers
- `stt.py` — Whisper transcription (faster-whisper)
- `tts.py` — Kokoros TTS (mlx-audio)
- `audio.py` — PCM/WAV conversion

### Hermes Adapter (`adapter/`)
- `voice_adapter.py` — thin webhook listener (BasePlatformAdapter). No ML, no WebSocket server. Just receives POSTs from AI-tubing and returns agent responses.

### Client (`client/`)
- React 19 + Vite + TypeScript
- Web Audio API for mic capture and playback
- VRM 3D avatar (R3F/three-vrm) — WIP
- Warm dark glassmorphism UI

## Config

### AI-tubing (CLI flags)

```bash
python -m server.main \
  --host 0.0.0.0 \
  --port 8765 \
  --whisper-model base.en \
  --kokoros-voice af_heart \
  --gateway http://127.0.0.1:8766   # Hermes webhook URL
```

### Hermes gateway (config.yaml)

```yaml
platforms:
  voice:
    enabled: true
    extra:
      webhook_host: "127.0.0.1"
      webhook_port: 8766
      voice_server_url: "http://127.0.0.1:8765"
```

## Running

```bash
# Standalone (echo mode — no gateway):
python launch.py

# With gateway:
python -m server.main --gateway http://127.0.0.1:8766

# Frontend rebuild (zero downtime — no restart needed):
cd client && bun run build
```
