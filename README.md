# AI-tubing

WebSocket voice channel for the Hermes agent. Standalone process — handles browser audio pipeline (VAD → STT → TTS), talks to Hermes gateway over HTTP.

**Was:** mnemo-voice (renamed April 2026)

## Quick Start

```bash
pip install -r requirements.txt

# Echo mode (no gateway needed):
python launch.py

# With Hermes gateway:
python -m server.main --gateway http://127.0.0.1:8766
```

Open `http://localhost:8765` in a browser. Toggle the mic, talk.

## Architecture

Two decoupled processes over HTTP:

- **AI-tubing (port 8765):** WebSocket server, VAD, STT, TTS, React frontend. Runs standalone.
- **Hermes gateway (port 8766 webhook):** Agent logic, tools, memory. Receives transcribed text, returns agent response.

Either process can restart without affecting the other. See [DESIGN.md](DESIGN.md).

## Components

| Component | File | Purpose |
|-----------|------|---------|
| Voice Server | `server/main.py` | Standalone aiohttp app — WebSocket, VAD, STT, TTS, static files |
| VAD | `server/vad.py` | Silero VAD + EnergyVAD — speech boundary detection |
| STT | `server/stt.py` | Whisper — speech to text |
| TTS | `server/tts.py` | Kokoros — text to audio |
| Audio Utils | `server/audio.py` | PCM/WAV conversion |
| Hermes Adapter | `adapter/voice_adapter.py` | Thin webhook — receives text, returns agent response |
| Web Client | `client/src/` | React 19 + Vite + TypeScript, VRM avatar (WIP) |
| Launcher | `launch.py` | Standalone dev server (echo mode) |

## Hermes Integration

```yaml
# In ~/.hermes/config.yaml:
platforms:
  voice:
    enabled: true
    extra:
      webhook_host: "127.0.0.1"
      webhook_port: 8766
      voice_server_url: "http://127.0.0.1:8765"
```

## Frontend

```bash
cd client
bun install
bun run build   # output → client/dist/
```

Rebuilds are zero-downtime. No process restart needed.

## Status

Voice pipeline works. Decoupled from gateway. VRM avatar WIP.
