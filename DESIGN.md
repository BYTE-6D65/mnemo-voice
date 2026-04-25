# Mnemo Voice — WebSocket Voice Channel for Hermes

## What

A WebSocket-based voice channel adapter for Hermes agent. Browser connects, talks, I listen, think, respond with audio. Same agent, same tools, same memory — just a new I/O surface.

## Why

The text-only interaction model is one surface. Voice is another. A WebSocket voice layer means:

- **Device hopping** — browser on phone, laptop, desktop, all connect to the same agent session
- **Always-listening** — VAD detects speech, STT transcribes, agent responds, TTS speaks back
- **Real agent, not chatbot** — full Hermes tool access through voice
- **Later: portable** — the adapter interface is clean enough to point at pi-agent-core or yuyu

## Architecture

```
┌─────────────────────────────────────────────┐
│  WebSocket Server (aiohttp / FastAPI)       │
│                                              │
│  ┌──────────┐   ┌──────────────────────────┐│
│  │ VAD      │   │ Hermes Gateway Adapter   ││
│  │ (silero) │──▶│ (platforms/voice.py)     ││
│  └──────────┘   │                          ││
│       │         │  MessageEvent → agent    ││
│       ▼         │  agent response → TTS    ││
│  ┌──────────┐   │  audio → WebSocket       ││
│  │ Whisper  │   └──────────────────────────┘│
│  │ (STT)    │            │                  │
│  └──────────┘            ▼                  │
│                   ┌──────────────┐          │
│                   │ Kokoros TTS  │          │
│                   └──────┬───────┘          │
│                          │                  │
│              WebSocket ◀─┘                  │
│              (audio chunks + events)        │
└─────────────────────────────────────────────┘
           │
     ┌─────┴─────┐
     │  Browser  │
     │  (any)    │
     └───────────┘
```

## Pipeline

```
1. Browser captures mic audio (Web Audio API)
2. Streams chunks to server via WebSocket (Opus/PCM)
3. Server runs VAD (Silero VAD) on audio stream
4. On speech end: full utterance → Whisper STT → text
5. Text → Hermes MessageEvent → agent processes (tools, reasoning, etc.)
6. Agent response text → Kokoros TTS → audio chunks
7. Audio chunks → WebSocket → browser plays
8. Browser can send barge-in signal to cut off TTS
```

## Components

### Server (`server/`)
- `main.py` — WebSocket server entry point
- `vad.py` — Silero VAD wrapper (speech detection)
- `stt.py` — Whisper transcription
- `tts.py` — Kokoros TTS synthesis
- `audio.py` — Audio format conversion (resampling, encoding)

### Hermes Adapter (`adapter/`)
- `voice_adapter.py` — `BasePlatformAdapter` subclass
- Implements: connect, disconnect, send, send_audio, send_typing
- Translates between WebSocket events and Hermes MessageEvent/SendResult

### Client (`client/`)
- Static HTML/JS — no build step
- Web Audio API for mic capture and playback
- WebSocket client with reconnect logic
- Simple UI: waveform visualizer, status indicator, chat log

## Config

```yaml
voice:
  host: "0.0.0.0"
  port: 8765
  
  # STT
  whisper_model: "base.en"
  whisper_device: "cpu"        # "cuda" if GPU available
  
  # TTS  
  kokoros_voice: "af_heart"
  kokoros_device: "cpu"
  
  # VAD
  vad_threshold: 0.5
  vad_silence_duration: 0.8    # seconds of silence to end utterance
  
  # Audio
  sample_rate: 16000
  chunk_duration_ms: 480       # WebSocket chunk size
```

## Key Decisions

- **Silero VAD** — lightweight, accurate, runs on CPU, no external deps
- **Whisper** — proven STT, works offline, configurable model size
- **Kokoros** — already in the stack, af_heart voice, fast synthesis
- **PCM over WebSocket** — simplest audio transport, no codec complexity
- **aiohttp** — async WebSocket server, pairs well with Hermes's asyncio loop

## Not In Scope (v0.1)

- Speaker diarization (who's talking)
- Multiple simultaneous clients
- Voice activity while agent is speaking (full duplex)
- Emotion/tone detection
- Voice cloning
