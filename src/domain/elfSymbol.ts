import { readUint16At, readUint32At, readUint64At } from "./binaryContainer.js";
import { err, ok, type Result } from "./result.js";

/** Wire widths of the fixed Elf32_Sym and Elf64_Sym prefixes. */
export const elfSymbolSize = (bits: 32 | 64): 16 | 24 =>
  bits === 64 ? 24 : 16;

export interface ElfSymbolFields {
  readonly name_offset: number;
  readonly binding: number;
  readonly type: number;
  readonly other: number;
  readonly section_index: number;
}

export interface ElfSymbol extends ElfSymbolFields {
  readonly value: bigint;
  readonly size: bigint;
}

const EXPORT_BINDINGS: Readonly<
  Partial<Record<number, "global" | "weak" | "unique">>
> = {
  1: "global",
  2: "weak",
  10: "unique",
};
const EXPORT_VISIBILITIES: Readonly<
  Partial<Record<number, "default" | "protected">>
> = {
  0: "default",
  3: "protected",
};

/** Lookup eligibility of a dynamic symbol binding, independent of definition ownership. */
export const elfSymbolExportBinding = (binding: number) =>
  EXPORT_BINDINGS[binding];

/** The low two bits of st_other encode visibility independently of processor flags. */
export const elfSymbolExportVisibility = (other: number) =>
  EXPORT_VISIBILITIES[other & 3];

export const ELF_SYMBOL_TRUNCATED_MESSAGE = "ELF symbol record is truncated";

const TRUNCATED_SYMBOL = Object.freeze(
  err({
    kind: "malformed" as const,
    message: ELF_SYMBOL_TRUNCATED_MESSAGE,
  }),
);

/** Decode the fixed symbol fields without materializing its address and size. */
export const readElfSymbolFieldsAt = (
  bytes: Uint8Array,
  offset: number,
  bits: 32 | 64,
  littleEndian: boolean,
): ElfSymbolFields | null => {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > bytes.byteLength - elfSymbolSize(bits)
  )
    return null;
  const attributes = offset + (bits === 64 ? 4 : 12);
  const info = bytes[attributes]!;
  return {
    name_offset: readUint32At(bytes, offset, littleEndian),
    binding: info >>> 4,
    type: info & 15,
    other: bytes[attributes + 1]!,
    section_index: readUint16At(bytes, attributes + 2, littleEndian),
  };
};

/** Decode only the `st_value` word of a symbol already bounds-checked by `readElfSymbolFieldsAt`. */
export const readElfSymbolValueAt = (
  bytes: Uint8Array,
  offset: number,
  bits: 32 | 64,
  littleEndian: boolean,
): bigint =>
  bits === 64
    ? readUint64At(bytes, offset + 8, littleEndian)
    : BigInt(readUint32At(bytes, offset + 4, littleEndian));

/** Decode one fixed ELF32/ELF64 symbol record without slicing its bytes. */
export const readElfSymbolAt = (
  bytes: Uint8Array,
  offset: number,
  bits: 32 | 64,
  littleEndian: boolean,
): ElfSymbol | null => {
  const fields = readElfSymbolFieldsAt(bytes, offset, bits, littleEndian);
  if (fields === null) return null;
  return bits === 64
    ? {
        ...fields,
        value: readUint64At(bytes, offset + 8, littleEndian),
        size: readUint64At(bytes, offset + 16, littleEndian),
      }
    : {
        ...fields,
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
