import type { FileHandle } from "node:fs/promises";

/** Read through EOF, returning undefined on overflow; consume at most maxBytes + 1 bytes without closing the handle. */
export const readBoundedFileBytes = async (
  handle: FileHandle,
  maxBytes: number,
): Promise<Buffer | undefined> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError("File byte limit must be a nonnegative safe integer");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, maxBytes + 1));
  let total = 0;
  for (;;) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, maxBytes - total + 1),
      null,
    );
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > maxBytes) return undefined;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
};
