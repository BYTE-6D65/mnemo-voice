"""
Silero VAD wrapper for voice activity detection.

Uses the Silero VAD model to detect speech boundaries in an audio stream.
Lightweight, runs on CPU, no external deps beyond torch.
"""

import logging
import torch
import numpy as np

logger = logging.getLogger("mnemo-voice.vad")


class SileroVAD:
    """Voice Activity Detection using Silero VAD model."""

    def __init__(
        self,
        threshold: float = 0.5,
        silence_duration: float = 0.8,
        sample_rate: int = 16000,
        chunk_ms: int = 480,
    ):
        self.threshold = threshold
        self.silence_duration = silence_duration
        self.sample_rate = sample_rate
        self.chunk_ms = chunk_ms
        self.chunk_samples = int(sample_rate * chunk_ms / 1000)

        # Load Silero model
        self.model, utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            trust_repo=True,
        )
        self._get_speech_ts = utils[0]

        # State tracking
        self._silence_chunks = 0
        self._silence_threshold_chunks = int(silence_duration * 1000 / chunk_ms)

    @property
    def silence_exceeded(self) -> bool:
        """Check if we've had enough silence to consider speech ended."""
        return self._silence_chunks >= self._silence_threshold_chunks

    def reset(self):
        """Reset VAD state."""
        self._silence_chunks = 0
        self.model.reset_states()

    def process_chunk(self, pcm_bytes: bytes) -> bool:
        """
        Process a PCM audio chunk and return True if speech is detected.

        Args:
            pcm_bytes: 16-bit PCM audio data at 16kHz

        Returns:
            True if speech detected in this chunk
        """
        # Convert bytes to float tensor
        audio_int16 = np.frombuffer(pcm_bytes, dtype=np.int16)
        audio_float = audio_int16.astype(np.float32) / 32768.0
        audio_tensor = torch.from_numpy(audio_float)

        # Get speech probability
        speech_prob = self.model(audio_tensor, self.sample_rate).item()
        is_speech = speech_prob > self.threshold

        if is_speech:
            self._silence_chunks = 0
        else:
            self._silence_chunks += 1

        return is_speech
