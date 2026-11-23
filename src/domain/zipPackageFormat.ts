import { BinaryReader } from "./binaryContainer.js";
import {
  ZIP_CENTRAL_HEADER,
  readZipCentralExtent,
} from "./zip/zipCentralHeader.js";
import {
  ZIP_LOCAL_HEADER_BYTES,
  zipLocalDataOffset,
} from "./zip/zipLocalHeader.js";
import { ZIP_EXTRA_FIELD, lastZipExtraField } from "./zip/zipExtraFields.js";
import {
  type ZipEndOfCentralDirectory,
  ZIP_CLASSIC_DIRECTORY_LIMITS,
  ZIP64_END,
  ZIP64_LOCATOR,
  readZip64DirectoryRecord,
  readZip64Locator,
  zip64EndUsesSingleVolume,
  zip64LocatorUsesSingleVolume,
  zipEndOfCentralDirectoryCandidates,
  zipEndUsesSingleVolume,
  ZIP_EOCD_BYTES,
  ZIP_MAX_COMMENT_BYTES,
} from "./zipEndOfCentralDirectory.js";

/** Application package identities carried by ZIP containers. */
export const ZIP_APPLICATION_PACKAGE_FORMATS = [
  "ipa",
  "apk",
  "msix",
  "appx",
  "hap",
  "hsp",
  "app-pack",
] as const;

/** The generic ZIP container and its application packages share an archive reader. */
export const ZIP_PACKAGE_FORMATS = [
  "zip",
  ...ZIP_APPLICATION_PACKAGE_FORMATS,
] as const;
export type ZipPackageFormat = (typeof ZIP_PACKAGE_FORMATS)[number];

/** All ZIP package families share archive ownership and inventory coverage. */
export const isZipPackageFormat = (
  format: string,
): format is ZipPackageFormat =>
  ZIP_PACKAGE_FORMATS.some((candidate) => candidate === format);

/** Local-header, classic/Zip64 empty-archive, and split ZIP signatures. */
export const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x06, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
] as const;

/** A local file header can identify a ZIP before a complete end record is available. */
export const hasZipLocalHeader = (bytes: Uint8Array): boolean =>
  ZIP_SIGNATURES[0].every((byte, index) => bytes[index] === byte);

/** Recognize a ZIP signature, not directory validity or supported storage. */
export const hasZipSignature = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  ZIP_SIGNATURES.some((signature) =>
    signature.every((byte, index) => bytes[index] === byte),
  );

/** Positional read of at most `length` bytes; a short result means end of file. */
export type PositionalRead = (
  position: number,
  length: number,
) => Promise<Uint8Array>;

type TrailingDirectory = {
  readonly end: number;
  readonly size: bigint;
  readonly offset: bigint;
  readonly entries: bigint;
};

/** Resolve the end record without reading an extensible sector or directory. */
const trailingDirectory = async (
  end: number,
  classic: ZipEndOfCentralDirectory,
  read: PositionalRead,
): Promise<TrailingDirectory | undefined> => {
  const locatorAt = end - ZIP64_LOCATOR.bytes;
  const locator =
    locatorAt < 0
      ? undefined
      : readZip64Locator(
          new BinaryReader(
            Buffer.from(await read(locatorAt, ZIP64_LOCATOR.bytes)),
            true,
            "zip",
          ),
          0,
        );
  if (locator !== undefined) {
    const fallback = locatorAt - ZIP64_END.fixedBytes;
    // A declared pointer covers adjusted offsets and variable-size records;
    // the fixed-record fallback covers an unchanged archive after a prefix.
    for (const at of [
      locator.recordOffset <= BigInt(fallback)
        ? Number(locator.recordOffset)
        : -1,
      fallback,
    ]) {
      if (at < 0) continue;
      const record = readZip64DirectoryRecord(
        new BinaryReader(
          Buffer.from(await read(at, ZIP64_END.fixedBytes)),
          true,
          "zip",
        ),
        0,
        locatorAt - at,
      );
      if (!record.ok || record.value.end !== locatorAt - at) continue;
      if (
        !zipEndUsesSingleVolume(classic, "zip64Classic") ||
        !zip64LocatorUsesSingleVolume(locator) ||
        !zip64EndUsesSingleVolume(record.value) ||
        record.value.entriesOnDisk !== record.value.totalEntries
      )
        return undefined;
      return {
        end: at,
        size: record.value.directorySize,
        offset: record.value.directoryOffset,
        entries: record.value.totalEntries,
      };
    }
  }
  const limits = ZIP_CLASSIC_DIRECTORY_LIMITS;
  if (
    !zipEndUsesSingleVolume(classic) ||
    classic.entriesOnDisk !== classic.totalEntries ||
    classic.totalEntries === limits.count ||
    classic.directorySize === limits.size ||
    classic.directoryOffset === limits.offset
  )
    return undefined;
  return {
    end,
    size: BigInt(classic.directorySize),
    offset: BigInt(classic.directoryOffset),
    entries: BigInt(classic.totalEntries),
  };
};

