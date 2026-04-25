"""
Kokoros TTS wrapper for text-to-speech synthesis.

Wraps the Kokoros TTS engine for generating audio from text.
"""

import io
import logging
import struct
import wave

import numpy as np

logger = logging.getLogger("mnemo-voice.tts")


class KokorosTTS:
    """Text-to-speech using Kokoros."""

    def __init__(self, voice: str = "af_heart", sample_rate: int = 24000, device: str = "cpu"):
        self.voice = voice
        self.sample_rate = sample_rate
        self.device = device
        self._pipeline = None

    def _ensure_pipeline(self):
        """Lazy-load the Kokoros pipeline."""
        if self._pipeline is not None:
            return

        try:
            from kokoro import KPipeline
            logger.info(f"Loading Kokoro pipeline with voice: {self.voice}")
            self._pipeline = KPipeline(lang_code="a")
        except ImportError:
            logger.error("Kokoros not installed. Install from ~/Developer/Kokoros/")
            raise

    def synthesize(self, text: str) -> bytes | None:
        """
        Synthesize text to PCM audio bytes.

        Args:
            text: Text to synthesize

        Returns:
            16-bit PCM audio bytes at self.sample_rate, or None on failure
        """
        self._ensure_pipeline()

        # Truncate to Kokoros max (4000 chars)
        text = text[:4000]

        try:
            audio_chunks = []
            for result in self._pipeline(text, voice=self.voice):
                if result.audio is not None:
                    audio_numpy = result.audio.numpy()
                    # Convert float32 [-1, 1] to int16 PCM
                    audio_int16 = (audio_numpy * 32767).astype(np.int16)
                    audio_chunks.append(audio_int16.tobytes())

            if not audio_chunks:
                return None

            return b"".join(audio_chunks)

        except Exception as e:
            logger.error(f"TTS synthesis error: {e}")
            return None

    def synthesize_wav(self, text: str) -> bytes | None:
        """
        Synthesize text to WAV bytes.

        Args:
            text: Text to synthesize

        Returns:
            WAV format bytes, or None on failure
        """
        pcm = self.synthesize(text)
        if pcm is None:
            return None

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(self.sample_rate)
            wf.writeframes(pcm)

        return buf.getvalue()
