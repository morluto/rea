import type { BinaryReader } from "../binaryContainer.js";

export const ZIP_LOCAL_HEADER_BYTES = 30;
export const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** Locate the data after the fixed header, file name and extra field. */
export const zipLocalDataOffset = (
  header: BinaryReader,
  offset: number,
): number | undefined =>
  header.bytes.length >= ZIP_LOCAL_HEADER_BYTES &&
  header.u32(0) === ZIP_LOCAL_HEADER_SIGNATURE
    ? offset + ZIP_LOCAL_HEADER_BYTES + header.u16(26) + header.u16(28)
    : undefined;
