import { BinaryReader } from "./binaryContainer.js";
import {
  ZIP_CENTRAL_HEADER,
  readZipCentralExtent,
} from "./zip/zipCentralHeader.js";
import {
  ZIP_LOCAL_HEADER_BYTES,
  zipLocalDataOffset,
} from "./zip/zipLocalHeader.js";
import {
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

/**
 * Recognize a single-disk ZIP whose end-of-central-directory record ends the
 * file after leading non-ZIP bytes, such as a self-extractor or script stub.
 * The first directory entry and the local header it refers to must fit their
 * respective regions. The probe handles adjusted and unadjusted member offsets
 * for nonempty classic ZIPs on a single volume.
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
    const {
      offset: record,
      entriesOnDisk,
      directorySize: directoryBytes,
      directoryOffset: declaredDirectory,
    } = candidate;
    if (
      !zipEndUsesSingleVolume(candidate) ||
      entriesOnDisk === 0 ||
      entriesOnDisk === 0xffff ||
      entriesOnDisk !== candidate.totalEntries ||
      directoryBytes < ZIP_CENTRAL_HEADER.bytes ||
      directoryBytes === 0xffffffff ||
      declaredDirectory === 0xffffffff
    )
      continue;
    const directory = tailStart + record - directoryBytes;
    // Offsets written before leading bytes were prepended are shifted by them.
    const shift = directory - declaredDirectory;
    if (directory < 0 || shift < 0) continue;
    const header = Buffer.from(await read(directory, ZIP_CENTRAL_HEADER.bytes));
    const headerReader = new BinaryReader(header, true, "zip");
    if (!readZipCentralExtent(headerReader, 0, directoryBytes).ok) continue;
    const localOffset =
      headerReader.u32(ZIP_CENTRAL_HEADER.localHeaderOffset) + shift;
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
