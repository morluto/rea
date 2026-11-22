import {
  readInt32At,
  readInt64At,
  readUint32At,
  readUint64At,
} from "./binaryContainer.js";
import { err, ok, type Result } from "./result.js";

export const ELF_RELR_DYNAMIC_TAGS = {
  standard: { address: 36n, size: 35n, entry: 37n },
  android: { address: 0x6fffe000n, size: 0x6fffe001n, entry: 0x6fffe003n },
} as const;

/** Android packed REL and RELA tables declare an address, byte size, and encoding. */
export const ELF_ANDROID_PACKED_RELOCATION_TABLES = [
  [0x6000000fn, 0x60000010n, "rel"],
  [0x60000011n, 0x60000012n, "rela"],
] as const;
export const ELF_ANDROID_PACKED_RELOCATION_TAGS =
  ELF_ANDROID_PACKED_RELOCATION_TABLES.flatMap(([address, size]) => [
    address,
    size,
  ]);

const androidRelocationTags = new Set<bigint>([
  ...Object.values(ELF_RELR_DYNAMIC_TAGS.android),
  ...ELF_ANDROID_PACKED_RELOCATION_TAGS,
]);

/** Recognize Android relocation declarations independently of decoding support. */
export const isElfAndroidRelocationDynamicTag = (tag: bigint): boolean =>
  androidRelocationTags.has(tag);

const relocationSectionTypes = new Set([
  4, // SHT_RELA
  9, // SHT_REL
  19, // SHT_RELR
  0x60000001, // SHT_ANDROID_REL
  0x60000002, // SHT_ANDROID_RELA
  0x6fffff00, // SHT_ANDROID_RELR
]);

export const isElfRelocationSectionType = (type: number): boolean =>
  relocationSectionTypes.has(type);

interface ElfRelocationEntry {
  readonly offset: bigint;
  readonly type: number;
  readonly symbolIndex: number;
}
interface ElfRelaEntry extends ElfRelocationEntry {
  readonly addend: bigint;
}
interface ElfRelocationFailure {
  readonly kind: "malformed";
  readonly message: string;
}

/** The class-specific r_info split, shared by fixed and Android packed records. */
export const decodeElfRelocationInfo = (info: bigint, bits: 32 | 64) => ({
  type: Number(info & (bits === 64 ? 0xffffffffn : 0xffn)),
  symbolIndex: Number(info >> (bits === 64 ? 32n : 8n)),
});

export const ELF_RELOCATION_TRUNCATED_MESSAGE =
  "ELF relocation entry is truncated";
const TRUNCATED_RELOCATION = Object.freeze(
  err<ElfRelocationFailure>({
    kind: "malformed",
    message: ELF_RELOCATION_TRUNCATED_MESSAGE,
  }),
);

export function readElfRelocationEntryAt(
  bytes: Uint8Array,
  offset: number,
  bits: 32 | 64,
  littleEndian: boolean,
  encoding: "rel",
): ElfRelocationEntry | null;
export function readElfRelocationEntryAt(
  bytes: Uint8Array,
  offset: number,
  bits: 32 | 64,
  littleEndian: boolean,
  encoding: "rela",
): ElfRelaEntry | null;
export function readElfRelocationEntryAt(
  bytes: Uint8Array,
  offset: number,
  bits: 32 | 64,
  littleEndian: boolean,
  encoding: "rel" | "rela",
): ElfRelocationEntry | ElfRelaEntry | null;
/**
 * Decode standard REL/RELA fields starting at `offset` without creating a
 * temporary slice or BinaryReader; returns `null` when truncated.
 */
export function readElfRelocationEntryAt(
  bytes: Uint8Array,
  offset: number,
  bits: 32 | 64,
  littleEndian: boolean,
  encoding: "rel" | "rela",
): ElfRelocationEntry | ElfRelaEntry | null {
  const isRela = encoding === "rela";
  if (bits === 64) {
    const width = isRela ? 24 : 16;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > bytes.byteLength - width
    )
      return null;
    const relOffset = readUint64At(bytes, offset, littleEndian);
    const type = readUint32At(
      bytes,
      littleEndian ? offset + 8 : offset + 12,
      littleEndian,
    );
    const symbolIndex = readUint32At(
      bytes,
      littleEndian ? offset + 12 : offset + 8,
      littleEndian,
    );
    return isRela
      ? {
          offset: relOffset,
          type,
          symbolIndex,
          addend: readInt64At(bytes, offset + 16, littleEndian),
        }
      : { offset: relOffset, type, symbolIndex };
  }
  const width = isRela ? 12 : 8;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > bytes.byteLength - width
  )
    return null;
  const relOffset = BigInt(readUint32At(bytes, offset, littleEndian));
  const info = readUint32At(bytes, offset + 4, littleEndian);
  const type = info & 0xff;
  const symbolIndex = info >>> 8;
  return isRela
    ? {
        offset: relOffset,
        type,
        symbolIndex,
        addend: BigInt(readInt32At(bytes, offset + 8, littleEndian)),
      }
    : { offset: relOffset, type, symbolIndex };
}

export function readElfRelocationEntry(
  bytes: Uint8Array,
  bits: 32 | 64,
  littleEndian: boolean,
  encoding: "rel",
): Result<ElfRelocationEntry, ElfRelocationFailure>;
export function readElfRelocationEntry(
  bytes: Uint8Array,
  bits: 32 | 64,
  littleEndian: boolean,
  encoding: "rela",
): Result<ElfRelaEntry, ElfRelocationFailure>;
export function readElfRelocationEntry(
  bytes: Uint8Array,
  bits: 32 | 64,
  littleEndian: boolean,
  encoding: "rel" | "rela",
): Result<ElfRelocationEntry | ElfRelaEntry, ElfRelocationFailure>;
/** Decode standard REL/RELA fields; architecture-specific application remains with consumers. */
export function readElfRelocationEntry(
  bytes: Uint8Array,
  bits: 32 | 64,
  littleEndian: boolean,
  encoding: "rel" | "rela",
): Result<ElfRelocationEntry | ElfRelaEntry, ElfRelocationFailure> {
  const entry = readElfRelocationEntryAt(
    bytes,
    0,
    bits,
    littleEndian,
    encoding,
  );
  return entry === null ? TRUNCATED_RELOCATION : ok(entry);
}
