import type { FileHandle } from "node:fs/promises";
import { expect, it } from "vitest";

import {
  hashArtifactRange,
  readArtifactRange,
} from "./ArtifactCarrierRange.js";

/** A handle whose file shrank to `available` bytes after it was measured. */
const shrunk = (available: number): FileHandle =>
  ({
    read: async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      const bytesRead = Math.max(0, Math.min(length, available - position));
      buffer.fill(0x61, offset, offset + bytesRead);
      return { bytesRead, buffer };
    },
  }) as unknown as FileHandle;

it("reports a range past the measured file as outside it", async () => {
  const carrier = { handle: shrunk(8), fileSize: 8, signal: undefined };
  await expect(readArtifactRange(carrier, 4, 8)).resolves.toBeUndefined();
  await expect(hashArtifactRange(carrier, 4, 8)).resolves.toBeUndefined();
});

it("reports a short read inside the measured file as a changed file", async () => {
  const carrier = { handle: shrunk(4), fileSize: 16, signal: undefined };
  for (const read of [
    readArtifactRange(carrier, 0, 16),
    hashArtifactRange(carrier, 0, 16),
  ])
    await expect(read).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "read-coverage",
    });
});
