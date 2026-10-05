import { err, ok, type Result } from "./result.js";

/** DOS load-module coordinates before applying the loader's segment relocation. */
export interface DosMzHeader {
  readonly headerBytes: number;
  readonly imageBytes: number;
  readonly moduleBytes: number;
  readonly overlayBytes: number;
  readonly relocationCount: number;
  readonly relocationTableOffset: number;
  readonly entrySegment: number;
  readonly entryOffset: number;
}

/**
 * Locate a Windows new-header declaration without interpreting a short DOS
 * header's load-module or relocation-table bytes at 0x3c as e_lfanew. A
 * new-header pointer must lie in a sufficiently large header and outside
 * actual relocation records. Zero-sized legacy stubs remain eligible for
 * PE signature validation.
 */
export const mzWindowsHeaderOffset = (bytes: Buffer): number | null => {
  if (bytes.length < 64) return null;
  const headerBytes = bytes.readUInt16LE(8) * 16;
  if (headerBytes !== 0 && headerBytes < 64) return null;
  const relocationCount = bytes.readUInt16LE(6);
  const tableStart = bytes.readUInt16LE(24);
  if (
    headerBytes !== 0 &&
    relocationCount > 0 &&
    tableStart < 64 &&
    tableStart + relocationCount * 4 > 60
  )
    return null;
  const offset = bytes.readUInt32LE(60);
  return offset === 0 ? null : offset;
};

/**
 * Validate a DOS MZ load module using a bounded header/table and the actual
 * file length. Appended overlay bytes are retained separately; they are not
 * silently included in the initialized load module.
 */
export const parseDosMzHeader = (
  bytes: Buffer,
  fileSize = bytes.length,
): Result<DosMzHeader, string> => {
  if (bytes.length < 28 || bytes.toString("ascii", 0, 2) !== "MZ")
    return err("invalid or truncated DOS MZ header");
  if (!Number.isSafeInteger(fileSize) || fileSize < bytes.length)
    return err("invalid DOS MZ file length");
  if (mzWindowsHeaderOffset(bytes) !== null)
    return err("MZ declares a Windows new header; it is not a DOS-only image");
  const lastPageBytes = bytes.readUInt16LE(2);
  const pages = bytes.readUInt16LE(4);
  if (pages === 0 || lastPageBytes > 511)
    return err("invalid DOS MZ page count or final-page size");
  const imageBytes =
    (pages - 1) * 512 + (lastPageBytes === 0 ? 512 : lastPageBytes);
  const headerBytes = bytes.readUInt16LE(8) * 16;
  if (headerBytes < 28 || headerBytes >= imageBytes)
    return err("invalid DOS MZ header size or empty load module");
  if (imageBytes > fileSize) return err("truncated DOS MZ load module");
  const relocationCount = bytes.readUInt16LE(6);
  const relocationTableOffset = bytes.readUInt16LE(24);
  const tableEnd = relocationTableOffset + relocationCount * 4;
  if (
    relocationCount > 0 &&
    (relocationTableOffset < 28 || tableEnd > headerBytes)
  )
    return err("DOS MZ relocation table lies outside its header");
  if (relocationCount > 0 && tableEnd > bytes.length)
    return err("truncated DOS MZ relocation table");
  const moduleBytes = imageBytes - headerBytes;
  const relocations = validateRelocations(
    bytes,
    relocationTableOffset,
    relocationCount,
    moduleBytes,
  );
  if (!relocations.ok) return relocations;
  const entryOffset = bytes.readUInt16LE(20);
  const entrySegment = bytes.readUInt16LE(22);
  if (entrySegment * 16 + entryOffset >= moduleBytes)
    return err("DOS MZ entry point lies outside its initialized load module");
  return ok({
    headerBytes,
    imageBytes,
    moduleBytes,
    overlayBytes: fileSize - imageBytes,
    relocationCount,
    relocationTableOffset,
    entrySegment,
    entryOffset,
  });
};

const validateRelocations = (
  bytes: Buffer,
  relocationTableOffset: number,
  relocationCount: number,
  moduleBytes: number,
): Result<void, string> => {
  for (let index = 0; index < relocationCount; index += 1) {
    const record = relocationTableOffset + index * 4;
    const offset = bytes.readUInt16LE(record);
    const segment = bytes.readUInt16LE(record + 2);
    if (segment * 16 + offset + 2 > moduleBytes)
      return err(`DOS MZ relocation ${index} points outside its load module`);
  }
  return ok(undefined);
};
