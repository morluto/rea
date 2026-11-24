import { BinaryReader } from "../binaryContainer.js";
import type { PositionalRead } from "../zipPackageFormat.js";
import {
  ZIP_CLASSIC_DIRECTORY_LIMITS,
  ZIP_EOCD_BYTES,
  ZIP_MAX_COMMENT_BYTES,
  zipEndOfCentralDirectoryCandidates,
  zipEndUsesSingleVolume,
  type ZipEndOfCentralDirectory,
} from "../zipEndOfCentralDirectory.js";
import { ZIP_CENTRAL_HEADER } from "./zipCentralHeader.js";

/**
 * Central-directory prefix read when a generic ZIP may be a standalone APK.
 * A later `classes*.dex` or `AndroidManifest.xml` stays unclassified.
 */
export const ANDROID_ZIP_DIRECTORY_PROBE_BYTES = 8 * 1024 * 1024;

const MANIFEST = Buffer.from("AndroidManifest.xml");
const CLASSES = Buffer.from("classes");
const DEX = Buffer.from(".dex");

const sameBytes = (
  name: Uint8Array,
  at: number,
  expected: Uint8Array,
): boolean => {
  for (let index = 0; index < expected.length; index += 1)
    if (name[at + index] !== expected[index]) return false;
  return true;
};

/**
 * Root central-directory file name of a standalone Android package.
 * `classes.dex` and `classes2.dex` match; a slash or any other spelling does not.
 */
const isRootAndroidPackageEntryName = (name: Uint8Array): boolean => {
  if (name.length === MANIFEST.length && sameBytes(name, 0, MANIFEST))
    return true;
  if (
    name.length < CLASSES.length + DEX.length ||
    !sameBytes(name, 0, CLASSES) ||
    !sameBytes(name, name.length - DEX.length, DEX)
  )
    return false;
  for (
    let index = CLASSES.length;
    index < name.length - DEX.length;
    index += 1
  ) {
    const byte = name[index];
    if (byte === undefined || byte < 0x30 || byte > 0x39) return false;
  }
  return true;
};

/**
 * `true` when this end record's directory lists an Android package entry,
 * `false` when that directory was read far enough to decide it does not, and
 * `undefined` when the record is not a usable single-volume directory.
 */
const directoryDeclaresAndroidPackage = async (
  tailStart: number,
  candidate: ZipEndOfCentralDirectory,
  read: PositionalRead,
): Promise<boolean | undefined> => {
  const limits = ZIP_CLASSIC_DIRECTORY_LIMITS;
  if (
    !zipEndUsesSingleVolume(candidate) ||
    candidate.entriesOnDisk === limits.count ||
    candidate.totalEntries === limits.count ||
    candidate.directorySize === limits.size ||
    candidate.directoryOffset === limits.offset ||
    candidate.entriesOnDisk !== candidate.totalEntries
  )
    return undefined;
  const { directorySize, entriesOnDisk, directoryOffset } = candidate;
  const eocd = tailStart + candidate.offset;
  if (!Number.isSafeInteger(eocd) || directorySize > eocd) return undefined;
  // The directory abuts the end record. A declared offset before that point
  // is the unadjusted value from bytes prepended to the archive.
  const directory = eocd - directorySize;
  if (directory < directoryOffset) return undefined;
  // An empty record can be a decoy inside a comment. Skip it and let a
  // later candidate decide; a genuinely empty archive has no other record.
  if (entriesOnDisk === 0 || directorySize < ZIP_CENTRAL_HEADER.bytes)
    return undefined;
  const examined = Math.min(directorySize, ANDROID_ZIP_DIRECTORY_PROBE_BYTES);
  const bytes = Buffer.from(await read(directory, examined));
  if (bytes.length !== examined) return undefined;
  const reader = new BinaryReader(bytes, true, "zip");
  const headerBytes = ZIP_CENTRAL_HEADER.bytes;
  let at = 0;
  let seen = 0;
  while (at < directorySize) {
    if (at + headerBytes > bytes.length) return false;
    if (reader.u32(at) !== ZIP_CENTRAL_HEADER.signature)
      return seen === 0 ? undefined : false;
    const nameLength = reader.u16(at + ZIP_CENTRAL_HEADER.nameBytesOffset);
    const extraLength = reader.u16(at + ZIP_CENTRAL_HEADER.extraBytesOffset);
    const commentLength = reader.u16(
      at + ZIP_CENTRAL_HEADER.commentBytesOffset,
    );
    const next = at + headerBytes + nameLength + extraLength + commentLength;
    if (!Number.isSafeInteger(next) || next < at || next > directorySize)
      return seen === 0 ? undefined : false;
    const nameEnd = at + headerBytes + nameLength;
    if (
      nameEnd <= bytes.length &&
      isRootAndroidPackageEntryName(bytes.subarray(at + headerBytes, nameEnd))
    )
      return true;
    // The examined prefix ends inside this record, so later entries are unseen.
    if (next > bytes.length) return false;
    seen += 1;
    at = next;
    if (seen > entriesOnDisk) return false;
  }
  return false;
};

/**
 * Whether a verified ZIP lists a root `AndroidManifest.xml` or `classes*.dex`
 * entry in its central directory. The name field is compared as stored bytes.
 * A missing, split, Zip64-sentinel, malformed, or over-budget directory does
 * not declare an Android package; callers keep the path classification.
 */
export const zipDeclaresAndroidPackage = async (
  size: number,
  read: PositionalRead,
): Promise<boolean> => {
  if (!Number.isSafeInteger(size) || size < ZIP_EOCD_BYTES) return false;
  const tailLength = Math.min(size, ZIP_EOCD_BYTES + ZIP_MAX_COMMENT_BYTES);
  const tailStart = size - tailLength;
  const tail = Buffer.from(await read(tailStart, tailLength));
  if (tail.length !== tailLength) return false;
  for (const candidate of zipEndOfCentralDirectoryCandidates(tail)) {
    const declared = await directoryDeclaresAndroidPackage(
      tailStart,
      candidate,
      read,
    );
    if (declared !== undefined) return declared;
  }
  return false;
};
