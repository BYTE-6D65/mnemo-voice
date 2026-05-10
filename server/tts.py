"""
TTS backend for AI-tubing.

Auto-selects based on platform:
  - macOS: mlx-audio Kokoro (Apple Silicon GPU via MLX)
  - Linux/other: kokoro-onnx (ONNX Runtime, CPU or GPU EP)

Both backends expose the same interface:
  synthesize(text) -> Optional[bytes]   (16-bit PCM at target_sample_rate)
"""

import asyncio
import logging
import platform
import time
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger("ai-tubing.tts")

DEFAULT_VOICE = "af_heart"
DEFAULT_SAMPLE_RATE = 16000  # Target rate for WebSocket output

# Resolve model paths relative to project root
_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_ONNX_MODEL = _PROJECT_ROOT / "models" / "kokoro-onnx" / "kokoro-v1.0.onnx"
_ONNX_VOICES = _PROJECT_ROOT / "models" / "kokoro-onnx" / "voices-v1.0.bin"


def _is_macos() -> bool:
    return platform.system() == "Darwin"


class _MLXTTS:
    """Text-to-speech using mlx-audio Kokoro on Apple Silicon GPU."""

    def __init__(self, voice: str = DEFAULT_VOICE,
                 model_name: str = "mlx-community/Kokoro-82M-bf16",
                 target_sample_rate: int = DEFAULT_SAMPLE_RATE):
        self.voice = voice
        self.model_name = model_name
        self.target_sample_rate = target_sample_rate
        self._model = None
        self._model_sample_rate = 24000  # Kokoro native output

    def _ensure_model(self):
        if self._model is not None:
            return
        logger.info("Loading MLX-Audio Kokoro model: %s", self.model_name)
        t0 = time.time()
        from mlx_audio.tts.utils import load_model
        self._model = load_model(self.model_name)
        logger.info("MLX model loaded in %.1fs", time.time() - t0)

    def synthesize(self, text: str) -> Optional[bytes]:
        text = text[:4000].strip()
        if not text:
            return None
        try:
            self._ensure_model()
            t0 = time.time()
            results = list(self._model.generate(text, voice=self.voice))
            gen_time = time.time() - t0

            audio_parts = [np.array(r.audio, dtype=np.float32) for r in results]
            audio_float = np.concatenate(audio_parts) if audio_parts else np.array([], dtype=np.float32)

            if len(audio_float) == 0:
                logger.error("TTS produced empty audio")
                return None

            duration = len(audio_float) / self._model_sample_rate
            logger.info("MLX TTS: %.1fs audio in %.2fs (%.1fx realtime)",
                       duration, gen_time, duration / gen_time if gen_time > 0 else 0)

            audio_resampled = self._resample(audio_float, self._model_sample_rate, self.target_sample_rate)
            pcm_int16 = (np.clip(audio_resampled, -1.0, 1.0) * 32767).astype(np.int16)
            return pcm_int16.tobytes()
        except Exception as e:
            logger.error("MLX TTS error: %s", e, exc_info=True)
            return None

    def _resample(self, audio: np.ndarray, orig_rate: int, target_rate: int) -> np.ndarray:
        if orig_rate == target_rate:
            return audio
        ratio = target_rate / orig_rate
        new_length = int(len(audio) * ratio)
        indices = np.linspace(0, len(audio) - 1, new_length)
        return np.interp(indices, np.arange(len(audio)), audio)


class _ONNXTTS:
    """Text-to-speech using kokoro-onnx (ONNX Runtime)."""

    def __init__(self, voice: str = DEFAULT_VOICE,
                 model_path: str = str(_ONNX_MODEL),
                 voices_path: str = str(_ONNX_VOICES),
                 target_sample_rate: int = DEFAULT_SAMPLE_RATE):
        self.voice = voice
        self.target_sample_rate = target_sample_rate
        self._model_sample_rate = 24000  # Kokoro native output

        logger.info("Loading ONNX Kokoro model: %s", model_path)
        t0 = time.time()
        from kokoro_onnx import Kokoro
        self._kokoro = Kokoro(model_path=model_path, voices_path=voices_path)
        logger.info("ONNX model loaded in %.1fs. Voices: %s",
                    time.time() - t0, self._kokoro.get_voices())

    def synthesize(self, text: str) -> Optional[bytes]:
        text = text[:4000].strip()
        if not text:
            return None
        try:
            t0 = time.time()
            samples, sample_rate = self._kokoro.create(
                text=text, voice=self.voice, speed=1.0, lang="en-us",
            )
            gen_time = time.time() - t0
            duration = len(samples) / sample_rate
            logger.info("ONNX TTS: %.1fs audio in %.2fs (%.1fx realtime)",
                       duration, gen_time, duration / gen_time if gen_time > 0 else 0)

            # Resample from 24kHz to target rate
            audio_resampled = self._resample(samples, sample_rate, self.target_sample_rate)
            pcm_int16 = (np.clip(audio_resampled, -1.0, 1.0) * 32767).astype(np.int16)
            return pcm_int16.tobytes()
        except Exception as e:
            logger.error("ONNX TTS error: %s", e, exc_info=True)
            return None

    def _resample(self, audio: np.ndarray, orig_rate: int, target_rate: int) -> np.ndarray:
        if orig_rate == target_rate:
            return audio
        ratio = target_rate / orig_rate
        new_length = int(len(audio) * ratio)
        indices = np.linspace(0, len(audio) - 1, new_length)
        return np.interp(indices, np.arange(len(audio)), audio)


def create_tts(voice: str = DEFAULT_VOICE,
               target_sample_rate: int = DEFAULT_SAMPLE_RATE,
               **kwargs) -> "_MLXTTS | _ONNXTTS":
    """Factory: pick the right TTS backend for this machine."""
    if _is_macos():
        logger.info("Platform is macOS — using MLX-Audio TTS")
        return _MLXTTS(voice=voice, target_sample_rate=target_sample_rate, **kwargs)
    else:
        logger.info("Platform is %s — using ONNX TTS", platform.system())
        return _ONNXTTS(voice=voice, target_sample_rate=target_sample_rate, **kwargs)


# Backward-compatible alias — code that does `KokorosTTS(...)` still works.
# On macOS it wraps MLX, on Linux it wraps ONNX.
KokorosTTS = _MLXTTS if _is_macos() else _ONNXTTS
