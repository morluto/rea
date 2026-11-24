import type { AsarHeaderAdmission } from "../config/asarHeaderAdmission.js";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { Readable } from "node:stream";

import {
  abortIfNeeded,
  digestReadableToCompletion,
  hashStableRootArtifactHandle,
  type StreamDigest,
} from "../resources/index.js";
import {
  createArtifactClassificationProbe,
  type ArtifactClassificationEvidence,
} from "./ArtifactClassificationProbe.js";

/** Full stream digest and byte count with bounded classification evidence. */
export type HashResult = ArtifactClassificationEvidence & StreamDigest;

/** Hash every stream byte, optionally feeding the same bytes to a scan aggregate. */
export const hashReadable = async (
  stream: Readable,
  signal?: AbortSignal,
  integrityAlgorithm?: "sha256" | "md5",
  asarHeaderAdmission?: AsarHeaderAdmission,
  observeChunk?: (chunk: Buffer) => void,
): Promise<HashResult> => {
  const completed = await hashReadableToCompletion(
    stream,
    signal,
    integrityAlgorithm,
    asarHeaderAdmission,
    observeChunk,
  );
  abortIfNeeded(signal);
  return completed;
};

/** Keep a fully delivered digest so its owner can validate before late cancellation.
 * Source stability remains the stream or caller's responsibility.
 */
export const hashReadableToCompletion = async (
  stream: Readable,
  signal?: AbortSignal,
  integrityAlgorithm?: "sha256" | "md5",
  asarHeaderAdmission?: AsarHeaderAdmission,
  observeChunk?: (chunk: Buffer) => void,
): Promise<HashResult> => {
  const probe = createArtifactClassificationProbe(asarHeaderAdmission);
  const digest = await digestReadableToCompletion(
    stream,
    signal,
    integrityAlgorithm,
    (chunk) => {
      observeChunk?.(chunk);
      probe.write(chunk);
    },
  );
  return { ...digest, ...probe.finish(digest.bytes) };
};

/** Hash and revalidate an open root descriptor, with the root's classification evidence. */
export const classifyStableRootArtifactHandle = async (
  path: string,
  handle: FileHandle,
  initial: Stats,
  signal?: AbortSignal,
): Promise<HashResult> => {
  const probe = createArtifactClassificationProbe(undefined);
  const digest = await hashStableRootArtifactHandle(
    path,
    handle,
    initial,
    signal,
    (chunk) => probe.write(chunk),
  );
  return { ...digest, ...probe.finish(digest.bytes) };
};
