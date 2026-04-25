"""
Whisper STT wrapper for speech-to-text transcription.

Uses faster-whisper for efficient local transcription.
"""

import io
import logging
import tempfile
from pathlib import Path

import numpy as np

logger = logging.getLogger("mnemo-voice.stt")


class WhisperSTT:
    """Speech-to-text using faster-whisper."""

    def __init__(self, model_name: str = "base.en", device: str = "cpu", compute_type: str = "float32"):
        from faster_whisper import WhisperModel

        logger.info(f"Loading Whisper model: {model_name} on {device}")
        self.model = WhisperModel(model_name, device=device, compute_type=compute_type)

    def transcribe(self, wav_bytes: bytes) -> str:
        """
        Transcribe WAV audio bytes to text.

        Args:
            wav_bytes: WAV format audio bytes

        Returns:
            Transcribed text string
        """
        # Write to temp file (faster-whisper works best with file paths)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as f:
            f.write(wav_bytes)
            f.flush()
            segments, info = self.model.transcribe(f.name, beam_size=3)

        text = " ".join(segment.text.strip() for segment in segments)
        return text

    def transcribe_pcm(self, pcm_data: bytes, sample_rate: int = 16000) -> str:
        """
        Transcribe raw PCM audio data.

        Args:
            pcm_data: 16-bit PCM audio bytes
            sample_rate: Sample rate of the audio

        Returns:
            Transcribed text string
        """
        from audio import pcm_to_wav_bytes

        wav_bytes = pcm_to_wav_bytes(pcm_data, sample_rate)
        return self.transcribe(wav_bytes)
