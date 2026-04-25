"""
Kokoros TTS wrapper for text-to-speech synthesis.

Uses the Rust Kokoros (koko) binary for audio generation.
Shells out to the compiled binary — no Python kokoro dependency needed.
"""

import asyncio
import logging
import os
import tempfile
import wave
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger("mnemo-voice.tts")

KOKOROS_DIR = Path(os.environ.get("KOKOROS_DIR", "/Users/byte/Developer/Kokoros"))
KOKO_BIN = KOKOROS_DIR / "target" / "release" / "koko"
DEFAULT_VOICE = "af_heart"
DEFAULT_SPEED = "1.0"


class KokorosTTS:
    """Text-to-speech using the Rust Kokoros binary."""

    def __init__(self, voice: str = DEFAULT_VOICE, sample_rate: int = 24000,
                 speed: str = DEFAULT_SPEED):
        self.voice = voice
        self.sample_rate = sample_rate
        self.speed = speed

        if not KOKO_BIN.exists():
            raise FileNotFoundError(
                f"Koko binary not found at {KOKO_BIN}. "
                f"Build with: cd {KOKOROS_DIR} && cargo build --release"
            )

    def synthesize(self, text: str) -> Optional[bytes]:
        """
        Synthesize text to PCM audio bytes (16-bit LE, mono).

        Args:
            text: Text to synthesize

        Returns:
            16-bit PCM audio bytes, or None on failure
        """
        text = text[:4000]

        try:
            import subprocess

            with tempfile.TemporaryDirectory() as tmpdir:
                outfile = Path(tmpdir) / "output.wav"

                result = subprocess.run(
                    [
                        str(KOKO_BIN),
                        "--style", self.voice,
                        "--speed", self.speed,
                        "text", text,
                        "--output", str(outfile),
                    ],
                    cwd=str(KOKOROS_DIR),
                    capture_output=True,
                    text=True,
                    timeout=30,
                )

                if result.returncode != 0:
                    logger.error(f"Koko error: {result.stderr}")
                    return None

                if not outfile.exists():
                    logger.error("Koko produced no output file")
                    return None

                # Koko outputs WAVE_FORMAT_EXTENSIBLE which Python 3.9 wave module
                # can't read. Use ffmpeg to convert to a standard mono 16-bit WAV.
                import subprocess as sp
                converted = Path(tmpdir) / "converted.wav"
                sp.run(
                    ["ffmpeg", "-y", "-i", str(outfile),
                     "-ac", "1", "-ar", str(self.sample_rate),
                     "-sample_fmt", "s16", str(converted)],
                    capture_output=True, timeout=10,
                )

                if not converted.exists():
                    logger.error("ffmpeg conversion failed")
                    return None

                with wave.open(str(converted), "rb") as wf:
                    pcm_data = wf.readframes(wf.getnframes())

                return pcm_data

        except subprocess.TimeoutExpired:
            logger.error("Koko timed out")
            return None
        except Exception as e:
            logger.error(f"TTS synthesis error: {e}")
            return None

    def _resample(self, pcm_data: bytes, orig_rate: int, target_rate: int) -> bytes:
        if orig_rate == target_rate:
            return pcm_data
        audio = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32)
        ratio = target_rate / orig_rate
        new_length = int(len(audio) * ratio)
        indices = np.linspace(0, len(audio) - 1, new_length)
        resampled = np.interp(indices, np.arange(len(audio)), audio)
        return resampled.astype(np.int16).tobytes()

    async def synthesize_async(self, text: str) -> Optional[bytes]:
        return await asyncio.to_thread(self.synthesize, text)
