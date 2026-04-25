"""
Hermes Gateway Voice Adapter

Implements the BasePlatformAdapter interface so the voice WebSocket
server acts as a first-class Hermes channel alongside Telegram/Discord/etc.

Usage:
    This adapter runs alongside the WebSocket voice server.
    The voice server handles audio I/O; this adapter handles
    the Hermes MessageEvent/SendResult interface.

    To integrate, add to Hermes gateway config:
        platforms:
          voice:
            enabled: true
            port: 8765

    The adapter can also run standalone for development.
"""

import asyncio
import json
import logging
from typing import Any, Callable, Dict, Optional

# Hermes adapter interface (these would come from hermes-agent gateway)
# For standalone mode, we provide stubs
try:
    from gateway.platforms.base import (
        BasePlatformAdapter,
        MessageEvent,
        MessageType,
        SendResult,
    )
    from gateway.config import Platform, PlatformConfig
    HAS_HERMES = True
except ImportError:
    HAS_HERMES = False
    logging.warning("Hermes gateway not found — running in standalone mode")

    class MessageType:
        TEXT = "text"
        VOICE = "voice"

    class MessageEvent:
        def __init__(self, text="", message_type=None, **kwargs):
            self.text = text
            self.message_type = message_type or MessageType.TEXT
            self.message_id = kwargs.get("message_id")
            self.media_urls = kwargs.get("media_urls", [])
            self.media_types = kwargs.get("media_types", [])
            self.raw_message = kwargs.get("raw_message")
            self.timestamp = kwargs.get("timestamp")

    class SendResult:
        def __init__(self, success=True, message_id=None, error=None):
            self.success = success
            self.message_id = message_id
            self.error = error

    class Platform:
        VOICE = "voice"

    class PlatformConfig:
        pass

logger = logging.getLogger("mnemo-voice.adapter")


class VoiceAdapter(BasePlatformAdapter if HAS_HERMES else object):
    """
    Voice channel adapter for Hermes.

    Bridges the WebSocket voice server and the Hermes gateway:
    - Incoming voice transcriptions → MessageEvent → Hermes agent
    - Agent responses → Kokoros TTS → audio back to WebSocket client
    """

    def __init__(self, config: PlatformConfig = None, voice_server=None):
        if HAS_HERMES:
            super().__init__(config=config or PlatformConfig(), platform=Platform.VOICE)
        else:
            self._message_handler = None
            self._running = False

        self.voice_server = voice_server
        self._pending_responses: Dict[str, asyncio.Future] = {}

    # ── BasePlatformAdapter interface ────────────────────────

    async def connect(self) -> bool:
        """Start the voice server."""
        logger.info("Voice adapter connecting...")
        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        """Stop the voice server."""
        logger.info("Voice adapter disconnecting")
        self._mark_disconnected()

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """
        Send a text message from the agent to the voice client.

        This is called by the Hermes gateway when the agent produces a response.
        We synthesize it with Kokoros and send audio to the WebSocket client.
        """
        if not self.voice_server:
            return SendResult(success=False, error="Voice server not attached")

        # Find the session for this chat_id
        session = self.voice_server.sessions.get(int(chat_id))
        if not session:
            return SendResult(success=False, error=f"No session for chat_id {chat_id}")

        # Synthesize and send
        try:
            await self.voice_server._process_agent_response(session, content)
            return SendResult(success=True, message_id=f"voice_{chat_id}")
        except Exception as e:
            logger.error(f"Voice send error: {e}")
            return SendResult(success=False, error=str(e))

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        """Send a 'thinking' indicator to the voice client."""
        session = self.voice_server.sessions.get(int(chat_id))
        if session:
            await session.send_event("agent_thinking")

    # ── Voice → Hermes bridge ────────────────────────────────

    async def on_voice_transcription(self, session_id: str, text: str):
        """
        Called when the voice server has a transcription ready.

        Creates a MessageEvent and passes it to the Hermes message handler.
        """
        if not self._message_handler:
            logger.warning("No message handler — running standalone")
            return

        event = MessageEvent(
            text=text,
            message_type=MessaceType.TEXT,
            message_id=f"voice_{session_id}",
            raw_message={"source": "voice", "session_id": session_id},
        )

        # Dispatch to Hermes
        await self._message_handler(event)

    def set_voice_server(self, server):
        """Attach the voice server instance."""
        self.voice_server = server


def create_standalone_adapter(voice_server) -> VoiceAdapter:
    """
    Create a VoiceAdapter that works without the full Hermes gateway.

    Used for development and testing. Accepts a simple callback
    instead of the full gateway message handler.
    """
    adapter = VoiceAdapter(voice_server=voice_server)

    # Override the voice server's agent handler to use the adapter
    original_handler = voice_server.agent_handler

    def standalone_handler(text: str) -> str:
        """Simple echo handler for standalone mode."""
        if original_handler:
            return original_handler(text)
        return f"[standalone] I heard: {text}"

    voice_server.set_agent_handler(standalone_handler)
    return adapter
