import { BinaryReader } from "./binaryContainer.js";
import { err, ok, type Result } from "./result.js";

export const PE_SIZE_OF_HEADERS_OFFSET = 60;

/**
 * The Windows loader reads at most 16 data directories at their fixed
 * offsets; a larger NumberOfRvaAndSizes does not declare more of them.
 */
export const PE_MAX_DATA_DIRECTORIES = 16;

/**
 * The PE32+ optional header with all 16 directories. The loader reads its
 * fields at fixed offsets; SizeOfOptionalHeader only locates the section
 * table, so a reader takes at least these bytes when the file holds them.
 */
const PE_LOADER_OPTIONAL_HEADER_BYTES = 112 + PE_MAX_DATA_DIRECTORIES * 8;

/** Bytes to read at the optional header so fixed fields do not depend on SizeOfOptionalHeader. */
export const peOptionalHeaderReadBytes = (
  sizeOfOptionalHeader: number,
  available: number,
): number =>
  Math.max(
    0,
    Math.min(
      available,
      Math.max(sizeOfOptionalHeader, PE_LOADER_OPTIONAL_HEADER_BYTES),
    ),
  );

/** Raw data-directory words; entry 4 names file bytes, while resource entry 2 names an RVA. */
export interface PeDataDirectory {
  readonly address: number;
  readonly size: number;
  /** Byte offset of this entry relative to the optional header. */
  readonly offset: number;
}

export interface PeOptionalHeaderIdentity {
  readonly magic: 0x10b | 0x20b;
  readonly bits: 32 | 64;
  readonly format: "pe32" | "pe32-plus";
}

/** Structural facts copied from one declared PE optional header. */
export interface PeOptionalHeaderFixedFields extends PeOptionalHeaderIdentity {
  readonly imageBase: bigint;
  readonly sectionAlignment: number;
  readonly fileAlignment: number;
  readonly sizeOfImage: number;
  readonly sizeOfHeaders: number;
  /**
   * Null when the declared header ends before the DllCharacteristics word.
   * Mapping fields through SizeOfHeaders do not require it.
   */
  readonly dllCharacteristics: number | null;
  readonly directoryOffset: number;
  readonly directoryCountOffset: number;
}

export interface PeOptionalHeaderStructure extends Omit<
  PeOptionalHeaderFixedFields,
  "dllCharacteristics"
> {
  readonly dllCharacteristics: number;
  /** Directories the loader reads: NumberOfRvaAndSizes, capped at 16. */
  readonly directoryCount: number;
  /** NumberOfRvaAndSizes as stored. */
  readonly declaredDirectoryCount: number;
  readonly dataDirectories: readonly PeDataDirectory[];
}

export interface PeOptionalHeaderFailure {
  readonly kind: "malformed" | "unsupported";
  readonly reason:
    | "truncated-magic"
    | "unsupported-magic"
    | "truncated-fixed-fields"
    | "truncated-directory-table";
  readonly message: string;
}

const optionalHeaderReader = (bytes: Uint8Array): BinaryReader =>
  new BinaryReader(
    Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    true,
    "pe",
  );

/** Decode format identity without requiring mapping fields or directories. */
export const readPeOptionalHeaderIdentity = (
  bytes: Uint8Array,
): Result<PeOptionalHeaderIdentity, PeOptionalHeaderFailure> =>
  readIdentity(optionalHeaderReader(bytes));

const readIdentity = (
  reader: BinaryReader,
): Result<PeOptionalHeaderIdentity, PeOptionalHeaderFailure> => {
  if (reader.bytes.length < 2)
    return err({
      kind: "malformed",
      reason: "truncated-magic",
      message: "truncated PE optional header",
    });
  const magic = reader.u16(0);
  if (magic !== 0x10b && magic !== 0x20b)
    return err({
      kind: "unsupported",
      reason: "unsupported-magic",
      message: "Only PE32 and PE32+ image optional headers are supported",
    });
  const bits = magic === 0x20b ? 64 : 32;
  return ok({ magic, bits, format: bits === 64 ? "pe32-plus" : "pe32" });
};

/** Decode mapping fields without requiring a directory count or table. */
export const readPeOptionalHeaderFixedFields = (
  bytes: Uint8Array,
): Result<PeOptionalHeaderFixedFields, PeOptionalHeaderFailure> =>
  readFixedFields(optionalHeaderReader(bytes));

