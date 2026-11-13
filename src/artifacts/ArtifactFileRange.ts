import type { FileHandle } from "node:fs/promises";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";

/** Validate a physical extent before callers apply independent capacity limits. */
export const assertArtifactFileRange = (
  position: number,
  length: number,
  end: number,
): void => {
  if (
    !Number.isSafeInteger(end) ||
    end < 0 ||
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    position < 0 ||
    length > end - position
  )
    throw new ArtifactReaderFailure(
      "format",
      "Artifact read exceeds its source range",
    );
};

/** Positional exact reads preserve short-read, cancellation and I/O semantics. */
export const readArtifactFileBytes = async (
  handle: Pick<FileHandle, "read">,
  position: number,
  length: number,
  end: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  assertArtifactFileRange(position, length, end);
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
    if (bytesRead === 0)
      throw new ArtifactReaderFailure("format", "Artifact source is truncated");
    consumed += bytesRead;
  }
  return buffer;
};
