"""
MLX-Audio TTS wrapper for text-to-speech synthesis.

Uses mlx-audio's Kokoro model running on Apple Silicon GPU via MLX.
Same Kokoro model + voice as before, but GPU-accelerated — no subprocess,
no ffmpeg, no WAV file dance.

Drop-in replacement for the old KokorosTTS that shelled out to the Rust binary.
"""

import asyncio
import logging
import time
from pathlib import Path
from typing import Optional

import mlx.core as mx
import numpy as np

logger = logging.getLogger("mnemo-voice.tts")

DEFAULT_VOICE = "af_heart"
DEFAULT_MODEL = "mlx-community/Kokoro-82M-bf16"


class MLXAudioTTS:
    """Text-to-speech using mlx-audio Kokoro on Apple Silicon GPU."""

    def __init__(self, voice: str = DEFAULT_VOICE,
                 model_name: str = DEFAULT_MODEL,
                 target_sample_rate: int = 16000):
        self.voice = voice
        self.model_name = model_name
        self.target_sample_rate = target_sample_rate
        self._model = None
        self._model_sample_rate = 24000  # Kokoro native output

    def _ensure_model(self):
        """Lazy-load model on first synthesis call."""
        if self._model is not None:
            return

        logger.info("Loading MLX-Audio Kokoro model: %s", self.model_name)
        t0 = time.time()
        from mlx_audio.tts.utils import load_model
        self._model = load_model(self.model_name)
        elapsed = time.time() - t0
        logger.info("Model loaded in %.1fs", elapsed)

    def synthesize(self, text: str) -> Optional[bytes]:
        """
        Synthesize text to PCM audio bytes (16-bit signed LE, mono, target_sample_rate).

        Args:
            text: Text to synthesize (truncated to 4000 chars)

        Returns:
            16-bit PCM audio bytes at target_sample_rate, or None on failure
        """
        text = text[:4000].strip()
        if not text:
            return None

        try:
            self._ensure_model()

            t0 = time.time()
            results = list(self._model.generate(text, voice=self.voice))
            gen_time = time.time() - t0

            if not results:
                logger.error("TTS generated no results")
                return None

            # Concatenate all chunks (model may yield multiple segments)
            audio_parts = []
            for r in results:
                audio_parts.append(np.array(r.audio, dtype=np.float32))
            audio_float = np.concatenate(audio_parts) if audio_parts else np.array([], dtype=np.float32)

            if len(audio_float) == 0:
                logger.error("TTS produced empty audio")
                return None

            duration = len(audio_float) / self._model_sample_rate
            logger.info("TTS: %.1fs audio in %.2fs (%.1fx realtime)",
                       duration, gen_time, duration / gen_time if gen_time > 0 else 0)

            # Resample from model's native rate to target rate
            audio_resampled = self._resample(audio_float, self._model_sample_rate, self.target_sample_rate)

            # Convert float32 [-1, 1] → int16 PCM
            pcm_int16 = (np.clip(audio_resampled, -1.0, 1.0) * 32767).astype(np.int16)
            return pcm_int16.tobytes()

        except Exception as e:
            logger.error("TTS synthesis error: %s", e, exc_info=True)
            return None

    def _resample(self, audio: np.ndarray, orig_rate: int, target_rate: int) -> np.ndarray:
        """Linear interpolation resampling."""
        if orig_rate == target_rate:
            return audio
        ratio = target_rate / orig_rate
        new_length = int(len(audio) * ratio)
        indices = np.linspace(0, len(audio) - 1, new_length)
        return np.interp(indices, np.arange(len(audio)), audio)

    async def synthesize_async(self, text: str) -> Optional[bytes]:
        """Async wrapper — runs synthesize in a thread to avoid blocking the event loop."""
        return await asyncio.to_thread(self.synthesize, text)


# Backward-compatible alias so the adapter doesn't need changing
KokorosTTS = MLXAudioTTS
