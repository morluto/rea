import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  structuredRasterFixture,
  fgsRecordFixture,
} from "../../../tests/fixtures/structuredRaster.js";
import { DEFAULT_STRUCTURED_RASTER_GRAMMAR } from "../../domain/structuredRasterDiscovery.js";
import { StructuredRasterDiscoveryService } from "./StructuredRasterDiscoveryService.js";

it.each([
  [
    { grammar: { ...DEFAULT_STRUCTURED_RASTER_GRAMMAR, scanAlignment: 5 } },
    ["grammar", "scanAlignment"],
  ],
  [{ min_records: 9, max_records: 8 }, ["max_records"]],
  [
    {
      profile: "fgs-records",
      segments: [{ logicalOffset: 0, fileOffset: 0, length: 4 }],
    },
    ["segments"],
  ],
  [{ profile: "fgs-records", offset: 1 }, ["offset"]],
  [{ profile: "fgs-records", length: 16 }, ["length"]],
  [
    { segments: [{ logicalOffset: 0, fileOffset: 999999, length: 4 }] },
    ["segments"],
  ],
] as const)(
  "attributes invalid controls %j to %j",
  async (controls, issuePath) => {
    const root = await createTestTempDirectory("rea-structured-input-");
    const path = join(root, "source");
    await writeFile(path, fgsRecordFixture(structuredRasterFixture()));
    const service = new StructuredRasterDiscoveryService();
    try {
      const result = await service.inspect({ path, ...controls });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected input failure");
      expect(result.error).toMatchObject({
        issues: [expect.objectContaining({ path: [...issuePath] })],
      });
    } finally {
      await service.close();
    }
  },
);
