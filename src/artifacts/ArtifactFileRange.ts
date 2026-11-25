import type { FileHandle } from "node:fs/promises";
import {
  ArtifactReaderFailure,
  assertArtifactReadActive,
  malformedArtifact,
  truncatedArtifact,
} from "../resources/index.js";
import { invariantViolation } from "../domain/internalInvariant.js";

/**
 * Validate a physical extent before callers apply independent capacity
 * limits. A structure `format` declares past `end` is a truncated target;
 * a range REA computed that is not a byte range at all is a REA defect.
 */
export const assertArtifactFileRange = (
  format: string,
  position: number,
  length: number,
  end: number,
): void => {
  if (!Number.isSafeInteger(end) || end < 0)
    throw invariantViolation(
      `Artifact source end is not a byte count: ${String(end)}`,
    );
  if (
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    position < 0
  )
    throw malformedArtifact(
      format,
      `Artifact read range is not a byte range: ${String(position)}+${String(length)}`,
    );
  if (length > end - position)
    throw truncatedArtifact(format, "Artifact read exceeds its source range", {
      offset: position,
      availableBytes: Math.max(0, end - position),
      requiredBytes: length,
    });
};

/** Positional exact reads preserve short-read, cancellation and I/O semantics. */
export const readArtifactFileBytes = async (
  format: string,
  handle: Pick<FileHandle, "read">,
  position: number,
  length: number,
  end: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  assertArtifactFileRange(format, position, length, end);
  const buffer = Buffer.alloc(length);
  let consumed = 0;
  while (consumed < length) {
    assertArtifactReadActive(signal);
    const { bytesRead } = await handle.read(
      buffer,
      consumed,
      length - consumed,
      position + consumed,
    );
    assertArtifactReadActive(signal);
    // The range was checked against the measured end, so a short read means
    // the file changed underneath the read.
    if (bytesRead === 0)
      throw new ArtifactReaderFailure(
        "integrity",
        "Artifact source ended before its admitted extent",
        { integrityCheck: "read-coverage" },
      );
    consumed += bytesRead;
  }
  return buffer;
};
