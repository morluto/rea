import type { FileHandle } from "node:fs/promises";

import { ArtifactReaderFailure } from "./ArtifactReader.js";

/** Shared resource budget for the eagerly decoded ASAR header, not member bytes. */
export const MAX_ASAR_HEADER_BYTES = 16 * 1024 * 1024;

/** Admit both Chromium pickle extents before an upstream decoder allocates them. */
export const admitAsarHeader = async (
  handle: FileHandle,
): Promise<{
  readonly archiveBytes: number;
  readonly headerBytes: number;
  readonly jsonBytes: number;
}> => {
  const observed = await handle.stat();
  if (!observed.isFile())
    throw new ArtifactReaderFailure(
      "format",
      "ASAR container is not a regular file",
    );
  const prefix = Buffer.alloc(16);
  const read = await handle.read(prefix, 0, prefix.length, 0);
  if (read.bytesRead !== prefix.length || prefix.readUInt32LE(0) !== 4)
    throw new ArtifactReaderFailure(
      "format",
      "Truncated or invalid ASAR size pickle",
    );
  const headerBytes = prefix.readUInt32LE(4);
  const payloadBytes = prefix.readUInt32LE(8);
  const jsonBytes = prefix.readUInt32LE(12);
  if (
    headerBytes < 8 ||
    headerBytes > observed.size - 8 ||
    payloadBytes !== headerBytes - 4 ||
    jsonBytes > payloadBytes - 4
  )
    throw new ArtifactReaderFailure(
      "format",
      "ASAR header leaves its container or has invalid pickle extents",
    );
  if (headerBytes > MAX_ASAR_HEADER_BYTES)
    throw new ArtifactReaderFailure(
      "limit",
      `ASAR header exceeds the ${String(MAX_ASAR_HEADER_BYTES)} byte decode budget`,
    );
  return { archiveBytes: observed.size, headerBytes, jsonBytes };
};
