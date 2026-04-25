# Mnemo Voice

WebSocket voice channel adapter for Hermes agent.

## Quick Start

```bash
pip install -r requirements.txt
python launch.py
```

Then open `http://localhost:8765` in a browser. Push the mic button, talk, release.

## Standalone Mode

By default runs in echo mode — transcribes your voice and speaks it back. Good for testing the pipeline.

## With Hermes Gateway

Add to your Hermes config:

```yaml
platforms:
  voice:
    enabled: true
    port: 8765
```

## Architecture

See [DESIGN.md](DESIGN.md).

## Components

| Component | File | Purpose |
|-----------|------|---------|
| Voice Server | `server/main.py` | WebSocket server, audio pipeline orchestration |
| VAD | `server/vad.py` | Silero VAD — detects speech boundaries |
| STT | `server/stt.py` | Whisper — transcribes speech to text |
| TTS | `server/tts.py` | Kokoros — synthesizes text to audio |
| Audio Utils | `server/audio.py` | PCM/WAV conversion, resampling |
| Hermes Adapter | `adapter/voice_adapter.py` | BasePlatformAdapter implementation |
| Web Client | `client/index.html` + `client/app.js` | Browser mic + playback UI |
| Launcher | `launch.py` | Standalone startup script |

## Pipeline

```
Browser mic → PCM chunks → WebSocket → Silero VAD
                                       ↓ speech detected
                               Buffer audio → Whisper STT → text
                                       ↓
                               Hermes agent (tools, memory, etc.)
                                       ↓ response text
                               Kokoros TTS → PCM chunks
                                       ↓
                               WebSocket → Browser playback
```

## Key Bindings

- **Push to talk**: Hold mic button (mouse or touch)
- **Barge in**: Start talking while agent is speaking to interrupt
- **Text input**: Type in the text box as fallback

## Status

🚧 Pre-alpha. Pipeline works, needs real-world testing and Hermes integration.
