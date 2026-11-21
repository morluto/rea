#!/usr/bin/env python3
"""Small, independent microphone-to-MIDI prototype.

This is a clean-room example and does not use or modify any Vochlea software.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass
from typing import Any

import numpy as np


def estimate_frequency(samples: Any, sample_rate: int, min_hz: float = 65.0, max_hz: float = 1_000.0) -> float | None:
    """Estimate the strongest periodic frequency using normalized autocorrelation."""
    values = np.asarray(samples, dtype=np.float64)
    count = values.size
    if count < 4:
        return None

    centered = values - values.mean()
    if float(np.dot(centered, centered)) <= 1e-8:
        return None

    if count < math.ceil(3 * sample_rate / min_hz):
        return None
    min_lag = max(1, int(sample_rate / max_hz))
    max_lag = min(count - 2, int(sample_rate / min_hz))
    if min_lag >= max_lag:
        return None

    correlation = np.correlate(centered, centered, mode="full")[count - 1:]
    lags = np.arange(min_lag, max_lag + 1)
    overlap_energy = np.sqrt(
        np.array([np.dot(centered[:-lag], centered[:-lag]) for lag in lags])
        * np.array([np.dot(centered[lag:], centered[lag:]) for lag in lags])
    )
    scores = np.divide(
        correlation[lags],
        overlap_energy,
        out=np.zeros_like(overlap_energy),
        where=overlap_energy > 1e-8,
    )

    overlap_samples = count - lags
    valid = overlap_samples >= np.maximum(32, 2 * lags)
    if not np.any(valid):
        return None
    scores = np.where(valid, scores, 0.0)
    interior_peaks = np.flatnonzero((scores[1:-1] >= scores[:-2]) & (scores[1:-1] > scores[2:])) + 1
    edge_peaks = []
    if scores[0] >= scores[1]:
        edge_peaks.append(0)
    if scores[-1] > scores[-2]:
        edge_peaks.append(len(scores) - 1)
    peak_indices = np.array(sorted(edge_peaks + interior_peaks.tolist()), dtype=np.int64)
    if peak_indices.size:
        peak_threshold = float(scores[peak_indices].max()) * 0.985
        prominent_peaks = peak_indices[scores[peak_indices] >= peak_threshold]
        best_peak = int(prominent_peaks[0] if prominent_peaks.size else peak_indices[np.argmax(scores[peak_indices])])
    else:
        best_peak = int(np.argmax(scores))
    best_lag = int(lags[best_peak])
    best_score = float(scores[best_peak])

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


def parse_device(device: str | None) -> str | int | None:
    if device is None:
        return None
    return int(device) if device.isdecimal() else device


def run(device: str | int | None, midi_port: str | None, sample_rate: int, block_size: int, channel: int) -> None:
    try:
        import mido
        import sounddevice as sd
    except ImportError as error:
        raise SystemExit(
            "Install dependencies first: python -m pip install numpy sounddevice mido python-rtmidi"
        ) from error

    output = mido.open_output(midi_port) if midi_port else mido.open_output()
    tracker = MidiNoteTracker()
    analysis_window = math.ceil(3 * sample_rate / 65.0) + block_size
    history: list[float] = []

    def callback(indata: Any, frames: int, time_info: Any, status: Any) -> None:
        del frames, time_info
        if status:
            print(status, flush=True)
        samples = indata[:, channel]
        history.extend(float(sample) for sample in samples)
        if len(history) > analysis_window:
            del history[:-analysis_window]
        event = tracker.update(
            estimate_frequency(history, sample_rate),
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
    parser.add_argument("--device", help="Input device name or numeric index.")
    parser.add_argument("--midi-port", help="MIDI output port name; defaults to the first available port.")
    parser.add_argument("--sample-rate", type=int, default=16_000)
    parser.add_argument("--block-size", type=int, default=2_048)
    parser.add_argument("--channel", type=int, default=0)
    args = parser.parse_args()
    run(parse_device(args.device), args.midi_port, args.sample_rate, args.block_size, args.channel)


if __name__ == "__main__":
    main()
