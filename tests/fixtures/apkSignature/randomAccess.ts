import type { RandomAccessBytes } from "../../../src/domain/apkSignature/apkSigningBlock.js";

/** Expose fixture bytes through the same positional-read contract as a file. */
export const apkFixtureReader = (bytes: Uint8Array): RandomAccessBytes => ({
  size: bytes.length,
  prefix: bytes.subarray(0, 4),
  readRange: async (offset, length) => bytes.subarray(offset, offset + length),
});
