import { err, ok } from "./result.js";

export type ElfProgramHeader = Extract<
  ReturnType<typeof readElfProgramHeader>,
  { readonly ok: true }
>["value"];

/** Fixed ELF32/ELF64 program declarations; consumers own type, precision and mapping admission. */
export const readElfProgramHeader = (
  bytes: Uint8Array,
  bits: 32 | 64,
  littleEndian: boolean,
) => {
  const wide = bits === 64;
  if (bytes.byteLength < (wide ? 56 : 32))
    return err({
      kind: "malformed" as const,
      message: "ELF program header is truncated",
    });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (at: number): bigint =>
    wide
      ? view.getBigUint64(at, littleEndian)
      : BigInt(view.getUint32(at, littleEndian));
  return ok({
    type: view.getUint32(0, littleEndian),
    flags: view.getUint32(wide ? 4 : 24, littleEndian),
    offset: word(wide ? 8 : 4),
    virtualAddress: word(wide ? 16 : 8),
    physicalAddress: word(wide ? 24 : 12),
    fileSize: word(wide ? 32 : 16),
    memorySize: word(wide ? 40 : 20),
    alignment: word(wide ? 48 : 28),
  });
};

/** Admit PT_LOAD sizes once for consumers that read through load mappings. */
export const admitElfLoadSegment = (
  segment: {
    readonly virtualAddress: bigint;
    readonly memorySize: bigint;
    readonly fileSize: bigint;
  },
  bits: 32 | 64,
) =>
  segment.fileSize > segment.memorySize ||
  segment.virtualAddress + segment.memorySize > 1n << BigInt(bits)
    ? err({
        kind: "malformed" as const,
        message: "ELF load segment sizes or addresses are invalid",
      })
    : ok(null);
