import { createHash } from "node:crypto";

import { bufferByteSource } from "../../../src/domain/byteSource.js";
import { inspectPeResourcesInputSchema } from "../../../src/domain/native/peResources.js";
import { parsePeResourcesFromSource } from "../../../src/domain/pe/peResourceInventory.js";
import { peResourceFixture } from "../../../src/domain/pe/peResources.fixture.js";

export const peResourceReportFixture = (
  bytes: Buffer = peResourceFixture().bytes,
  maxEntries?: number,
  signal?: AbortSignal,
) => {
  const path = "/fixtures/example.exe";
  return parsePeResourcesFromSource(
    bufferByteSource(bytes),
    {
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    inspectPeResourcesInputSchema.parse({ path, max_entries: maxEntries }),
    signal,
  );
};
