import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactLimits,
} from "../../artifacts/ArtifactReader.js";
import { streamChunkToBuffer } from "../../artifacts/StreamBytes.js";

export type HashResult = {
  readonly sha256: string;
  readonly bytes: number;
  readonly prefix: Buffer;
};

export const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Artifact inventory cancelled",
    );
};

export const preflightEntry = (
  entry: ArtifactEntry,
  limits: ArtifactLimits,
): void => {
  if (entry.declaredSize !== null && entry.declaredSize > limits.maxEntryBytes)
    throw new ArtifactReaderFailure(
      "limit",
      `Entry exceeds byte limit: ${entry.path}`,
    );
  if (
    entry.declaredSize !== null &&
    entry.compressedSize !== null &&
    entry.compressedSize === 0 &&
    entry.declaredSize > 0
  )
    throw new ArtifactReaderFailure(
      "limit",
      `Invalid compression ratio: ${entry.path}`,
    );
  if (
    entry.declaredSize !== null &&
    entry.compressedSize !== null &&
    entry.compressedSize > 0 &&
    entry.declaredSize / entry.compressedSize > limits.maxCompressionRatio
  )
    throw new ArtifactReaderFailure(
      "limit",
      `Compression ratio exceeds limit: ${entry.path}`,
    );
};

export const hashReadable = async (
  stream: Readable,
  maximum: number,
  signal?: AbortSignal,
): Promise<HashResult> => {
  const hash = createHash("sha256");
  const prefixes: Buffer[] = [];
  let prefixBytes = 0;
  let bytes = 0;
  for await (const raw of stream) {
    abortIfNeeded(signal);
    const chunk = streamChunkToBuffer(raw);
    bytes += chunk.length;
    if (bytes > maximum) {
      stream.destroy();
      throw new ArtifactReaderFailure(
        "limit",
        "Observed entry bytes exceed limit",
      );
    }
    hash.update(chunk);
    if (prefixBytes < 16) {
      const selected = chunk.subarray(0, 16 - prefixBytes);
      prefixes.push(selected);
      prefixBytes += selected.length;
    }
  }
  return { sha256: hash.digest("hex"), bytes, prefix: Buffer.concat(prefixes) };
};
