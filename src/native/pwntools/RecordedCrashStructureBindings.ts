import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { RecordedCrash } from "../../domain/native/recordedCrash.js";

// Exact amd64/core enum projections in the pinned pyelftools 0.33 profile.
const segmentKinds = new Map([
  [0, "PT_NULL"],
  [1, "PT_LOAD"],
  [2, "PT_DYNAMIC"],
  [3, "PT_INTERP"],
  [4, "PT_NOTE"],
  [5, "PT_SHLIB"],
  [6, "PT_PHDR"],
  [7, "PT_TLS"],
  [0x60000000, "PT_LOOS"],
  [0x6fffffff, "PT_HIOS"],
  [0x6474e550, "PT_GNU_EH_FRAME"],
  [0x6474e551, "PT_GNU_STACK"],
  [0x6474e552, "PT_GNU_RELRO"],
  [0x6474e553, "PT_GNU_PROPERTY"],
]);
const noteKinds = new Map([
  [1, "NT_PRSTATUS"],
  [2, "NT_FPREGSET"],
  [3, "NT_PRPSINFO"],
  [4, "NT_TASKSTRUCT"],
  [6, "NT_AUXV"],
  [0x53494749, "NT_SIGINFO"],
  [0x46494c45, "NT_FILE"],
]);
const matchesKind = (
  raw: number,
  reported: string | number,
  kinds: ReadonlyMap<number, string>,
): boolean => {
  const known = kinds.get(raw);
  return typeof reported === "string"
    ? reported === known
    : known === undefined && reported === raw;
};

const segmentMatches = (
  segment: RecordedCrash["segments"][number],
  raw: Buffer,
): boolean => {
  const type = raw.readUInt32LE(0);
  return (
    matchesKind(type, segment.type, segmentKinds) &&
    BigInt(segment.flags) === BigInt(raw.readUInt32LE(4)) &&
    segment.file_backing ===
      (type === 0 || raw.readBigUInt64LE(32) === 0n ? "none" : "file") &&
    (
      [
        [segment.offset, 8],
        [segment.virtual_address, 16],
        [segment.physical_address, 24],
        [segment.file_size, 32],
        [segment.memory_size, 40],
        [segment.alignment, 48],
      ] as const
    ).every(
      ([field, relative]) => BigInt(field) === raw.readBigUInt64LE(relative),
    )
  );
};

/** Bind coverage-bearing ELF and note headers to the same snapshot as their payloads. */
export function validateRecordedCrashStructure(
  report: RecordedCrash,
  snapshot: Buffer,
  diagnostics: RecordedCrash["decoder_diagnostics"],
): void {
  const fail = () => {
    throw new AnalysisOutputError(
      "inspect_recorded_crash",
      "Reported core structure differs from its original ELF/note headers.",
      { capturedOutput: diagnostics },
    );
  };
  const bytesAt = (offset: bigint, bytes: number): Buffer => {
    if (offset < 0n || offset > BigInt(snapshot.length - bytes)) return fail();
    return snapshot.subarray(Number(offset), Number(offset) + bytes);
  };
  const header = bytesAt(0n, 64);
  if (
    !header
      .subarray(0, 6)
      .equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) ||
    ![0, 3].includes(header[7] ?? -1) ||
    header[8] !== 0 ||
    header.readUInt16LE(16) !== 4 ||
    header.readUInt16LE(18) !== 62
  )
    fail();
  const table = header.readBigUInt64LE(32);
  const entryBytes = header.readUInt16LE(54);
  let count = header.readUInt16LE(56);
  if (count === 0xffff) {
    if (header.readUInt16LE(58) < 64) return fail();
    count = bytesAt(header.readBigUInt64LE(40), 64).readUInt32LE(44);
  }
  if (count !== report.segments.length || (count > 0 && entryBytes < 56))
    fail();
  for (const segment of report.segments) {
    const offset = table + BigInt(segment.index) * BigInt(entryBytes);
    if (
      BigInt(segment.header_location.offset) !== offset ||
      BigInt(segment.header_location.bytes) !== BigInt(entryBytes)
    )
      fail();
    const raw = bytesAt(offset, entryBytes);
    if (!segmentMatches(segment, raw)) fail();
  }
  for (const note of report.notes) {
    const raw = bytesAt(BigInt(note.location.offset), 12);
    if (
      BigInt(note.owner_location.bytes) !== BigInt(raw.readUInt32LE(0)) ||
      BigInt(note.descriptor_location.bytes) !== BigInt(raw.readUInt32LE(4)) ||
      !matchesKind(raw.readUInt32LE(8), note.type, noteKinds)
    )
      fail();
    const owner = bytesAt(
      BigInt(note.owner_location.offset),
      raw.readUInt32LE(0),
    );
    const terminator = owner.indexOf(0);
    const display =
      owner.length === 0
        ? null
        : owner.subarray(0, terminator).toString("utf8");
    if ((owner.length > 0 && terminator < 0) || note.owner_display !== display)
      fail();
  }
}
