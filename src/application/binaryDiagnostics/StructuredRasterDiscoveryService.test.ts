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
      for (const key of Object.keys(report.resolved_controls)) {
        const controls = Object.fromEntries(
          Object.entries(report.resolved_controls).filter(
            ([name]) => name !== key,
          ),
        );
        expect(
          structuredRasterCandidatesSchema.safeParse({
            ...report,
            resolved_controls: controls,
          }).success,
          key,
        ).toBe(false);
      }
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

it("exposes explicit family alternatives and colored previews in logical coordinates", async () => {
  const { registryFixture } =
    await import("../../../tests/fixtures/rasterRegistry.js");
  const fixture = registryFixture();
  const root = await createTestTempDirectory("rea-structured-family-");
  const path = join(root, "source");
  await writeFile(path, fixture.bytes);
  const logicalBase = 8192;
  const service = new StructuredRasterDiscoveryService();
  try {
    const result = await service.inspect({
      path,
      segments: [
        {
          fileOffset: 0,
          logicalOffset: logicalBase,
          length: fixture.bytes.length,
        },
      ],
      resource_family: "record12-lut-registry",
      max_resources: 2,
      max_previews: 1,
      color_policy: {
        kind: "record12-lut-registry",
        theme_slot: 0,
        precision: "byte8",
        alpha: "opaque",
        sentinel: "disabled",
        rgb565_color_key: null,
      },
    });
    if (!result.ok) throw result.error;
    const report = structuredRasterCandidatesSchema.parse(
      result.value.normalized_result,
    );
    expect(result.value.parameters).not.toHaveProperty("family_max_work");
    expect(report.resourceFamily?.status).toBe("unique");
    const registry = report.resourceFamily?.registries[0];
    expect(registry?.range.offset).toBe(fixture.start + logicalBase);
    expect(registry?.pointerBias).toBe(fixture.bias - logicalBase);
    expect(registry?.bindings).toHaveLength(2);
    expect(registry?.availableBindings).toBe(fixture.count);
    expect(registry?.bindingsTruncated).toBe(true);
    expect(registry?.bindings[0]?.descriptorOffset).toBe(
      fixture.table + logicalBase,
    );
    expect(report.tables[0]?.resources[0]?.preview?.kind).toBe(
      "profile-declared",
    );
    expect(
      report.tables.flatMap((t) => t.resources).filter((r) => r.preview),
    ).toHaveLength(1);
    expect((await readFile(path)).equals(Buffer.from(fixture.bytes))).toBe(
      true,
    );
  } finally {
    await service.close();
  }
});
