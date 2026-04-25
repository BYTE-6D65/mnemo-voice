"""
Quick launch script for standalone voice server (no Hermes gateway).

Usage:
    python launch.py                     # Echo mode
    python launch.py --agent             # Connect to Hermes agent
    python launch.py --port 9000         # Custom port
"""

import argparse
import logging
import sys
from pathlib import Path

# Add server to path
sys.path.insert(0, str(Path(__file__).parent / "server"))
sys.path.insert(0, str(Path(__file__).parent / "adapter"))

from server.main import VoiceServer
from adapter.voice_adapter import create_standalone_adapter

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("mnemo-voice")


def main():
    parser = argparse.ArgumentParser(description="Mnemo Voice Server")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address")
    parser.add_argument("--port", type=int, default=8765, help="WebSocket port")
    parser.add_argument("--whisper-model", default="base.en", help="Whisper model name")
    parser.add_argument("--kokoros-voice", default="af_heart", help="Kokoros voice name")
    parser.add_argument("--vad-threshold", type=float, default=0.5, help="VAD speech threshold")
    parser.add_argument("--sample-rate", type=int, default=16000, help="Audio sample rate")
    args = parser.parse_args()

    server = VoiceServer(
        host=args.host,
        port=args.port,
        whisper_model=args.whisper_model,
        kokoros_voice=args.kokoros_voice,
        vad_threshold=args.vad_threshold,
        sample_rate=args.sample_rate,
    )

    adapter = create_standalone_adapter(server)
    logger.info("Starting in standalone mode (echo)")

    server.run()


if __name__ == "__main__":
    main()
