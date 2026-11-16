import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { streamChunkToBuffer } from "./StreamBytes.js";

/** Full stream digest and byte count. */
export interface StreamDigest {
  readonly sha256: string;
  readonly bytes: number;
  readonly md5?: string;
}

/**
 * Receives every digested chunk, in order, after it is hashed. A format owner
 * uses it to derive its own facts from the same bytes without a second read.
 */
export type StreamDigestObserver = (chunk: Buffer) => void;

/** Preserve the inventory cancellation reason at a stream boundary. */
export const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Artifact inventory cancelled",
      { cause: signal.reason },
    );
};

/** Keep a fully delivered digest so its owner can validate before late cancellation.
 * Source stability remains the stream or caller's responsibility.
 */
export const digestReadableToCompletion = async (
  stream: Readable,
  signal?: AbortSignal,
  integrityAlgorithm?: "sha256" | "md5",
  observe?: StreamDigestObserver,
): Promise<StreamDigest> => {
  const hash = createHash("sha256");
  const md5 = integrityAlgorithm === "md5" ? createHash("md5") : undefined;
  let bytes = 0;
  for await (const raw of stream) {
    abortIfNeeded(signal);
    const chunk = streamChunkToBuffer(raw);
    bytes += chunk.length;
    hash.update(chunk);
    md5?.update(chunk);
    observe?.(chunk);
  }
  return {
    sha256: hash.digest("hex"),
    ...(md5 === undefined ? {} : { md5: md5.digest("hex") }),
    bytes,
  };
};