const readFixedFields = (
  reader: BinaryReader,
): Result<PeOptionalHeaderFixedFields, PeOptionalHeaderFailure> => {
  const identity = readIdentity(reader);
  if (!identity.ok) return identity;
  const { bits } = identity.value;
  const directoryOffset = bits === 64 ? 112 : 96;
  // SizeOfHeaders ends at byte 64. DllCharacteristics, at offset 70, is only
  // present when the declared header covers that word. NativeAOT and other
  // mapping-field consumers admit a 64-byte header.
  if (reader.bytes.length < PE_SIZE_OF_HEADERS_OFFSET + 4)
    return err({
      kind: "malformed",
      reason: "truncated-fixed-fields",
      message: "truncated PE optional header",
    });
  return ok({
    ...identity.value,
    imageBase: reader.word(bits === 64 ? 24 : 28, bits),
    sectionAlignment: reader.u32(32),
    fileAlignment: reader.u32(36),
    sizeOfImage: reader.u32(56),
    sizeOfHeaders: reader.u32(PE_SIZE_OF_HEADERS_OFFSET),
    dllCharacteristics: reader.bytes.length >= 72 ? reader.u16(70) : null,
    directoryOffset,
    directoryCountOffset: directoryOffset - 4,
  });
};

const readDirectory = (
  reader: BinaryReader,
  offset: number,
): PeDataDirectory => ({
  address: reader.u32(offset),
  size: reader.u32(offset + 4),
  offset,
});

export type PeOptionalHeaderDirectoryObservation =
  | { readonly state: "count-unavailable" }
  | { readonly state: "absent"; readonly count: number }
  | { readonly state: "truncated"; readonly count: number }
  | {
      readonly state: "present";
      readonly count: number;
      readonly directory: PeDataDirectory;
    };

/** Observe one declared entry independently of the availability of later entries. */
export const readPeOptionalHeaderDirectory = (
  bytes: Uint8Array,
  fixed: PeOptionalHeaderFixedFields,
  index: number,
): PeOptionalHeaderDirectoryObservation => {
  if (bytes.byteLength < fixed.directoryOffset)
    return { state: "count-unavailable" };
  const reader = optionalHeaderReader(bytes);
  const count = Math.min(
    reader.u32(fixed.directoryCountOffset),
    PE_MAX_DATA_DIRECTORIES,
  );
  if (index >= count) return { state: "absent", count };
  const offset = fixed.directoryOffset + index * 8;
  if (offset > bytes.byteLength - 8) return { state: "truncated", count };
  return {
    state: "present",
    count,
    directory: readDirectory(reader, offset),
  };
};

/**
 * Decode the directories the loader reads, at most 16, without admitting a
 * machine or directory address. Bytes past SizeOfOptionalHeader belong to
 * the same fixed layout when the caller supplies them.
 */
export const readPeOptionalHeaderStructure = (
  bytes: Uint8Array,
): Result<PeOptionalHeaderStructure, PeOptionalHeaderFailure> => {
  const reader = optionalHeaderReader(bytes);
  const parsed = readFixedFields(reader);
  if (!parsed.ok) return parsed;
  const fixed = parsed.value;
  if (bytes.byteLength < fixed.directoryOffset)
    return err({
      kind: "malformed",
      reason: "truncated-fixed-fields",
      message: "truncated PE optional header",
    });
  const declaredDirectoryCount = reader.u32(fixed.directoryCountOffset);
  const directoryCount = Math.min(
    declaredDirectoryCount,
    PE_MAX_DATA_DIRECTORIES,
  );
  if (
    directoryCount > Math.floor((bytes.byteLength - fixed.directoryOffset) / 8)
  )
    return err({
      kind: "malformed",
      reason: "truncated-directory-table",
      message: "truncated PE data-directory table",
    });
  const dataDirectories = Array.from({ length: directoryCount }, (_, index) =>
    readDirectory(reader, fixed.directoryOffset + index * 8),
  );
  // A directory table starts at byte 96 or 112, so the word at offset 70 is covered.
  const dllCharacteristics = fixed.dllCharacteristics;
  if (dllCharacteristics === null)
    return err({
      kind: "malformed",
      reason: "truncated-fixed-fields",
      message: "truncated PE optional header",
    });
  return ok({
    ...fixed,
    dllCharacteristics,
    directoryCount,
    declaredDirectoryCount,
    dataDirectories,
  });
};
