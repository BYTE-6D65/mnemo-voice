"""
Voice activity detection.

Default path: simple energy-based VAD. It is dependency-light and perfectly fine
for push-to-talk prototype work.

Optional path: set MNEMO_USE_SILERO=1 to try Silero VAD. If Silero or its
transitive deps are missing, it falls back to EnergyVAD without killing the WS.
"""

import logging
import os
from typing import Optional

import numpy as np

logger = logging.getLogger("mnemo-voice.vad")


class EnergyVAD:
    """Tiny RMS-energy VAD fallback. Good enough for prototype push-to-talk."""

    def __init__(
        self,
        threshold: float = 0.012,
        silence_duration: float = 0.8,
        sample_rate: int = 16000,
        chunk_ms: int = 256,
    ):
        # Silero-style thresholds are ~0.5 probability. If caller passes that,
        # map it into a reasonable RMS range instead of requiring new config.
        self.threshold = threshold if threshold < 0.1 else 0.012
        self.silence_duration = silence_duration
        self.sample_rate = sample_rate
        self.chunk_ms = chunk_ms
        self._silence_chunks = 0
        self._silence_threshold_chunks = max(1, int(silence_duration * 1000 / chunk_ms))

    @property
    def silence_exceeded(self) -> bool:
        return self._silence_chunks >= self._silence_threshold_chunks

    def reset(self):
        self._silence_chunks = 0

    def process_chunk(self, pcm_bytes: bytes) -> bool:
        if not pcm_bytes:
            self._silence_chunks += 1
            return False

        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        if audio.size == 0:
            self._silence_chunks += 1
            return False

        rms = float(np.sqrt(np.mean(audio * audio)))
        is_speech = rms > self.threshold

        if is_speech:
            self._silence_chunks = 0
        else:
            self._silence_chunks += 1

        return is_speech


class SileroVAD:
    """
    VAD facade.

    Keeps this class name so server/main.py does not care which backend is
    actually active.
    """

    def __init__(
        self,
        threshold: float = 0.5,
        silence_duration: float = 0.8,
        sample_rate: int = 16000,
        chunk_ms: int = 256,
    ):
        self.threshold = threshold
        self.silence_duration = silence_duration
        self.sample_rate = sample_rate
        self.chunk_ms = chunk_ms
        self._silence_chunks = 0
        self._silence_threshold_chunks = max(1, int(silence_duration * 1000 / chunk_ms))
        self._torch = None
        self.model = None
        self.fallback: Optional[EnergyVAD] = None

        if os.environ.get("MNEMO_USE_SILERO") != "1":
            self.fallback = EnergyVAD(
                threshold=threshold,
                silence_duration=silence_duration,
                sample_rate=sample_rate,
                chunk_ms=chunk_ms,
            )
            logger.info("Using EnergyVAD")
            return

        try:
            # Explicit import catches the current Silero torch.hub transitive dep
            # before it aborts websocket setup deep in hubconf.py.
            import torchaudio  # noqa: F401
            import torch

            self._torch = torch
            self.model, _utils = torch.hub.load(
                repo_or_dir="snakers4/silero-vad",
                model="silero_vad",
                trust_repo=True,
            )
            logger.info("Using Silero VAD")
        except Exception as exc:
            logger.warning("Silero VAD unavailable (%s); using EnergyVAD fallback", exc)
            self.fallback = EnergyVAD(
                threshold=threshold,
                silence_duration=silence_duration,
                sample_rate=sample_rate,
                chunk_ms=chunk_ms,
            )

    @property
    def silence_exceeded(self) -> bool:
        if self.fallback is not None:
            return self.fallback.silence_exceeded
        return self._silence_chunks >= self._silence_threshold_chunks

    def reset(self):
        self._silence_chunks = 0
        if self.fallback is not None:
            self.fallback.reset()
        elif self.model is not None and hasattr(self.model, "reset_states"):
            self.model.reset_states()

    def process_chunk(self, pcm_bytes: bytes) -> bool:
        if self.fallback is not None:
            return self.fallback.process_chunk(pcm_bytes)

        audio_int16 = np.frombuffer(pcm_bytes, dtype=np.int16)
        audio_float = audio_int16.astype(np.float32) / 32768.0
        audio_tensor = self._torch.from_numpy(audio_float)

        speech_prob = self.model(audio_tensor, self.sample_rate).item()
        is_speech = speech_prob > self.threshold

        if is_speech:
            self._silence_chunks = 0
        else:
            self._silence_chunks += 1

        return is_speech
