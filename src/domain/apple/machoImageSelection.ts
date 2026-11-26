import { err, ok, type Result } from "../result.js";
import { BinaryReader } from "../binaryContainer.js";
import {
  classifyFatContainerEvidence,
  fatSliceOverlapReason,
  findOverlappingFatSlices,
  inspectFatSliceRange,
  machoFailure,
  readFatContainerHeader,
  readMachoHeaderPrefixFacts,
  validateFatSliceIdentity,
  type MachoReadFailure,
  type FatContainerHeader,
  type FatSliceDeclaration,
  type MachoHeaderPrefixFacts,
} from "./machoContainer.js";
import { readByteSourceSlice, type ByteSource } from "../byteSource.js";

type UniversalMachoHeader = Extract<FatContainerHeader, { state: "parsed" }>;

/**
 * The universal file's own failure, raised once here. `failure.kind` is
 * truncated only where this reader measured bytes ending inside a structure,
 * changed where a read came up short of the measured file, unsupported where
 * the container reader classified the form as outside coverage, and
 * malformed otherwise. `message` is the failure's detail.
 */
export interface MachoImageSelectionFailure {
  readonly kind: "target";
  readonly message: string;
  readonly failure: MachoReadFailure;
}

const targetFailure = (
  failure: MachoReadFailure,
): MachoImageSelectionFailure => ({
  kind: "target",
  message: failure.detail,
  failure,
});

/**
 * The universal file's own failure for a FAT header the container reader did
 * not parse. A header or table past the file's measured end carries that
 * reader's extent; `needs-data` remains only when a read returned fewer bytes
 * than the measured size admits.
 */
const unparsedHeaderFailure = (
  fat: Exclude<FatContainerHeader, { state: "parsed" | "not-fat" }>,
): MachoImageSelectionFailure => {
  if (fat.state === "malformed")
    return targetFailure(machoFailure.malformed(fat.reason));
  // The measured size admits the header, so bytes still missing after the
  // read mean the file changed while it was read.
  if (fat.state === "needs-data")
    return targetFailure(
      machoFailure.changed(
        "Universal Mach-O header read came up short of the measured file",
      ),
    );
  return targetFailure(
    machoFailure.truncated(fat.reason, { extent: fat.extent }),
  );
};

/**
 * Check one selected declaration against its slice's observed header prefix.
 * The table entry and the slice header are two records in the same file, so
 * their disagreement breaks the container's own rule: malformed, never the
 * caller's selection.
 */
const sliceFailure = (
  slice: FatSliceDeclaration,
  containerSize: number,
  tableEnd: number,
  prefix: MachoHeaderPrefixFacts,
): MachoImageSelectionFailure | null => {
  const range = inspectFatSliceRange(slice, containerSize, tableEnd);
  if (range !== null) return targetFailure(range);
  if (prefix.identity === null)
    return targetFailure(
      machoFailure.truncated(
        `FAT architecture ${slice.index} has a truncated Mach-O identity`,
        { offset: slice.offset },
      ),
    );
  const mismatch = validateFatSliceIdentity(slice, prefix.identity);
  return mismatch === null
    ? null
    : targetFailure(machoFailure.malformed(mismatch, { offset: slice.offset }));
};

/**
 * Admit a complete in-memory universal image whose slices do not overlap;
 * FAT-shaped JVM data remains unselected.
 */
export const readUniversalMachoImage = (
  bytes: Uint8Array,
): Result<UniversalMachoHeader | null, MachoImageSelectionFailure> => {
  const fat = readFatContainerHeader(bytes, bytes.byteLength);
  if (fat.state === "not-fat") return ok(null);
  if (fat.state !== "parsed") return err(unparsedHeaderFailure(fat));
  const identity = classifyFatContainerEvidence(fat, bytes);
  if (identity.state === "failed") return err(targetFailure(identity.failure));
  if (identity.state !== "mach-o") return ok(null);
  // Every range is valid here; aliased declarations are a malformed container,
  // as the artifact reader also rules, not slices to choose between.
  const overlap = findOverlappingFatSlices(fat.slices);
  return overlap === null
    ? ok(fat)
    : err(
        targetFailure(machoFailure.malformed(fatSliceOverlapReason(overlap))),
      );
};

