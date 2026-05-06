"""
Voice platform adapter for Hermes gateway.

Thin channel adapter — connects to an external AI-tubing voice server
over HTTP, just like Telegram connects to Telegram's API.

AI-tubing handles: WebSocket, VAD, STT, TTS, static files, browser audio.
This adapter handles: receiving transcribed text → running the agent → returning response.

Lifecycle:
  1. AI-tubing starts independently on its own port (8765 by default)
  2. Gateway starts, this adapter opens a webhook listener port
  3. AI-tubing POSTs transcribed text to /voice/message
  4. Adapter runs handle_message() and returns the agent response
  5. AI-tubing handles TTS and streams audio back to the browser

Neither process depends on the other to start. If AI-tubing is down,
the gateway still runs (voice channel reports disconnected). If the
gateway is down, AI-tubing runs in echo mode.
"""

import asyncio
import json
import logging
import re
from typing import Optional, Dict

from aiohttp import web

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.session import SessionSource

logger = logging.getLogger(__name__)


def check_voice_requirements() -> bool:
    """Check if voice adapter dependencies are available."""
    try:
        import aiohttp  # noqa: F401
        return True
    except ImportError:
        return False


class VoiceAdapter(BasePlatformAdapter):
    """
    Thin HTTP channel adapter for AI-tubing voice server.

    Exposes a webhook endpoint that AI-tubing calls with transcribed text.
    Runs the agent and returns the response. No ML, no WebSocket, no static
    files — all of that lives in AI-tubing.
    """

    MAX_MESSAGE_LENGTH = 4096

    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform.VOICE)

        extra = config.extra or {}
        self._host = extra.get("webhook_host", "127.0.0.1")
        self._port = int(extra.get("webhook_port", 8766))
        # URL of the AI-tubing server (for health checks)
        self._voice_server_url = extra.get("voice_server_url", "http://127.0.0.1:8765")

        self._app: Optional[web.Application] = None
        self._runner: Optional[web.AppRunner] = None
        self._site: Optional[web.TCPSite] = None
        # Pending agent responses keyed by chat_id.
        # send() writes the response string, webhook handler polls for it.
        # _processing_done tracks when the gateway's background task finishes.
        self._pending_responses: Dict[str, Optional[str]] = {}
        self._processing_done: Dict[str, bool] = {}

    # ------------------------------------------------------------------
    # BasePlatformAdapter interface
    # ------------------------------------------------------------------

    async def on_processing_complete(self, event, outcome):
        """Signal that the gateway's background agent task finished."""
        chat_id = event.source.chat_id
        self._processing_done[chat_id] = True

    async def connect(self) -> bool:
        """Start the webhook listener for AI-tubing to call into."""
        self._app = web.Application()
        self._app.router.add_post("/voice/message", self._handle_message)
        self._app.router.add_get("/health", self._handle_health)

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self._host, self._port)
        await self._site.start()

        self._mark_connected()
        logger.info(
            "[%s] Voice webhook listening on %s:%d (proxy for %s)",
            self.name, self._host, self._port, self._voice_server_url,
        )

        # Check if AI-tubing is reachable
        try:
            import aiohttp
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{self._voice_server_url}/health",
                    timeout=aiohttp.ClientTimeout(total=3),
                ) as resp:
                    if resp.status == 200:
                        logger.info("[%s] AI-tubing voice server is reachable", self.name)
                    else:
                        logger.warning("[%s] AI-tubing returned %d", self.name, resp.status)
        except Exception as e:
            logger.warning(
                "[%s] AI-tubing not reachable at %s: %s — voice channel will work when it starts",
                self.name, self._voice_server_url, e,
            )

        return True

    async def disconnect(self):
        """Stop the webhook listener."""
        if self._runner:
            await self._runner.cleanup()
            self._runner = None
        self._mark_disconnected()

    async def play_tts(self, chat_id, audio_path, **kwargs):
        """No-op — AI-tubing handles all TTS."""
        return SendResult(success=True)

    async def send(self, chat_id, content, reply_to=None, metadata=None) -> SendResult:
        """Capture agent response via Future for the webhook handler.

        handle_message() runs the agent in a background task. The gateway
        may call send() multiple times (system messages, then the agent response).
        We store each response in _pending_responses so the webhook can
        return the latest one.
        """
        # Store the response content for this chat_id — last write wins
        self._pending_responses[chat_id] = content or ""
        return SendResult(success=True)

    async def send_typing(self, chat_id, metadata=None):
        """No-op — AI-tubing manages its own UI state."""
        pass

    async def get_chat_info(self, chat_id) -> dict:
        return {
            "name": f"Voice Session {chat_id}",
            "type": "dm",
            "chat_id": chat_id,
        }

    # ------------------------------------------------------------------
    # Webhook handler
    # ------------------------------------------------------------------

    async def _handle_message(self, request: web.Request) -> web.Response:
        """AI-tubing calls this with transcribed text.

        Request body: {"chat_id": "voice-abc123", "text": "hello"}
        Response: {"response": "Hi there!"}

        The gateway runs handle_message() which spawns a background task.
        We create a Future, let send() resolve it, and await it here so
        the HTTP response contains the actual agent reply.
        """
        try:
            data = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"error": "invalid json"}, status=400)

        chat_id = data.get("chat_id", "")
        text = data.get("text", "").strip()

        if not text or not chat_id:
            return web.json_response({"error": "missing chat_id or text"}, status=400)

        logger.info("[%s] Received transcription for %s: %s", self.name, chat_id, text[:100])

        # Mark this chat_id as awaiting a response.
        self._pending_responses[chat_id] = None
        self._processing_done[chat_id] = False

        try:
            # Dispatch through the gateway's message pipeline
            source = self.build_source(
                chat_id=chat_id,
                chat_name="Voice",
                chat_type="dm",
                user_id=chat_id,
                user_name="Voice User",
            )
            event = MessageEvent(
                text=text,
                message_type=MessageType.VOICE,
                source=source,
            )
            await self.handle_message(event)

            # Poll until on_processing_complete fires, then grab the
            # last response written by send(). System messages (like
            # "no home channel") get overwritten by the agent response.
            response_text = ""
            deadline = asyncio.get_event_loop().time() + 120.0
            while True:
                if self._processing_done.get(chat_id):
                    response_text = self._pending_responses.get(chat_id, "") or ""
                    break
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    logger.warning("[%s] Agent timeout for %s", self.name, chat_id)
                    response_text = self._pending_responses.get(chat_id, "") or ""
                    break
                await asyncio.sleep(0.3)
        finally:
            self._pending_responses.pop(chat_id, None)
            self._processing_done.pop(chat_id, None)

        return web.json_response({"response": response_text})

    async def _handle_health(self, request: web.Request) -> web.Response:
        return web.json_response({"status": "ok", "platform": "voice"})
