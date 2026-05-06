"""
WebSocket voice server for Mnemo / AI-tubing.

Runs as a standalone process — owns:
  - WebSocket /ws (browser audio pipeline)
  - Static files / (React client)
  - VAD + STT + TTS (all ML work)
  - Agent callback via HTTP POST to gateway

The Hermes gateway connects to this as a thin channel adapter,
like Telegram connects to Telegram's API. Decoupled.

Usage:
  # Standalone (echo mode):
  python -m server.main

  # With gateway callback:
  python -m server.main --gateway http://127.0.0.1:8766
"""

import argparse
import asyncio
import json
import logging
import mimetypes
import os
import uuid
from pathlib import Path
from typing import Optional, Dict, Callable

import aiohttp
from aiohttp import web, WSMsgType

from .vad import SileroVAD
from .stt import WhisperSTT
from .tts import KokorosTTS
from .audio import pcm_to_wav_bytes

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("mnemo-voice")


class VoiceSession:
    """Per-client WebSocket voice session state."""

    def __init__(self, ws: web.WebSocketResponse, session_id: str,
                 vad: SileroVAD, stt: WhisperSTT, tts: KokorosTTS,
                 sample_rate: int = 16000):
        self.ws = ws
        self.session_id = session_id
        self.vad = vad
        self.stt = stt
        self.tts = tts
        self.sample_rate = sample_rate
        self.audio_buffer = bytearray()
        self.is_speaking = False
        self.is_agent_speaking = False
        # Mutex: only one TTS playback at a time per session
        self._playback_lock = asyncio.Lock()
        # Handle of the current playback task (for cancellation)
        self._playback_task: Optional[asyncio.Task] = None
        # VAD utterance merging
        self._pending_text: Optional[str] = None
        self._merge_timer_task: Optional[asyncio.Task] = None

    async def send_event(self, event_type: str, data: dict = None):
        payload = {"type": event_type}
        if data:
            payload["data"] = data
        await self.ws.send_json(payload)

    async def send_audio(self, pcm_bytes: bytes):
        await self.ws.send_bytes(pcm_bytes)

    def cancel_playback(self):
        """Cancel any in-progress TTS playback."""
        if self._playback_task and not self._playback_task.done():
            self._playback_task.cancel()
            self._playback_task = None


# How long to wait after VAD silence before committing the utterance.
UTTERANCE_MERGE_DELAY = 1.8  # seconds


