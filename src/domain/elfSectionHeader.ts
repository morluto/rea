import { BinaryReader } from "./binaryContainer.js";
import { err, ok } from "./result.js";

export const elfSectionHeaderWidth = (bits: 32 | 64): 40 | 64 =>
  bits === 64 ? 64 : 40;

/** Fixed ELF32/ELF64 section declarations; consumers own names, numbering and mapping admission. */
export const readElfSectionHeader = (
  bytes: Uint8Array,
  bits: 32 | 64,
  littleEndian: boolean,
) => {
  const wide = bits === 64;
  if (bytes.byteLength < elfSectionHeaderWidth(bits))
    return err({
      kind: "malformed" as const,
      message: "ELF section header is truncated",
    });
  const reader = new BinaryReader(
    Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    littleEndian,
    "elf",
  );
  const flags = reader.word(8, bits);
  return ok({
    nameOffset: reader.u32(0),
    type: reader.u32(4),
    flags,
    compressed: (flags & 0x800n) !== 0n,
    address: reader.word(wide ? 16 : 12, bits),
    offset: reader.word(wide ? 24 : 16, bits),
    size: reader.word(wide ? 32 : 20, bits),
    link: reader.u32(wide ? 40 : 24),
    info: reader.u32(wide ? 44 : 28),
    alignment: reader.word(wide ? 48 : 32, bits),
    entrySize: reader.word(wide ? 56 : 36, bits),
  });
};
