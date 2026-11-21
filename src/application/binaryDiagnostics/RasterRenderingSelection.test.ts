import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { registryFixture } from "../../../tests/fixtures/rasterRegistry.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { structuredRasterCandidatesSchema } from "../../domain/native/structuredRasterCandidates.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import { StructuredRasterDiscoveryService } from "./StructuredRasterDiscoveryService.js";
import { StructuredRasterExportService } from "./StructuredRasterExportService.js";
import { renderRasterResource } from "./RasterResourceRendering.js";

const policy = {
  kind: "record12-lut-registry" as const,
  theme_slot: 0,
  precision: "byte8" as const,
  alpha: "opaque" as const,
  sentinel: "disabled" as const,
  rgb565_color_key: null as number | null,
};
function withoutPalette(rgb565: boolean) {
  const fixture = registryFixture();
  const view = new DataView(fixture.bytes.buffer);
  // Break only palette-array grammar, preserving the independently valid registry.
  view.setUint32(fixture.start - 4, 0, true);
  if (rgb565) {
    let offset = 0;
    for (let i = 0; i < fixture.count; i++) {
      const at = fixture.table + i * 12;
      fixture.bytes[at] = 6;
      view.setUint32(at + 8, offset, true);
      offset += (17 + i) * 3;
    }
    const payload = fixture.table + fixture.count * 12;
    for (let i = 0; i < offset; i++)
      view.setUint16(payload + i * 2, 0x8410, true);
  }
  return fixture;
}
function firstPixel(png: Buffer) {
  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT")
      chunks.push(png.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  return [...inflateSync(Buffer.concat(chunks)).subarray(1, 5)];
}
it.each([
  [null, "preview"],
  [0x8410, "preview"],
  [null, "export"],
  [0x8410, "export"],
] as const)(
  "renders palette-free RGB565 with explicit key %s via %s",
  async (key, mode) => {
    const fixture = withoutPalette(true);
    const root = await createTestTempDirectory("rea-palette-free-rgb565-");
    const path = join(root, "source"),
      output = join(root, "output");
    await writeFile(path, fixture.bytes);
    const inspect = new StructuredRasterDiscoveryService();
    const exporter = new StructuredRasterExportService();
    const color_policy = { ...policy, rgb565_color_key: key };
    try {
      if (mode === "preview") {
        const result = await inspect.inspect({
          path,
          resource_family: "record12-lut-registry",
          max_previews: 1,
          color_policy,
        });
        if (!result.ok) throw result.error;
        const report = structuredRasterCandidatesSchema.parse(
          result.value.normalized_result,
        );
        expect(report.resourceFamily?.registries[0]?.palettes).toEqual([]);
        const resource = report.tables
          .flatMap((t) => t.resources)
          .find((r) => r.descriptorOffset === fixture.table)!;
        expect(resource.preview, resource.previewUnavailable).toBeDefined();
        expect(
          firstPixel(Buffer.from(resource.preview!.pngBase64, "base64")),
        ).toEqual(key === null ? [132, 130, 132, 255] : [0, 0, 0, 0]);
        return;
      }
      const exported = await exporter.export({
        path,
        output_directory: output,
        expected_sha256: sha256Hex(fixture.bytes),
        resource_family: "record12-lut-registry",
        color_policy,
        selections: [{ descriptor_offset: fixture.table }],
      });
      if (!exported.ok) throw exported.error;
      const manifest = JSON.parse(
        await readFile(join(output, "manifest.json"), "utf8"),
      );
      expect(manifest.resources[0].files.png).toBeDefined();
      const png = await readFile(
        join(output, manifest.resources[0].files.png.relativePath),
      );
      expect(firstPixel(png)).toEqual(
        key === null ? [132, 130, 132, 255] : [0, 0, 0, 0],
      );
      expect(png.readUInt32BE(16)).toBe(17);
      expect(png.readUInt32BE(20)).toBe(3);
      expect(
        manifest.resources[0].interpretation.assumptions.join(" "),
      ).toMatch(/no palette/i);
    } finally {
      await inspect.close();
      await exporter.close();
    }
  },
);
it("still withholds indexed color previews and PNG export without an admitted palette", async () => {
  const fixture = withoutPalette(false);
  const root = await createTestTempDirectory("rea-indexed-no-palette-");
  const path = join(root, "source"),
    output = join(root, "output");
  await writeFile(path, fixture.bytes);
  const inspect = new StructuredRasterDiscoveryService(),
    exporter = new StructuredRasterExportService();
  try {
    const result = await inspect.inspect({
      path,
      resource_family: "record12-lut-registry",
      max_previews: 1,
      color_policy: policy,
    });
    if (!result.ok) throw result.error;
    const report = structuredRasterCandidatesSchema.parse(
      result.value.normalized_result,
    );
    expect(report.resourceFamily?.registries[0]?.palettes).toEqual([]);
    const resource = report.tables
      .flatMap((t) => t.resources)
      .find((r) => r.descriptorOffset === fixture.table)!;
    expect(resource.preview).toBeUndefined();
    expect(resource.previewUnavailable).toMatch(/palette/);
    const exported = await exporter.export({
      path,
      output_directory: output,
      expected_sha256: sha256Hex(fixture.bytes),
      resource_family: "record12-lut-registry",
      color_policy: policy,
      selections: [{ descriptor_offset: fixture.table }],
    });
    if (!exported.ok) throw exported.error;
    const manifest = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    );
    expect(manifest.resources[0].files.raw).toBeDefined();
    expect(manifest.resources[0].files.png).toBeUndefined();
    expect(manifest.resources[0].reason).toMatch(/palette/);
  } finally {
    await inspect.close();
    await exporter.close();
  }
});
it("returns a tagged failure for indexed colors with no covered palette", async () => {
  const layout = {
    width: 1,
    height: 1,
    layout: "indexed8" as const,
    bitsPerPixel: 8 as const,
    stride: 1,
    payloadRange: { offset: 0, length: 1 },
    rowOrder: "bottom-up" as const,
    bitOrder: "msb-first" as const,
    format: 4,
  };
  for (const paletteRange of [null, { offset: 1, length: 1024 }]) {
    const rendered = await renderRasterResource(
      new Uint8Array(1025),
      layout,
      {
        kind: policy.kind,
        themeSlot: 0,
        paletteRange,
        precision: policy.precision,
        alpha: policy.alpha,
        sentinel: policy.sentinel,
        rgb565ColorKey: null,
      },
      { coverage: [{ offset: 0, length: 1 }] },
    );
    expect(rendered).toMatchObject({
      status: "unrenderable",
      reason: expect.stringMatching(/palette/),
    });
  }
});
