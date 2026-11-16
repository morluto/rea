import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  structuredRasterFixture,
  fgsRecordFixture,
} from "../../../tests/fixtures/structuredRaster.js";
import { StructuredRasterDiscoveryService } from "./StructuredRasterDiscoveryService.js";
import { structuredRasterCandidatesSchema } from "../../domain/native/structuredRasterCandidates.js";
it.each(["flat", "fgs-records"] as const)(
  "publishes inferred tables with explicit %s provenance and index-only previews",
  async (profile) => {
    const root = await createTestTempDirectory("rea-structured-");
    const path = join(root, "bytes");
    const original =
      profile === "flat"
        ? structuredRasterFixture()
        : fgsRecordFixture(structuredRasterFixture());
    await writeFile(path, original);
    const service = new StructuredRasterDiscoveryService();
    try {
      const r = await service.inspect({
        path,
        profile,
        max_resources: 3,
        max_previews: 2,
      });
      if (!r.ok) throw r.error;
      const report = structuredRasterCandidatesSchema.parse(
        r.value.normalized_result,
      );
      expect(r.value.confidence).toBe("inferred");
      expect(report.projection).toMatchObject({
        availableResources: 12,
        returnedResources: 3,
        resourcesTruncated: true,
        previews: 2,
      });
      expect(report.tables[0]?.resources[0]?.preview?.kind).toBe("index-only");
      expect(report.mapping.logicalBase).toBe(profile === "flat" ? 0 : 4096);
      expect(report.tables[0]?.offset).toBe(report.mapping.logicalBase);
      expect(
        report.tables[0]?.resources[0]?.descriptorSourceMapping.ranges[0]
          ?.offset,
      ).toBe(profile === "flat" ? 0 : 12);
      expect((await readFile(path)).equals(original)).toBe(true);
    } finally {
      await service.close();
    }
  },
);
it("rejects damaged FGS integrity and profile/segment conflict", async () => {
  const root = await createTestTempDirectory("rea-structured-bad-");
  const path = join(root, "bytes");
  const bytes = fgsRecordFixture(structuredRasterFixture());
  bytes[20] = (bytes[20] ?? 0) ^ 1;
  await writeFile(path, bytes);
  const service = new StructuredRasterDiscoveryService();
  try {
    for (const extra of [
      {},
      { segments: [{ logicalOffset: 0, fileOffset: 0, length: 4 }] },
    ])
      expect(
        (await service.inspect({ path, profile: "fgs-records", ...extra })).ok,
      ).toBe(false);
  } finally {
    await service.close();
  }
});
it("preserves custom logical coordinates and does not preview uncovered payload", async () => {
  const root = await createTestTempDirectory("rea-structured-segments-");
  const path = join(root, "bytes"),
    bytes = structuredRasterFixture();
  await writeFile(path, bytes);
  const service = new StructuredRasterDiscoveryService();
  try {
    const r = await service.inspect({
      path,
      segments: [{ logicalOffset: 1000, fileOffset: 0, length: 144 }],
      max_previews: 8,
    });
    if (!r.ok) throw r.error;
    const report = structuredRasterCandidatesSchema.parse(
      r.value.normalized_result,
    );
    expect(report.mapping.logicalBase).toBe(1000);
    expect(report.projection.previews).toBe(0);
  } finally {
    await service.close();
  }
});
