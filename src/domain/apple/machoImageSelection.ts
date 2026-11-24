import { err, ok, type Result } from "../result.js";
import { BinaryReader } from "../binaryContainer.js";
import type { ParseFailure } from "../parseFailure.js";
import {
  classifyFatContainerEvidence,
  fatSliceOverlapReason,
  findOverlappingFatSlices,
  inspectFatSliceRange,
  readFatContainerHeader,
  readMachoHeaderPrefixFacts,
  validateFatSliceIdentity,
  type FatContainerHeader,
  type FatSliceDeclaration,
  type MachoHeaderPrefixFacts,
} from "./machoContainer.js";
import type { ByteSource } from "../byteSource.js";

type UniversalMachoHeader = Extract<FatContainerHeader, { state: "parsed" }>;

/** The ParseFailure format of a Mach-O image and its universal container. */
export const MACHO_FORMAT = "macho";

/** What the container reader established about the universal file's bytes. */
export type MachoContainerFailure = Extract<
  ParseFailure,
  { readonly kind: "malformed" | "truncated" | "unsupported" }
>;

/**
 * The universal file's own format failure, raised once here. `failure.kind`
 * is truncated only where this reader measured bytes ending inside a
 * structure, unsupported where the container reader classified the form as
 * outside coverage, and malformed otherwise. `message` is the failure's detail.
 */
export interface MachoImageSelectionFailure {
  readonly kind: "format";
  readonly message: string;
  readonly failure: MachoContainerFailure;
}

const containerFailure = (
  kind: MachoContainerFailure["kind"],
  detail: string,
  offset?: number,
): MachoImageSelectionFailure => {
  const at = offset === undefined ? {} : { offset };
  return {
    kind: "format",
    message: detail,
    failure:
      kind === "unsupported"
        ? { kind, format: MACHO_FORMAT, detail, undecodedContent: false, ...at }
        : { kind, format: MACHO_FORMAT, detail, ...at },
  };
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
  if (range !== null)
    return containerFailure(range.category, range.reason, slice.offset);
  if (prefix.identity === null)
    return containerFailure(
      "truncated",
      `FAT architecture ${slice.index} has a truncated Mach-O identity`,
      slice.offset,
    );
  const mismatch = validateFatSliceIdentity(slice, prefix.identity);
  return mismatch === null
    ? null
    : containerFailure("malformed", mismatch, slice.offset);
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
  if (fat.state !== "parsed")
    return err(
      fat.state === "malformed"
        ? containerFailure("malformed", fat.reason)
        : containerFailure("truncated", "Universal Mach-O header is truncated"),
    );
  const identity = classifyFatContainerEvidence(fat, bytes);
  if (identity.state === "malformed")
    return err(containerFailure(identity.category, identity.reason));
  if (identity.state !== "mach-o") return ok(null);
  // Every range is valid here; aliased declarations are a malformed container,
  // as the artifact reader also rules, not slices to choose between.
  const overlap = findOverlappingFatSlices(fat.slices);
  return overlap === null
    ? ok(fat)
    : err(containerFailure("malformed", fatSliceOverlapReason(overlap)));
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

const readSourceSlice = (
  source: ByteSource,
  offset: number,
  length: number,
): Promise<Buffer> => {
  if (length <= 0 || offset >= source.size)
    return Promise.resolve(Buffer.alloc(0));
  const clamped = Math.min(length, source.size - offset);
  if (source.prefix !== undefined && offset + clamped <= source.prefix.length)
    return Promise.resolve(source.prefix.subarray(offset, offset + clamped));
  return source.readRange(offset, clamped);
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
  const initial = await readSourceSlice(source, 0, Math.min(4096, source.size));
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
        tableBytes = await readSourceSlice(source, 0, needed);
        fat = readFatContainerHeader(tableBytes, source.size);
      }
    }
  }
  if (fat.state !== "parsed")
    return err(
      fat.state === "malformed"
        ? containerFailure("malformed", fat.reason)
        : containerFailure("truncated", "Universal Mach-O header is truncated"),
    );
  if (tableBytes.length < fat.tableEnd)
    tableBytes = await readSourceSlice(source, 0, fat.tableEnd);
  const sliceHeadersByOffset = new Map<number, MachoHeaderPrefixFacts>();
  for (const [index, slice] of fat.slices.entries()) {
    if (fat.rangeIssues[index] !== null || slice.size < 4) continue;
    if (sliceHeadersByOffset.has(slice.offset)) continue;
    const slicePrefix = await readSourceSlice(
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
  if (identity.state === "malformed")
    return err(containerFailure(identity.category, identity.reason));
  if (identity.state !== "mach-o") return ok(null);
  const overlap = findOverlappingFatSlices(fat.slices);
  return overlap === null
    ? ok({ header: fat, tableBytes: tableBytes.subarray(0, fat.tableEnd) })
    : err(containerFailure("malformed", fatSliceOverlapReason(overlap)));
};

/** Validate one FAT slice by reading only its 16-byte Mach-O header prefix. */
export const validateUniversalMachoSliceFromReader = async (
  source: ByteSource,
  header: UniversalMachoHeader,
  slice: FatSliceDeclaration,
): Promise<Result<void, MachoImageSelectionFailure>> => {
  const prefix = await readSourceSlice(
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
