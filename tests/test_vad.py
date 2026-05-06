import sys
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from vad import EnergyVAD


class EnergyVADTimingTests(unittest.TestCase):
    def test_silence_duration_counts_samples_not_worklet_chunks(self):
        vad = EnergyVAD(threshold=0.012, silence_duration=0.8, sample_rate=16000)
        silent_128_frame_chunk = b"\x00\x00" * 128

        for _ in range(3):
            self.assertFalse(vad.process_chunk(silent_128_frame_chunk))

        self.assertFalse(vad.silence_exceeded)

        for _ in range(97):
            vad.process_chunk(silent_128_frame_chunk)

        self.assertTrue(vad.silence_exceeded)


if __name__ == "__main__":
    unittest.main()
