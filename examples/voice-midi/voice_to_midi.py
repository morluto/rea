#!/usr/bin/env python3
"""Small, independent microphone-to-MIDI prototype.

This is a clean-room example and does not use or modify any Vochlea software.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass
from typing import Any


def estimate_frequency(samples: Any, sample_rate: int, min_hz: float = 65.0, max_hz: float = 1_000.0) -> float | None:
    """Estimate the strongest periodic frequency using normalized autocorrelation."""
    count = len(samples)
    if count < 4:
        return None

    mean = float(sum(samples)) / count
    centered = [float(sample) - mean for sample in samples]
    energy = sum(sample * sample for sample in centered)
    if energy <= 1e-8:
        return None

    min_lag = max(1, int(sample_rate / max_hz))
    max_lag = min(count - 2, int(sample_rate / min_hz))
    if min_lag >= max_lag:
        return None

    best_lag = 0
    best_score = 0.0
    for lag in range(min_lag, max_lag + 1):
        score = sum(centered[index] * centered[index + lag] for index in range(count - lag))
        score /= energy
        if score > best_score:
            best_score = score
            best_lag = lag

    if best_lag == 0 or best_score < 0.35:
        return None
    return sample_rate / best_lag


def frequency_to_midi(frequency: float) -> int:
    """Convert frequency in Hz to the nearest MIDI note number."""
    return max(0, min(127, round(69 + 12 * math.log2(frequency / 440.0))))


@dataclass
class MidiNoteTracker:
    """Apply a small amount of hysteresis so noisy frames do not chatter."""

    silence_rms: float = 0.01
    hold_frames: int = 2
    current_note: int | None = None
    candidate_note: int | None = None
    candidate_frames: int = 0

    def update(self, frequency: float | None, rms: float) -> list[tuple[str, int]]:
        next_note = None
        if frequency is not None and rms >= self.silence_rms:
            next_note = frequency_to_midi(frequency)

        if next_note == self.current_note:
            self.candidate_note = None
            self.candidate_frames = 0
            return []

        if next_note != self.candidate_note:
            self.candidate_note = next_note
            self.candidate_frames = 1
            return []

        self.candidate_frames += 1
        if self.candidate_frames < self.hold_frames:
            return []

        old_note = self.current_note
        self.current_note = next_note
        self.candidate_note = None
        self.candidate_frames = 0
        events = []
        if old_note is not None:
            events.append(("off", old_note))
        if next_note is not None:
            events.append(("on", next_note))
        return events


def rms(samples: Any) -> float:
    return math.sqrt(sum(float(sample) * float(sample) for sample in samples) / max(1, len(samples)))


def run(device: str | None, midi_port: str | None, sample_rate: int, block_size: int, channel: int) -> None:
    try:
        import mido
        import sounddevice as sd
    except ImportError as error:
        raise SystemExit(
            "Install dependencies first: python -m pip install numpy sounddevice mido python-rtmidi"
        ) from error

    output = mido.open_output(midi_port) if midi_port else mido.open_output()
    tracker = MidiNoteTracker()

    def callback(indata: Any, frames: int, time_info: Any, status: Any) -> None:
        del frames, time_info
        if status:
            print(status, flush=True)
        samples = indata[:, channel]
        event = tracker.update(
            estimate_frequency(samples, sample_rate),
            rms(samples),
        )
        for kind, note in event:
            output.send(mido.Message("note_" + kind, note=note, velocity=96 if kind == "on" else 0))
            print(f"{kind:>3} note={note:3d}", flush=True)

    print("Listening. Press Ctrl+C to stop.")
    try:
        with sd.InputStream(
            samplerate=sample_rate,
            blocksize=block_size,
            channels=channel + 1,
            device=device,
            dtype="float32",
            callback=callback,
        ):
            while True:
                sd.sleep(1_000)
    except KeyboardInterrupt:
        pass
    finally:
        if tracker.current_note is not None:
            output.send(mido.Message("note_off", note=tracker.current_note, velocity=0))
        output.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert monophonic microphone pitch to MIDI notes.")
    parser.add_argument("--device", help="Input device name or index.")
    parser.add_argument("--midi-port", help="MIDI output port name; defaults to the first available port.")
    parser.add_argument("--sample-rate", type=int, default=16_000)
    parser.add_argument("--block-size", type=int, default=2_048)
    parser.add_argument("--channel", type=int, default=0)
    args = parser.parse_args()
    run(args.device, args.midi_port, args.sample_rate, args.block_size, args.channel)


if __name__ == "__main__":
    main()
