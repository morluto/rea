import { err, ok, type Result } from "./result.js";

/** The unsigned 16-bit page count bounds the initialized image, not overlays. */
export const dosMzImageByteLength = (bytes: Buffer): Result<number, string> => {
  if (bytes.length < 28 || bytes.toString("latin1", 0, 2) !== "MZ")
    return err("invalid or truncated DOS MZ header");
  const lastPageBytes = bytes.readUInt16LE(2);
  const pages = bytes.readUInt16LE(4);
  if (pages === 0 || lastPageBytes > 511)
    return err("invalid DOS MZ page count or final-page size");
  return ok((pages - 1) * 512 + (lastPageBytes === 0 ? 512 : lastPageBytes));
};

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
      /** A nonzero pointer exists, but no Windows signature confirms it. */
      readonly state: "candidate";
      readonly offset: number;
      readonly signature: "other" | "unobserved";
    }
  | {
      readonly state: "declared";
      readonly offset: number;
      readonly signature: "PE" | "NE" | "LE" | "LX";
    };

/** Exact signature bytes observed at the DOS header's declared offset. */
export interface MzWindowsHeaderSignatureEvidence {
  readonly offset: number;
  readonly bytes: Buffer;
}

/** A reader's layout limitation does not invalidate a recognized Windows signature. */
export const mzWindowsHeaderLayoutLimitation = (
  header: Extract<MzWindowsHeaderObservation, { state: "declared" }>,
): string | undefined =>
  header.offset < 64
    ? `Unsupported overlapping ${header.signature} header at file offset ${String(header.offset)}; this reader requires the Windows header outside the 64-byte DOS header`
    : undefined;

/**
 * Observe the Windows new-header pointer without mistaking short DOS module
 * bytes for e_lfanew. A nonzero pointer in a complete DOS header is only a
 * candidate until a PE/NE/LE/LX signature is observed. For shorter DOS headers,
 * only a recognized signature confirms a candidate because the field may be
 * module data.
 * A bounded prefix that does not reach the candidate requests one bounded read
 * from its owner instead of treating unexamined bytes as absent.
 */
export const observeMzWindowsHeader = (
  bytes: Buffer,
  fileSize = bytes.length,
  signatureEvidence?: MzWindowsHeaderSignatureEvidence,
): MzWindowsHeaderObservation => {
  if (bytes.length < 64)
    return fileSize >= 64 ? { state: "header-needed" } : { state: "absent" };
  const headerBytes = bytes.readUInt16LE(8) * 16;
  const relocationCount = bytes.readUInt16LE(6);
  const tableStart = bytes.readUInt16LE(24);
  const tableEnd = tableStart + relocationCount * 4;
  if (
    headerBytes !== 0 &&
    relocationCount > 0 &&
    tableStart < 64 &&
    tableEnd > 60
  )
    return { state: "absent" };
  const offset = bytes.readUInt32LE(60);
  if (offset === 0) return { state: "absent" };
  const inlineSignature =
    offset < bytes.length
      ? bytes.subarray(offset, Math.min(offset + 4, bytes.length))
      : undefined;
  const available =
    signatureEvidence?.offset === offset
      ? signatureEvidence.bytes
      : inlineSignature;
  const signature = windowsHeaderSignature(available);
  if (signature !== "other" && signature !== "unobserved")
    return { state: "declared", offset, signature };
  // A relocation table that ends inside a complete DOS header owns the rest of
  // that header as padding. An observed non-Windows signature confirms that a
  // dword in that padding is DOS data. An unread signature still requests the
  // bounded follow-up read when enough bytes remain to recognize one.
  if (
    headerBytes >= 64 &&
    relocationCount > 0 &&
    tableEnd <= 60 &&
    (signature === "other" || fileSize - offset < 2)
  )
    return { state: "absent" };
  if (headerBytes === 0 || headerBytes >= 64) {
    const remaining = fileSize - offset;
    const needsMore =
      (available === undefined && remaining >= 2) ||
      (available !== undefined && available.length < 2 && remaining >= 2) ||
      (available !== undefined &&
        available.length >= 2 &&
        available.toString("latin1", 0, 2) === "PE" &&
        available.length < 4 &&
        remaining >= 4);
    if (needsMore && signatureEvidence?.offset !== offset)
      return { state: "signature-needed", offset };
    return { state: "candidate", offset, signature };
  }
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
  const first = bytes[0];
  const second = bytes[1];
  if (first === 0x4e && second === 0x45) return "NE";
  if (first === 0x4c && second === 0x45) return "LE";
  if (first === 0x4c && second === 0x58) return "LX";
  if (first !== 0x50 || second !== 0x45) return "other";
  if (bytes.length < 4) return "unobserved";
  return bytes[2] === 0 && bytes[3] === 0 ? "PE" : "other";
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
  if (bytes.length < 28 || bytes.toString("latin1", 0, 2) !== "MZ")
    return err("invalid or truncated DOS MZ header");
  if (!Number.isSafeInteger(fileSize) || fileSize < bytes.length)
    return err("invalid DOS MZ file length");
  // DOS structure is parsed independently from the meaning of bytes at 0x3c.
  const extent = dosMzImageByteLength(bytes);
  if (!extent.ok) return extent;
  const imageBytes = extent.value;
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

/** Preserve DOS structural facts and Windows-pointer evidence independently. */
export interface MzHeaderEvidence {
  readonly dos: Result<DosMzHeader, string>;
  readonly windowsHeader: MzWindowsHeaderObservation;
}

export const parseMzHeaderEvidence = (
  bytes: Buffer,
  fileSize = bytes.length,
  signatureEvidence?: MzWindowsHeaderSignatureEvidence,
): MzHeaderEvidence => ({
  dos: parseDosMzHeader(bytes, fileSize),
  windowsHeader: observeMzWindowsHeader(bytes, fileSize, signatureEvidence),
});

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
