import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import {
  BinaryFormatFailure,
  BinaryReader,
} from "../../domain/binaryContainer.js";
import {
  RECORDED_LINUX_CORE_PROFILES,
  type RecordedCrash,
} from "../../domain/native/recordedCrash.js";

/** Bind interpreted values and register identities to recorded source bytes. */
export function validateRecordedCrashSources(
  report: RecordedCrash,
  snapshot: Buffer,
  diagnostics: RecordedCrash["decoder_diagnostics"],
): void {
  const read = new BinaryReader(snapshot, true, "pwntools-recorded-crash");
  const profile = RECORDED_LINUX_CORE_PROFILES[report.architecture];
  const registerOffsets = new Map<string, number>(
    profile.registers.map((name, index) => [
      name,
      profile.registerOffset + index * profile.registerBytes,
    ]),
  );
  const fail = (
    reason = `Reported PID or signal value differs from its recorded ${report.architecture} source bytes.`,
  ): never => {
    throw new AnalysisOutputError("inspect_recorded_crash", reason, {
      capturedOutput: diagnostics,
    });
  };
  const descriptorOffset = (
    noteIndex: number,
    minimumBytes: number,
  ): number => {
    const note = report.notes[noteIndex];
    if (note === undefined) return fail();
    const { offset, bytes } = note.descriptor_location;
    const length = BigInt(bytes);
    if (length < BigInt(minimumBytes)) return fail();
    try {
      return read.fileRange(BigInt(offset), length, "core note descriptor")
        .offset;
    } catch (cause) {
      if (cause instanceof BinaryFormatFailure) return fail();
      throw cause;
    }
  };
  // Offsets come from unchanged pwntools 4.15.0 elf_prstatus_amd64 /
  // elf_prstatus_aarch64 and elf_siginfo_64 through the shared domain profile.
  for (const thread of report.threads) {
    const start = descriptorOffset(thread.note_index, profile.prstatusBytes);
    if (
      thread.historical_pid !== read.i32(start + 32) ||
      thread.recorded_current_signal !== read.i16(start + 12)
    )
      fail();
    for (const register of thread.registers) {
      const offset = registerOffsets.get(register.name);
      if (
        offset === undefined ||
        BigInt(register.location.offset) !== BigInt(start + offset)
      )
        fail(
          `Reported register source does not match its ${report.architecture} register identity.`,
        );
    }
  }
  for (const signal of report.signals) {
    const start = descriptorOffset(signal.note_index, 32);
    if (
      signal.number !== read.i32(start) ||
      signal.errno !== read.i32(start + 4) ||
      signal.code !== read.i32(start + 8) ||
      (signal.fault_address !== null &&
        BigInt(signal.fault_address) !== read.word(start + 16, 64))
    )
      fail();
  }
  for (const thread of report.threads)
    for (const register of thread.registers) {
      // The source identity and descriptor extent were admitted above.
      const start = Number(BigInt(register.location.offset));
      if (read.word(start, 64) !== BigInt(register.value))
        fail("Reported register value differs from its recorded source bytes.");
    }
}
