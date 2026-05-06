# AI-tubing — TODO & Ideas

Baseline working as of 2026-04-26. Two main tracks for next steps.

---

## Track 1: Pipeline Optimization / Streaming

Current flow is full request-response: STT finishes → POST full text → gateway runs agent to completion → returns full text → TTS runs on whole thing → sends audio. That's 3+ seconds of dead air between user stopping and avatar replying.

### 1.1 Streaming TTS
**Impact: High | Effort: Medium**

Kokoros can chunk output. Stream audio to the browser as it's generated instead of buffering the entire response. Biggest perceptual win — avatar starts talking sooner even if the full response isn't ready yet.

- Kokoros already generates in chunks, we just need to stream them over WebSocket instead of buffering
- Frontend already receives audio via `send_audio()` — just needs to play partial chunks
- Partial playback + queue management (what happens if a new sentence arrives mid-playback?)

### 1.2 Streaming LLM (Agent → TTS pipeline)
**Impact: Very High | Effort: High**

Gateway streams agent tokens back to AI-tubing, which feeds them to TTS in sentence-level chunks. Like ChatGPT reading aloud while still typing. This is the real prize.

- Requires webhook protocol change: SSE or chunked transfer instead of single JSON response
- AI-tubing needs a sentence buffer — accumulate tokens until `.` / `!` / `?`, then TTS that chunk
- Voice adapter needs to intercept the stream, not wait for `on_processing_complete`
- Cancellation: if agent is still streaming but user starts talking, need to cut off mid-sentence
- This subsumes 1.1 if done right (streaming LLM → chunked TTS → streaming audio)

### 1.3 Streaming STT / Faster Whisper
**Impact: Low-Medium | Effort: Low**

Streaming STT (faster-whisper with partial results) could start the LLM call sooner on longer utterances. Lower priority since Whisper is already fast on short utterances.

- More relevant for long-form voice input (paragraphs of speech)
- Could combine with endpointing: start LLM inference on partial transcript while VAD confirms end-of-utterance

---

## Track 2: Avatar Control from Hermes

Right now the avatar driver is purely reactive — reads `agentState` (idle/listening/thinking/speaking) and audio amplitude, maps to expressions. The agent has zero intentional control over how it looks.

The `AvatarFrame` type already has `expression` and `lookAt` fields. Shape supports it. What's missing is the control channel.

### 2.1 Agent Tool for Avatar Events (recommended)
**Impact: High | Effort: Medium**

A Hermes tool like `set_avatar(expression: "happy", lookAt: {x: -0.5, y: 0, z: -1})`. Voice adapter intercepts the tool call and forwards it as a WebSocket event to the browser.

- Fits Hermes tool model — agent can intentionally emote
- WebSocket already has event channel (`send_event`)
- Adapter intercepts tool call, doesn't speak it, forwards as WS event
- Tool returns silently (no text in chat output)
- Could support: expression, lookAt, gesture triggers (wave, nod, shake)
- Frontend `useAvatarDriver` already handles expression state — just needs to accept external overrides

### 2.2 Structured Tags in Agent Output
**Impact: Medium | Effort: Low**

Agent emits `[expression:happy]` or `[look:left]` inline in text. Frontend strips them and applies. Quick hack, works tomorrow, but fragile and mixes concerns.

- Regex parse on frontend
- Agent has to remember to tag things
- No external tool registration needed
- Could be a stepping stone to 2.1

### 2.3 Sentiment Auto-Classifier
**Impact: Low-Medium | Effort: Medium**

Run a lightweight classifier on agent text output, auto-map to expressions. Zero agent involvement, but less intentional control and adds latency.

- Could use a tiny model or even rule-based (exclamation marks → surprised, questions → lookUp)
- Hands-free but blunt instrument
- Better as a fallback/default layer underneath 2.1

---

## Other Ideas

- **Barge-in**: User interrupts avatar mid-speech. Cancel current TTS playback, cut agent response. WebSocket event from browser → server → gateway.
- **Multiple VRM models**: Hot-swap avatars. Agent tool or UI picker.
- **Eye tracking**: Randomized idle eye movement, look toward user when speaking (webcam? or just fake it).
- **Background effects**: Ambient particles, lighting changes tied to expression state.

---

## Done

- [x] Decoupled AI-tubing from gateway (separate processes, ports 8765/8766)
- [x] Voice adapter as thin HTTP webhook (like Telegram channel)
- [x] Webhook response capture via `on_processing_complete`
- [x] Voice platform excluded from home-channel nag
- [x] AI-tubing launchd plist with KeepAlive
- [x] VRM avatar loading + amplitude-based lip sync
- [x] Agent state → expression mapping (idle/listening/thinking/speaking)
- [x] Avatar tag system — `[expression:happy]`, `[look:left]`, `[tilt:right]` parsed from agent text, applied to VRM bones/expressions, auto-clear after 4s
