"""
WebSocket voice server for Mnemo.

Runs an aiohttp WebSocket server that:
1. Receives PCM audio chunks from browser clients
2. Runs VAD to detect speech boundaries
3. Transcribes complete utterances with Whisper
4. Sends text to the Hermes agent for processing
5. Synthesizes agent responses with Kokoros
6. Streams audio back to the client
"""

import asyncio
import json
import logging
from pathlib import Path
from typing import Optional, Dict, Any, Callable

from aiohttp import web, WSMsgType

from vad import SileroVAD
from stt import WhisperSTT
from tts import KokorosTTS
from audio import pcm_to_wav_bytes

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("mnemo-voice")


class VoiceSession:
    """Per-client voice session state."""

    def __init__(self, ws: web.WebSocketResponse, vad: SileroVAD, stt: WhisperSTT, tts: KokorosTTS):
        self.ws = ws
        self.vad = vad
        self.stt = stt
        self.tts = tts
        self.audio_buffer = bytearray()
        self.is_speaking = False
        self.is_agent_speaking = False
        self.agent_response_queue: asyncio.Queue = asyncio.Queue()

    async def send_event(self, event_type: str, data: dict = None):
        payload = {"type": event_type}
        if data:
            payload["data"] = data
        await self.ws.send_json(payload)

    async def send_audio(self, pcm_bytes: bytes):
        await self.ws.send_bytes(pcm_bytes)


class VoiceServer:
    """WebSocket voice server."""

    def __init__(self, host: str = "0.0.0.0", port: int = 8765,
                 whisper_model: str = "base.en",
                 kokoros_voice: str = "af_heart",
                 vad_threshold: float = 0.5,
                 vad_silence_duration: float = 0.8,
                 sample_rate: int = 16000,
                 agent_handler: Optional[Callable] = None):
        self.host = host
        self.port = port
        self.sample_rate = sample_rate
        self.agent_handler = agent_handler

        logger.info(f"Loading Whisper model: {whisper_model}")
        self.stt = WhisperSTT(model_name=whisper_model)

        logger.info(f"Loading Kokoros TTS with voice: {kokoros_voice}")
        self.tts = KokorosTTS(voice=kokoros_voice, sample_rate=sample_rate)

        logger.info("Loading Silero VAD")
        self.vad_config = {
            "threshold": vad_threshold,
            "silence_duration": vad_silence_duration,
            "sample_rate": sample_rate,
        }

        self.sessions: Dict[int, VoiceSession] = {}
        self.app = web.Application()
        self.app.router.add_get("/ws", self.handle_websocket)
        self.app.router.add_get("/", self.handle_index)
        self.app.router.add_static("/static", Path(__file__).parent.parent / "client")

    async def handle_index(self, request: web.Request):
        return web.FileResponse(Path(__file__).parent.parent / "client" / "index.html")

    async def handle_websocket(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)

        session_id = id(ws)
        vad = SileroVAD(**self.vad_config)
        session = VoiceSession(ws=ws, vad=vad, stt=self.stt, tts=self.tts)
        self.sessions[session_id] = session

        logger.info(f"Client connected: {session_id}")
        await session.send_event("connected", {"sample_rate": self.sample_rate})

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    await self._handle_text_message(session, msg.data)
                elif msg.type == WSMsgType.BYTES:
                    await self._handle_audio_chunk(session, msg.data)
                elif msg.type == WSMsgType.ERROR:
                    logger.error(f"WebSocket error: {ws.exception()}")
        finally:
            logger.info(f"Client disconnected: {session_id}")
            del self.sessions[session_id]

        return ws

    async def _handle_text_message(self, session: VoiceSession, data: str):
        try:
            msg = json.loads(data)
        except json.JSONDecodeError:
            return

        msg_type = msg.get("type")

        if msg_type == "barge_in":
            logger.info("Barge-in received, stopping agent audio")
            session.is_agent_speaking = False
            await session.agent_response_queue.put(None)

        elif msg_type == "text_input":
            text = msg.get("text", "").strip()
            if text:
                await self._process_agent_response(session, text)

    async def _handle_audio_chunk(self, session: VoiceSession, pcm_bytes: bytes):
        is_speech = session.vad.process_chunk(pcm_bytes)

        if is_speech and not session.is_speaking:
            session.is_speaking = True
            session.audio_buffer = bytearray()
            await session.send_event("speech_start")

        if session.is_speaking:
            session.audio_buffer.extend(pcm_bytes)

        if not is_speech and session.is_speaking and session.vad.silence_exceeded:
            session.is_speaking = False
            await session.send_event("speech_end")

            if len(session.audio_buffer) > 0:
                await self._transcribe_and_respond(session)

    async def _transcribe_and_respond(self, session: VoiceSession):
        await session.send_event("transcribing")

        wav_bytes = pcm_to_wav_bytes(bytes(session.audio_buffer), self.sample_rate)
        text = await asyncio.to_thread(self.stt.transcribe, wav_bytes)

        if not text.strip():
            await session.send_event("transcription_empty")
            return

        logger.info(f"Transcribed: {text}")
        await session.send_event("transcription", {"text": text})

        await self._process_agent_response(session, text)

    async def _process_agent_response(self, session: VoiceSession, text: str):
        await session.send_event("agent_thinking")

        if self.agent_handler:
            response_text = await asyncio.to_thread(self.agent_handler, text)
        else:
            response_text = f"I heard you say: {text}"

        if not response_text:
            return

        logger.info(f"Agent response: {response_text[:100]}...")
        await session.send_event("agent_response", {"text": response_text})

        session.is_agent_speaking = True
        await session.send_event("audio_start")

        try:
            audio = await asyncio.to_thread(self.tts.synthesize, response_text)

            if audio is None:
                await session.send_event("audio_error", {"error": "TTS synthesis failed"})
                return

            chunk_size = int(self.sample_rate * 2 * 0.12)  # 120ms chunks
            offset = 0
            while offset < len(audio) and session.is_agent_speaking:
                chunk = audio[offset:offset + chunk_size]
                await session.send_audio(chunk)
                offset += chunk_size
                await asyncio.sleep(0.02)

        finally:
            session.is_agent_speaking = False
            await session.send_event("audio_end")

    def set_agent_handler(self, handler):
        self.agent_handler = handler

    def run(self):
        logger.info(f"Starting voice server on {self.host}:{self.port}")
        web.run_app(self.app, host=self.host, port=self.port)


def main():
    server = VoiceServer()
    server.run()


if __name__ == "__main__":
    main()
