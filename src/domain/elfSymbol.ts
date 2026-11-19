import { BinaryReader } from "./binaryContainer.js";
import { err, ok } from "./result.js";

/** Wire widths of the fixed Elf32_Sym and Elf64_Sym prefixes. */
export const elfSymbolSize = (bits: 32 | 64): 16 | 24 =>
  bits === 64 ? 24 : 16;

/** Fixed ELF32/ELF64 symbol facts; consumers own definition, visibility and processor-flag policies.
 * section_index is the raw st_shndx field. Use readElfSymbolSectionReference
 * before treating it as a directory index: SHN_XINDEX requires a companion.
 */
export const readElfSymbol = (
  bytes: Uint8Array,
  bits: 32 | 64,
  littleEndian: boolean,
) => {
  const wide = bits === 64;
  if (bytes.byteLength < elfSymbolSize(bits))
    return err({
      kind: "malformed" as const,
      message: "ELF symbol record is truncated",
    });
  const reader = new BinaryReader(
    Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    littleEndian,
    "elf",
  );
  const info = reader.u8(wide ? 4 : 12);
  return ok({
    name_offset: reader.u32(0),
    binding: info >>> 4,
    type: info & 15,
    other: reader.u8(wide ? 5 : 13),
    section_index: reader.u16(wide ? 6 : 14),
    value: reader.word(wide ? 8 : 4, bits),
    size: reader.word(wide ? 16 : 8, bits),
  });
};
