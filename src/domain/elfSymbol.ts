import { readUint16At, readUint32At, readUint64At } from "./binaryContainer.js";
import { err, ok, type Result } from "./result.js";

/** Wire widths of the fixed Elf32_Sym and Elf64_Sym prefixes. */
export const elfSymbolSize = (bits: 32 | 64): 16 | 24 =>
  bits === 64 ? 24 : 16;

export interface ElfSymbol {
  readonly name_offset: number;
  readonly binding: number;
  readonly type: number;
  readonly other: number;
  readonly section_index: number;
  readonly value: bigint;
  readonly size: bigint;
}

export const ELF_SYMBOL_TRUNCATED_MESSAGE = "ELF symbol record is truncated";

const TRUNCATED_SYMBOL = Object.freeze(
  err({
    kind: "malformed" as const,
    message: ELF_SYMBOL_TRUNCATED_MESSAGE,
  }),
);

/**
 * Decode one fixed ELF32/ELF64 symbol record starting at `offset` without
 * creating a temporary slice or BinaryReader; returns `null` when truncated.
 */
export const readElfSymbolAt = (
  bytes: Uint8Array,
  offset: number,
  bits: 32 | 64,
  littleEndian: boolean,
): ElfSymbol | null => {
  const size = elfSymbolSize(bits);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > bytes.byteLength - size
  )
    return null;
  if (bits === 64) {
    const info = bytes[offset + 4]!;
    return {
      name_offset: readUint32At(bytes, offset, littleEndian),
      binding: info >>> 4,
      type: info & 15,
      other: bytes[offset + 5]!,
      section_index: readUint16At(bytes, offset + 6, littleEndian),
      value: readUint64At(bytes, offset + 8, littleEndian),
      size: readUint64At(bytes, offset + 16, littleEndian),
    };
  }
  const info = bytes[offset + 12]!;
  return {
    name_offset: readUint32At(bytes, offset, littleEndian),
    binding: info >>> 4,
    type: info & 15,
    other: bytes[offset + 13]!,
    section_index: readUint16At(bytes, offset + 14, littleEndian),
    value: BigInt(readUint32At(bytes, offset + 4, littleEndian)),
    size: BigInt(readUint32At(bytes, offset + 8, littleEndian)),
  };
};

/** Fixed ELF32/ELF64 symbol facts; consumers own definition, visibility and processor-flag policies.
 * section_index is the raw st_shndx field. Use readElfSymbolSectionReference
 * before treating it as a directory index: SHN_XINDEX requires a companion.
 */
export const readElfSymbol = (
  bytes: Uint8Array,
  bits: 32 | 64,
  littleEndian: boolean,
): Result<
  ElfSymbol,
  { readonly kind: "malformed"; readonly message: string }
> => {
  const symbol = readElfSymbolAt(bytes, 0, bits, littleEndian);
  return symbol === null ? TRUNCATED_SYMBOL : ok(symbol);
};
