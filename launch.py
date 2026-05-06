"""
Standalone voice server launcher (no Hermes gateway).

Runs the WebSocket voice server with a simple echo agent.
For production, use the Hermes gateway with the voice platform adapter
    hermes --gateway
with voice enabled in config.yaml.

Usage:
    python launch.py                     # Echo mode
    python launch.py --port 9000         # Custom port
    python launch.py --whisper-model small.en
"""

import argparse
import asyncio
import json
import logging
import mimetypes
import sys
import uuid
from pathlib import Path

from aiohttp import web, WSMsgType

# Add server to path
sys.path.insert(0, str(Path(__file__).parent / "server"))

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
    def __init__(self, ws, session_id, vad, stt, tts, sample_rate):
        self.ws = ws
        self.session_id = session_id
        self.vad = vad
        self.stt = stt
        self.tts = tts
        self.sample_rate = sample_rate
        self.audio_buffer = bytearray()
        self.is_speaking = False
        self.is_agent_speaking = False
        self.agent_handler = None

    async def send_event(self, event_type, data=None):
        payload = {"type": event_type}
        if data:
            payload["data"] = data
        await self.ws.send_json(payload)

    async def send_audio(self, pcm_bytes):
        await self.ws.send_bytes(pcm_bytes)


class StandaloneVoiceServer:
    """Standalone voice server for development."""

    def __init__(self, host, port, whisper_model, kokoros_voice, vad_threshold,
                 sample_rate, agent_handler=None):
        self.host = host
        self.port = port
        self.sample_rate = sample_rate
        self.agent_handler = agent_handler or (lambda t: f"[echo] {t}")
        self.sessions = {}
        self.static_dir = Path(__file__).resolve().parent / "client" / "dist"

        logger.info("Loading Whisper: %s", whisper_model)
        self.stt = WhisperSTT(model_name=whisper_model)
        logger.info("Loading Kokoros: %s", kokoros_voice)
        self.tts = KokorosTTS(voice=kokoros_voice, sample_rate=sample_rate)
        self.vad_cfg = {
            "threshold": vad_threshold,
            "silence_duration": 0.8,
            "sample_rate": sample_rate,
        }

        self.app = web.Application()
        self.app.router.add_get("/ws", self._handle_ws)
        self.app.router.add_get("/", self._handle_index)
        self.app.router.add_get("/{path:.*}", self._handle_static)

    async def _handle_index(self, request):
        return web.FileResponse(self.static_dir / "index.html")

    async def _handle_static(self, request):
        rel = request.match_info["path"].lstrip("/")
        candidate = (self.static_dir / rel).resolve()
        root = self.static_dir.resolve()
        if candidate.is_file() and root in candidate.parents:
            ct, _ = mimetypes.guess_type(candidate.name)
            return web.FileResponse(candidate, headers={"Content-Type": ct} if ct else None)
        return web.FileResponse(root / "index.html")

    async def _handle_ws(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)

        sid = str(uuid.uuid4())[:8]
        vad = SileroVAD(**self.vad_cfg)
        session = VoiceSession(ws, sid, vad, self.stt, self.tts, self.sample_rate)
        session.agent_handler = self.agent_handler
        self.sessions[sid] = session

        logger.info("Client connected: %s", sid)
        await session.send_event("connected", {"sample_rate": self.sample_rate})

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    await self._on_text(session, msg.data)
                elif msg.type == WSMsgType.BINARY:
                    await self._on_audio(session, msg.data)
                elif msg.type == WSMsgType.ERROR:
                    logger.error("WS error %s: %s", sid, ws.exception())
        finally:
            logger.info("Client disconnected: %s", sid)
            self.sessions.pop(sid, None)
        return ws

    async def _on_text(self, session, data):
        try:
            msg = json.loads(data)
        except json.JSONDecodeError:
            return
        if msg.get("type") == "barge_in":
            session.is_agent_speaking = False
        elif msg.get("type") == "text_input":
            text = msg.get("text", "").strip()
            if text:
                await self._respond(session, text)

    async def _on_audio(self, session, pcm_bytes):
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
            if session.audio_buffer:
                await self._transcribe(session)

    async def _transcribe(self, session):
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
        await self._respond(session, text)

    async def _respond(self, session, text):
        await session.send_event("agent_thinking")
        response = await asyncio.to_thread(session.agent_handler, text)
        if not response:
            return
        await session.send_event("agent_response", {"text": response})

        session.is_agent_speaking = True
        await session.send_event("audio_start")
        try:
            audio = await asyncio.to_thread(session.tts.synthesize, response)
            if audio is None:
                await session.send_event("audio_error", {"error": "TTS failed"})
                return
            chunk_size = int(self.sample_rate * 2 * 0.12)
            off = 0
            while off < len(audio) and session.is_agent_speaking:
                await session.send_audio(audio[off:off + chunk_size])
                off += chunk_size
                await asyncio.sleep(0.02)
        finally:
            session.is_agent_speaking = False
            await session.send_event("audio_end")

    def run(self):
        logger.info("Standalone voice server on %s:%d", self.host, self.port)
        web.run_app(self.app, host=self.host, port=self.port)


def main():
    parser = argparse.ArgumentParser(description="Mnemo Voice Server (standalone)")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--whisper-model", default="base.en")
    parser.add_argument("--kokoros-voice", default="af_heart")
    parser.add_argument("--vad-threshold", type=float, default=0.5)
    parser.add_argument("--sample-rate", type=int, default=16000)
    args = parser.parse_args()

    server = StandaloneVoiceServer(
        host=args.host,
        port=args.port,
        whisper_model=args.whisper_model,
        kokoros_voice=args.kokoros_voice,
        vad_threshold=args.vad_threshold,
        sample_rate=args.sample_rate,
    )
    server.run()


if __name__ == "__main__":
    main()
