import { err, ok } from "../result.js";

/** Decode a fixed LC_SEGMENT/LC_SEGMENT_64 record; callers own command and mapping admission. */
export const readMachoSegmentHeader = (
  bytes: Uint8Array,
  wide: boolean,
  littleEndian: boolean,
) => {
  const headerSize = wide ? 72 : 56;
  if (bytes.byteLength < headerSize)
    return err({
      kind: "malformed" as const,
      message: "Mach-O segment header is truncated",
    });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (offset: number): bigint =>
    wide
      ? view.getBigUint64(offset, littleEndian)
      : BigInt(view.getUint32(offset, littleEndian));
  return ok({
    headerSize,
    nameBytes: Buffer.from(bytes.subarray(8, 24)),
    address: word(24),
    memorySize: word(wide ? 32 : 28),
    fileOffset: word(wide ? 40 : 32),
    fileSize: word(wide ? 48 : 36),
    maxProtection: view.getUint32(wide ? 56 : 40, littleEndian),
    protection: view.getUint32(wide ? 60 : 44, littleEndian),
    sectionCount: view.getUint32(wide ? 64 : 48, littleEndian),
  });
};
