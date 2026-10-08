import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { RecordedCrash } from "../../domain/native/recordedCrash.js";

/** Check interpreted scalars against the selected Linux amd64 recording bytes. */
export function validateRecordedCrashScalars(
  report: RecordedCrash,
  snapshot: Buffer,
  diagnostics: RecordedCrash["decoder_diagnostics"],
): void {
  const fail = () => {
    throw new AnalysisOutputError(
      "inspect_recorded_crash",
      "Reported PID or signal value differs from its recorded Linux amd64 source bytes.",
      { capturedOutput: diagnostics },
    );
  };
  const descriptor = (noteIndex: number, minimumBytes: number): Buffer => {
    const note = report.notes[noteIndex];
    if (note === undefined) return fail();
    const start = Number(BigInt(note.descriptor_location.offset));
    const length = Number(BigInt(note.descriptor_location.bytes));
    if (length < minimumBytes) return fail();
    return snapshot.subarray(start, start + length);
  };
  // Fixed offsets independently checked against unchanged pwntools 4.15.0
  // elf_prstatus_amd64 / elf_siginfo_64; this is the sole supported note ABI.
  for (const thread of report.threads) {
    const bytes = descriptor(thread.note_index, 336);
    if (
      thread.historical_pid !== bytes.readInt32LE(32) ||
      thread.recorded_current_signal !== bytes.readInt16LE(12)
    )
      fail();
  }
  for (const signal of report.signals) {
    const bytes = descriptor(signal.note_index, 32);
    if (
      signal.number !== bytes.readInt32LE(0) ||
      signal.errno !== bytes.readInt32LE(4) ||
      signal.code !== bytes.readInt32LE(8) ||
      (signal.fault_address !== null &&
        BigInt(signal.fault_address) !== bytes.readBigUInt64LE(16))
    )
      fail();
  }
}