/** Validate the selected declaration against the complete embedded CPU identity. */
export const readUniversalMachoSlice = (
  bytes: Buffer,
  header: UniversalMachoHeader,
  slice: FatSliceDeclaration,
): Result<Buffer, MachoImageSelectionFailure> => {
  const image = bytes.subarray(slice.offset, slice.offset + slice.size);
  const failure = sliceFailure(
    slice,
    bytes.length,
    header.tableEnd,
    readMachoHeaderPrefixFacts(image),
  );
  return failure === null ? ok(image) : err(failure);
};

/**
 * Admit a universal Mach-O header over a random-access source without buffering
 * slice payloads; returns both the parsed header and the raw container table bytes.
 */
export const readUniversalMachoImageFromReader = async (
  source: ByteSource,
): Promise<
  Result<
    {
      readonly header: UniversalMachoHeader;
      readonly tableBytes: Buffer;
    } | null,
    MachoImageSelectionFailure
  >
> => {
  const initial = await readByteSourceSlice(
    source,
    0,
    Math.min(4096, source.size),
  );
  let fat = readFatContainerHeader(initial, source.size);
  if (fat.state === "not-fat") return ok(null);
  let tableBytes = initial;
  if (fat.state === "needs-data" && initial.length < source.size) {
    // A large FAT table can exceed 4 KiB (up to 8 + nfat_arch * 32 bytes).
    if (initial.length >= 8) {
      const headerReader = new BinaryReader(initial, false, "macho");
      const magic = headerReader.u32(0);
      const count = headerReader.u32(4);
      const entryBytes = magic === 0xcafebabf ? 32 : 20;
      const needed = Math.min(
        source.size,
        8 + Math.min(count, 4096) * entryBytes,
      );
      if (needed > initial.length) {
        tableBytes = await readByteSourceSlice(source, 0, needed);
        fat = readFatContainerHeader(tableBytes, source.size);
      }
    }
  }
  if (fat.state === "not-fat") return ok(null);
  if (fat.state !== "parsed") return err(unparsedHeaderFailure(fat));
  if (tableBytes.length < fat.tableEnd)
    tableBytes = await readByteSourceSlice(source, 0, fat.tableEnd);
  const sliceHeadersByOffset = new Map<number, MachoHeaderPrefixFacts>();
  for (const [index, slice] of fat.slices.entries()) {
    if (fat.rangeIssues[index] !== null || slice.size < 4) continue;
    if (sliceHeadersByOffset.has(slice.offset)) continue;
    const slicePrefix = await readByteSourceSlice(
      source,
      slice.offset,
      Math.min(16, slice.size),
    );
    sliceHeadersByOffset.set(
      slice.offset,
      readMachoHeaderPrefixFacts(slicePrefix),
    );
  }
  const identity = classifyFatContainerEvidence(
    fat,
    tableBytes,
    sliceHeadersByOffset,
  );
  if (identity.state === "failed") return err(targetFailure(identity.failure));
  if (identity.state !== "mach-o") return ok(null);
  const overlap = findOverlappingFatSlices(fat.slices);
  return overlap === null
    ? ok({ header: fat, tableBytes: tableBytes.subarray(0, fat.tableEnd) })
    : err(
        targetFailure(machoFailure.malformed(fatSliceOverlapReason(overlap))),
      );
};

/** Validate one FAT slice by reading only its 16-byte Mach-O header prefix. */
export const validateUniversalMachoSliceFromReader = async (
  source: ByteSource,
  header: UniversalMachoHeader,
  slice: FatSliceDeclaration,
): Promise<Result<void, MachoImageSelectionFailure>> => {
  const prefix = await readByteSourceSlice(
    source,
    slice.offset,
    Math.min(16, slice.size),
  );
  const failure = sliceFailure(
    slice,
    source.size,
    header.tableEnd,
    readMachoHeaderPrefixFacts(prefix),
  );
  return failure === null ? ok(undefined) : err(failure);
};
