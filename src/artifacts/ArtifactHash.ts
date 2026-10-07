import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { streamChunkToBuffer } from "./StreamBytes.js";

/** Full stream digest and byte count with bounded classification evidence. */
export type HashResult = {
  readonly sha256: string;
  readonly bytes: number;
  readonly prefix: Buffer;
};

/** Bounded classification evidence; this is not an executable format size limit. */
export const ARTIFACT_CLASSIFICATION_PREFIX_BYTES = 8_192;

/** Preserve the inventory cancellation reason at a stream boundary. */
export const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Artifact inventory cancelled",
    );
};

/** Hash every stream byte and retain its bounded classification prefix. */
export const hashReadable = async (
  stream: Readable,
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
    hash.update(chunk);
    if (prefixBytes < ARTIFACT_CLASSIFICATION_PREFIX_BYTES) {
      const selected = chunk.subarray(
        0,
        ARTIFACT_CLASSIFICATION_PREFIX_BYTES - prefixBytes,
      );
      prefixes.push(selected);
      prefixBytes += selected.length;
    }
  }
  return { sha256: hash.digest("hex"), bytes, prefix: Buffer.concat(prefixes) };
};
