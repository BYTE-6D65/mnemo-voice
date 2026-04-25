"""
Audio utility functions for format conversion.
"""

import io
import struct
import wave

import numpy as np


def pcm_to_wav_bytes(pcm_data: bytes, sample_rate: int = 16000, channels: int = 1, sample_width: int = 2) -> bytes:
    """
    Convert raw PCM bytes to WAV format.

    Args:
        pcm_data: Raw 16-bit PCM audio bytes
        sample_rate: Sample rate in Hz
        channels: Number of audio channels
        sample_width: Sample width in bytes (2 = 16-bit)

    Returns:
        WAV format bytes
    """
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    return buf.getvalue()


def resample_pcm(pcm_data: bytes, orig_rate: int, target_rate: int) -> bytes:
    """
    Resample 16-bit PCM audio from one sample rate to another.

    Args:
        pcm_data: 16-bit PCM audio bytes
        orig_rate: Original sample rate
        target_rate: Target sample rate

    Returns:
        Resampled 16-bit PCM bytes
    """
    if orig_rate == target_rate:
        return pcm_data

    audio = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32)
    ratio = target_rate / orig_rate
    new_length = int(len(audio) * ratio)

    # Linear interpolation resampling (good enough for voice)
    indices = np.linspace(0, len(audio) - 1, new_length)
    resampled = np.interp(indices, np.arange(len(audio)), audio)

    return resampled.astype(np.int16).tobytes()


def opus_to_pcm(opus_data: bytes, sample_rate: int = 16000) -> bytes:
    """
    Decode Opus audio to PCM. Requires opuslib.

    For v0.1 we use raw PCM over WebSocket so this is a placeholder
    for future Opus support.
    """
    raise NotImplementedError("Opus decoding not yet implemented")