class VoiceServer:
    """Standalone WebSocket voice server.

    Handles browser audio → VAD → STT → agent → TTS → browser.
    The agent can be:
      1. A local callback (echo mode or testing)
      2. An HTTP POST to a gateway URL (production)
    """

    def __init__(self, host: str = "0.0.0.0", port: int = 8765,
                 whisper_model: str = "base.en",
                 kokoros_voice: str = "af_heart",
                 vad_threshold: float = 0.5,
                 vad_silence_duration: float = 0.8,
                 sample_rate: int = 16000,
                 agent_handler: Optional[Callable] = None,
                 gateway_url: Optional[str] = None):
        self.host = host
        self.port = port
        self.sample_rate = sample_rate
        self.agent_handler = agent_handler
        self.gateway_url = gateway_url
        # HTTP session for gateway calls (created on first use)
        self._http_session: Optional[aiohttp.ClientSession] = None

        logger.info("Loading Whisper model: %s", whisper_model)
        self.stt = WhisperSTT(model_name=whisper_model)

        logger.info("Loading Kokoros TTS with voice: %s", kokoros_voice)
        self.tts = KokorosTTS(voice=kokoros_voice, target_sample_rate=sample_rate)

        self.vad_config = {
            "threshold": vad_threshold,
            "silence_duration": vad_silence_duration,
            "sample_rate": sample_rate,
        }

        self.sessions: Dict[str, VoiceSession] = {}
        self.static_dir = Path(__file__).resolve().parents[1] / "client" / "dist"

        self.app = web.Application()
        self.app.router.add_get("/ws", self.handle_websocket)
        self.app.router.add_get("/health", self.handle_health)
        self.app.router.add_get("/", self.handle_index)
        self.app.router.add_get("/{path:.*}", self.handle_static)
        self.app.on_cleanup.append(self._on_cleanup)

    async def _on_cleanup(self, app):
        if self._http_session:
            await self._http_session.close()
            self._http_session = None

    async def _get_http(self) -> aiohttp.ClientSession:
        if self._http_session is None or self._http_session.closed:
            self._http_session = aiohttp.ClientSession()
        return self._http_session

    # ------------------------------------------------------------------
    # HTTP endpoints
    # ------------------------------------------------------------------

    async def handle_health(self, request: web.Request) -> web.Response:
        return web.json_response({"status": "ok", "sessions": len(self.sessions)})

    async def handle_index(self, request: web.Request) -> web.FileResponse:
        if (self.static_dir / "index.html").is_file():
            return web.FileResponse(self.static_dir / "index.html")
        return web.Response(text="Voice client not built", status=404)

    async def handle_static(self, request: web.Request) -> web.StreamResponse:
        """Serve the built React app from aiohttp."""
        rel_path = request.match_info["path"].lstrip("/")
        candidate = (self.static_dir / rel_path).resolve()
        static_root = self.static_dir.resolve()

        if candidate.is_file() and static_root in candidate.parents:
            content_type, _ = mimetypes.guess_type(candidate.name)
            return web.FileResponse(
                candidate,
                headers={"Content-Type": content_type} if content_type else None,
            )
        if (static_root / "index.html").is_file():
            return web.FileResponse(static_root / "index.html")
        return web.Response(text="Not found", status=404)

    # ------------------------------------------------------------------
    # WebSocket
    # ------------------------------------------------------------------

    async def handle_websocket(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)

        # Persistent client ID via cookie
        CLIENT_ID_COOKIE = "mnemo_voice_id"
        client_id = request.cookies.get(CLIENT_ID_COOKIE)
        if not client_id:
            client_id = str(uuid.uuid4())[:8]
            ws.set_cookie(
                CLIENT_ID_COOKIE, client_id,
                max_age=365 * 86400,
                httponly=False,
                samesite="Lax",
                path="/",
            )

        vad = SileroVAD(**self.vad_config)
        session = VoiceSession(
            ws=ws, session_id=client_id, vad=vad,
            stt=self.stt, tts=self.tts, sample_rate=self.sample_rate,
        )
        self.sessions[client_id] = session

        logger.info("Voice client connected: %s", client_id)
        await session.send_event("connected", {"sample_rate": self.sample_rate})

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    await self._handle_text_message(session, msg.data)
                elif msg.type == WSMsgType.BINARY:
                    await self._handle_audio_chunk(session, msg.data)
                elif msg.type == WSMsgType.ERROR:
                    logger.error("WebSocket error for %s: %s", client_id, ws.exception())
        finally:
            logger.info("Voice client disconnected: %s", client_id)
            # Clean up merge timer
            if session._merge_timer_task and not session._merge_timer_task.done():
                session._merge_timer_task.cancel()
            session.cancel_playback()
            if self.sessions.get(client_id) is session:
                self.sessions.pop(client_id, None)
        return ws

    async def _handle_text_message(self, session: VoiceSession, data: str):
        try:
            msg = json.loads(data)
        except json.JSONDecodeError:
            return

        msg_type = msg.get("type")

        if msg_type == "barge_in":
            session.is_agent_speaking = False
            session.cancel_playback()
        elif msg_type == "text_input":
            text = msg.get("text", "").strip()
            if text:
                await self._dispatch_to_agent(session, text)

    async def _handle_audio_chunk(self, session: VoiceSession, pcm_bytes: bytes):
        is_speech = session.vad.process_chunk(pcm_bytes)

        if is_speech and not session.is_speaking:
            session.is_speaking = True
            session.audio_buffer = bytearray()
            # Cancel merge timer — user resumed speaking
            if session._merge_timer_task and not session._merge_timer_task.done():
                session._merge_timer_task.cancel()
                session._merge_timer_task = None
            await session.send_event("speech_start")

        if session.is_speaking:
            session.audio_buffer.extend(pcm_bytes)

        if not is_speech and session.is_speaking and session.vad.silence_exceeded:
            session.is_speaking = False
            await session.send_event("speech_end")
            if session.audio_buffer:
                await self._queue_transcription(session)

    async def _queue_transcription(self, session: VoiceSession):
        """Transcribe audio buffer, then start a merge timer.

        Holds the text for UTTERANCE_MERGE_DELAY. If the user resumes
        speaking during that window, fragments merge. On expiry,
        all accumulated text dispatches to the agent as one message.
        """
        await session.send_event("transcribing")
        pcm = bytes(session.audio_buffer)
        dur = len(pcm) / (self.sample_rate * 2)
        if dur < 0.45:
            await session.send_event("transcription_empty")
            return

        wav = pcm_to_wav_bytes(pcm, self.sample_rate)
        text = await asyncio.to_thread(session.stt.transcribe, wav)
        if not text.strip():
            await session.send_event("transcription_empty")
            return

        logger.info("Transcribed [%s]: %s", session.session_id, text)
        await session.send_event("transcription", {"text": text})

        # Accumulate fragment
        if session._pending_text:
            session._pending_text += " " + text
        else:
            session._pending_text = text

        # Cancel existing merge timer
        if session._merge_timer_task and not session._merge_timer_task.done():
            session._merge_timer_task.cancel()

        # Start new merge timer
        session._merge_timer_task = asyncio.create_task(
            self._merge_timer_callback(session)
        )

    async def _merge_timer_callback(self, session: VoiceSession):
        try:
            await asyncio.sleep(UTTERANCE_MERGE_DELAY)
            text = session._pending_text
            session._pending_text = None
            if text:
                logger.info("Merged utterance [%s]: %s", session.session_id, text)
                await self._dispatch_to_agent(session, text)
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------
    # Agent dispatch
    # ------------------------------------------------------------------

    async def _dispatch_to_agent(self, session: VoiceSession, text: str):
        """Send transcribed text to the agent and stream TTS response."""
        await session.send_event("agent_thinking")

        response_text = None

        if self.gateway_url:
            response_text = await self._call_gateway(session.session_id, text)
        elif self.agent_handler:
            response_text = await asyncio.to_thread(self.agent_handler, text)
        else:
            response_text = f"[echo] {text}"

        if not response_text:
            return

        logger.info("Agent response [%s]: %s", session.session_id, response_text[:100])

        # Cancel any in-progress playback
        session.cancel_playback()

        # Send text event
        await session.send_event("agent_response", {"text": response_text})

        # Stream TTS
        session._playback_task = asyncio.create_task(
            self._stream_tts(session, response_text)
        )

    async def _call_gateway(self, chat_id: str, text: str) -> Optional[str]:
        """POST transcribed text to the Hermes gateway webhook."""
        try:
            http = await self._get_http()
            async with http.post(
                f"{self.gateway_url}/voice/message",
                json={"chat_id": f"voice-{chat_id}", "text": text},
                timeout=aiohttp.ClientTimeout(total=120),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("response")
                else:
                    logger.error("Gateway returned %d: %s", resp.status, await resp.text())
                    return None
        except Exception as e:
            logger.error("Gateway call failed: %s", e)
            return None

    async def _stream_tts(self, session: VoiceSession, text: str):
        """Synthesize text via Kokoros and stream PCM chunks to the client."""
        async with session._playback_lock:
            session.is_agent_speaking = True
            await session.send_event("audio_start")
            try:
                audio = await asyncio.to_thread(session.tts.synthesize, text)
                if audio is None:
                    await session.send_event("audio_error", {"error": "TTS failed"})
                    return

                chunk_size = int(self.sample_rate * 2 * 0.12)  # 120ms chunks
                offset = 0
                while offset < len(audio):
                    if not session.is_agent_speaking:
                        break
                    await session.send_audio(audio[offset:offset + chunk_size])
                    offset += chunk_size
                    await asyncio.sleep(0.02)
            except asyncio.CancelledError:
                logger.debug("TTS playback cancelled for %s", session.session_id)
            finally:
                session.is_agent_speaking = False
                await session.send_event("audio_end")

    def set_agent_handler(self, handler: Callable):
        self.agent_handler = handler

    def run(self):
        logger.info("Starting voice server on %s:%d", self.host, self.port)
        web.run_app(self.app, host=self.host, port=self.port)


def main():
    parser = argparse.ArgumentParser(description="Mnemo Voice Server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--whisper-model", default="base.en")
    parser.add_argument("--kokoros-voice", default="af_heart")
    parser.add_argument("--gateway", default=None,
                        help="Hermes gateway webhook URL (e.g. http://127.0.0.1:8766)")
    args = parser.parse_args()

    server = VoiceServer(
        host=args.host,
        port=args.port,
        whisper_model=args.whisper_model,
        kokoros_voice=args.kokoros_voice,
        gateway_url=args.gateway,
    )
    server.run()


if __name__ == "__main__":
    main()
