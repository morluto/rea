import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import { abortIfNeeded, ArtifactReaderFailure } from "../resources/index.js";

interface ArtifactRangeCarrier {
  readonly handle: FileHandle;
  readonly fileSize: number;
  readonly signal: AbortSignal | undefined;
}

/**
 * Read exactly one bounded carrier range. A range outside the measured file
 * returns undefined: the format declared bytes the file does not have, so the
 * caller reports a truncated target. A short read inside it means the file
 * changed during the read, a read-coverage integrity failure.
 */
export const readArtifactRange = async (
  carrier: ArtifactRangeCarrier,
  offset: number,
  length: number,
): Promise<Buffer | undefined> => {
  abortIfNeeded(carrier.signal);
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > carrier.fileSize ||
    length > carrier.fileSize - offset
  )
    return undefined;
  const bytes = await readFileHandleRange(carrier.handle, offset, length, () =>
    abortIfNeeded(carrier.signal),
  );
  // The shared reader reports EOF before a late cancellation. These carrier
  // readers have always observed cancellation after every read, including EOF.
  abortIfNeeded(carrier.signal);
  if (bytes.length !== length)
    throw new ArtifactReaderFailure(
      "integrity",
      "Artifact carrier ended before its measured extent",
      { integrityCheck: "read-coverage" },
    );
  return bytes;
};

/** Hash one carrier range in bounded chunks; undefined means it lies outside the file. */
export const hashArtifactRange = async (
  carrier: ArtifactRangeCarrier,
  offset: number,
  length: number,
): Promise<string | undefined> => {
  const hash = createHash("sha256");
  let remaining = length;
  let position = offset;
  while (remaining > 0) {
    const chunkLength = Math.min(64 * 1024, remaining);
    const chunk = await readArtifactRange(carrier, position, chunkLength);
    if (chunk === undefined) return undefined;
    hash.update(chunk);
    position += chunkLength;
    remaining -= chunkLength;
  }
  return hash.digest("hex");
};
