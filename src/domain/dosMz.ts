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

export type MzWindowsHeaderObservation =
  | { readonly state: "absent" }
  | { readonly state: "header-needed" }
  | { readonly state: "signature-needed"; readonly offset: number }
  | {
      readonly state: "declared";
      readonly offset: number;
      readonly signature: "PE" | "NE" | "LE" | "LX" | "other" | "unobserved";
    };

/**
 * Observe the Windows new-header pointer without mistaking short DOS module
 * bytes for e_lfanew. Complete DOS headers declare their pointer; for shorter
 * headers, only a PE/NE/LE/LX signature at that pointer confirms the candidate.
 * A bounded prefix that does not reach the candidate requests one bounded read
 * from its owner instead of treating unexamined bytes as absent.
 */
export const observeMzWindowsHeader = (
  bytes: Buffer,
  fileSize = bytes.length,
  signatureAtOffset?: Buffer,
): MzWindowsHeaderObservation => {
  if (bytes.length < 64)
    return fileSize >= 64 ? { state: "header-needed" } : { state: "absent" };
  const headerBytes = bytes.readUInt16LE(8) * 16;
  const relocationCount = bytes.readUInt16LE(6);
  const tableStart = bytes.readUInt16LE(24);
  if (
    headerBytes !== 0 &&
    relocationCount > 0 &&
    tableStart < 64 &&
    tableStart + relocationCount * 4 > 60
  )
    return { state: "absent" };
  const offset = bytes.readUInt32LE(60);
  if (offset === 0) return { state: "absent" };
  const inlineSignature =
    offset < bytes.length
      ? bytes.subarray(offset, Math.min(offset + 4, bytes.length))
      : undefined;
  const available = signatureAtOffset ?? inlineSignature;
  const signature = windowsHeaderSignature(available);
  if (headerBytes === 0 || headerBytes >= 64)
    return { state: "declared", offset, signature };
  if (signature !== "other" && signature !== "unobserved")
    return { state: "declared", offset, signature };
  if (signature === "other") return { state: "absent" };
  const observedPePrefix =
    available !== undefined &&
    available.length >= 2 &&
    available.toString("latin1", 0, 2) === "PE";
  if (fileSize - offset < (observedPePrefix ? 4 : 2))
    return { state: "absent" };
  return { state: "signature-needed", offset };
};

const windowsHeaderSignature = (
  bytes: Buffer | undefined,
): "PE" | "NE" | "LE" | "LX" | "other" | "unobserved" => {
  if (bytes === undefined || bytes.length < 2) return "unobserved";
  const prefix = bytes.toString("latin1", 0, 2);
  if (prefix === "NE" || prefix === "LE" || prefix === "LX") return prefix;
  if (prefix !== "PE") return "other";
  if (bytes.length < 4) return "unobserved";
  return bytes.subarray(0, 4).equals(Buffer.from("PE\0\0", "binary"))
    ? "PE"
    : "other";
};

/**
 * Validate a DOS MZ load module using a bounded header/table and the actual
 * file length. Appended overlay bytes are retained separately; they are not
 * silently included in the initialized load module.
 */
export const parseDosMzHeader = (
  bytes: Buffer,
  fileSize = bytes.length,
  signatureAtOffset?: Buffer,
): Result<DosMzHeader, string> => {
  if (bytes.length < 28 || bytes.toString("latin1", 0, 2) !== "MZ")
    return err("invalid or truncated DOS MZ header");
  if (!Number.isSafeInteger(fileSize) || fileSize < bytes.length)
    return err("invalid DOS MZ file length");
  const windowsHeader = observeMzWindowsHeader(
    bytes,
    fileSize,
    signatureAtOffset,
  );
  if (windowsHeader.state === "declared")
    return err("MZ declares a Windows new header; it is not a DOS-only image");
  if (windowsHeader.state === "signature-needed")
    return err("MZ Windows new-header signature is outside the bounded prefix");
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
  if (windowsHeader.state === "header-needed")
    return err("MZ Windows new-header pointer is outside the bounded prefix");
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