/** Read only the conditional Zip64 local-offset field in the first record. */
const firstLocalOffset = async (
  reader: BinaryReader,
  directory: number,
  extent: { readonly extra: number; readonly comment: number },
  read: PositionalRead,
): Promise<bigint | undefined> => {
  const layout = ZIP_CENTRAL_HEADER;
  const offset = reader.u32(layout.localHeaderOffset);
  if (offset !== ZIP_CLASSIC_DIRECTORY_LIMITS.offset) return BigInt(offset);
  const length = extent.comment - extent.extra;
  const extra = Buffer.from(await read(directory + extent.extra, length));
  if (extra.length !== length) return undefined;
  const fields = new BinaryReader(extra, true, "zip");
  const selected = lastZipExtraField(fields, 0, length, ZIP_EXTRA_FIELD.zip64);
  if (!selected.ok || selected.value === undefined) return undefined;
  const { start, end } = selected.value;
  const sentinel = ZIP_CLASSIC_DIRECTORY_LIMITS.size;
  const at =
    start +
    (reader.u32(layout.uncompressedSizeOffset) === sentinel ? 8 : 0) +
    (reader.u32(layout.compressedSizeOffset) === sentinel ? 8 : 0);
  return at + 8 <= end ? fields.word(at, 64) : undefined;
};

/**
 * Recognize a single-disk ZIP whose end-of-central-directory record ends the
 * file after leading non-ZIP bytes, such as a self-extractor or script stub.
 * The first directory entry and the local header it refers to must fit their
 * respective regions. The probe handles adjusted and unadjusted member offsets
 * for nonempty classic and Zip64 ZIPs on a single volume.
 */
export const hasTrailingZipArchive = async (
  size: number,
  read: PositionalRead,
): Promise<boolean> => {
  if (!Number.isSafeInteger(size) || size < ZIP_EOCD_BYTES) return false;
  const tailStart = Math.max(0, size - ZIP_EOCD_BYTES - ZIP_MAX_COMMENT_BYTES);
  const tail = Buffer.from(await read(tailStart, size - tailStart));
  if (tail.length !== size - tailStart) return false;
  // A comment may contain EOCD-like bytes; validate each candidate's directory.
  for (const candidate of zipEndOfCentralDirectoryCandidates(tail)) {
    const frame = await trailingDirectory(
      tailStart + candidate.offset,
      candidate,
      read,
    );
    if (
      frame === undefined ||
      frame.entries === 0n ||
      frame.size < BigInt(ZIP_CENTRAL_HEADER.bytes) ||
      frame.size > BigInt(frame.end)
    )
      continue;
    const directoryBytes = Number(frame.size);
    const directory = frame.end - directoryBytes;
    // Offsets written before leading bytes were prepended are shifted by them.
    if (frame.offset > BigInt(directory)) continue;
    const shift = directory - Number(frame.offset);
    const header = Buffer.from(await read(directory, ZIP_CENTRAL_HEADER.bytes));
    const headerReader = new BinaryReader(header, true, "zip");
    const extent = readZipCentralExtent(headerReader, 0, directoryBytes);
    if (!extent.ok) continue;
    const declaredLocal = await firstLocalOffset(
      headerReader,
      directory,
      extent.value,
      read,
    );
    if (
      declaredLocal === undefined ||
      declaredLocal > BigInt(directory - shift)
    )
      continue;
    const localOffset = Number(declaredLocal) + shift;
    if (localOffset === 0 || localOffset > directory - ZIP_LOCAL_HEADER_BYTES)
      continue;
    const local = Buffer.from(await read(localOffset, ZIP_LOCAL_HEADER_BYTES));
    const dataOffset = zipLocalDataOffset(
      new BinaryReader(local, true, "zip"),
      localOffset,
    );
    if (dataOffset !== undefined && dataOffset <= directory) return true;
  }
  return false;
};

/**
 * Classify a ZIP-backed package by its complete lower-cased path suffix.
 *
 * This is deliberately extension-only. Callers must separately verify ZIP
 * magic before trusting the classification for a root input. HarmonyOS `.har`
 * is intentionally absent: the suffix also names HTTP Archive JSON, so a
 * Harmony shared archive is only established from verified ZIP bytes. The
 * HarmonyOS App Pack suffix `.app` is also absent here: it applies only to
 * root inputs (see `classifyAndHashRootForInventory`), because a nested ZIP entry ending
 * in `.app` inside another package, such as an IPA, is not an App Pack.
 */
export const zipPackageFormatForPath = (
  path: string,
): ZipPackageFormat | undefined => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".ipa")) return "ipa";
  // An Android App Bundle is a ZIP archive, not a standalone APK.
  if (lower.endsWith(".apk")) return "apk";
  if (lower.endsWith(".msix") || lower.endsWith(".msixbundle")) return "msix";
  if (lower.endsWith(".appx") || lower.endsWith(".appxbundle")) return "appx";
  if (lower.endsWith(".hap")) return "hap";
  if (lower.endsWith(".hsp")) return "hsp";
  return undefined;
};

/**
 * Classify a verified ZIP root input by its path. The HarmonyOS App Pack
 * suffix `.app` applies only to root inputs; a nested ZIP member ending in
 * `.app` keeps its observed format.
 */
export const zipRootPackageFormat = (path: string): ZipPackageFormat => {
  const lower = path.toLowerCase();
  return lower.endsWith(".app")
    ? "app-pack"
    : (zipPackageFormatForPath(lower) ?? "zip");
};

/** Inventory lists entries, not all bytes surrounding the central directory. */
export const ZIP_NON_ENTRY_LIMITATION =
  "ZIP inventory lists central-directory entries only. Non-entry bytes, including leading bytes before the first entry such as a self-extractor stub, an APK Signing Block before the central directory or a ZIP comment after it, are not occurrences.";
