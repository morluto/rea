import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { registryFixture } from "../../../tests/fixtures/rasterRegistry.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import { StructuredRasterExportService } from "./StructuredRasterExportService.js";

it("publishes all skipped family registry alternatives as evidence without exporting payload files", async () => {
  const root = await createTestTempDirectory("rea-skipped-alternatives-"),
    f = registryFixture(),
    second = 11520,
    v = new DataView(f.bytes.buffer);
  // Independent second registry references the same descriptors with a different lookup.
  for (let i = 0; i < 7; i++)
    v.setUint32(second + i * 4, v.getUint32(f.start + i * 4, true), true);
  v.setUint32(second + 4, f.lookup + 4 + f.bias, true);
  v.setUint16(f.lookup + 8, 2, true);
  v.setUint16(f.lookup + 10, 3, true);
  const path = join(root, "source"),
    output_directory = join(root, "output");
  await writeFile(path, f.bytes);
  const service = new StructuredRasterExportService();
  try {
    const result = await service.export({
      path,
      output_directory,
      expected_sha256: sha256Hex(f.bytes),
      resource_family: "record12-lut-registry",
      ambiguity: "skip",
      color_policy: {
        kind: "record12-lut-registry",
        theme_slot: 0,
        precision: "byte8",
        alpha: "palette",
        sentinel: "profile",
        rgb565_color_key: null,
      },
      segments: [
        { logicalOffset: 1000, fileOffset: 0, length: f.bytes.length },
      ],
    });
    if (!result.ok) throw result.error;
    const manifest = JSON.parse(
      await readFile(join(output_directory, "manifest.json"), "utf8"),
    );
    const outcome = manifest.resources.find(
      (r: { descriptor_offset: number }) =>
        r.descriptor_offset === f.table + 1000,
    );
    expect(outcome).toMatchObject({
      status: "skipped",
      files: {},
      alternatives: [
        {
          provenance: "profile-declared",
          hypothesis: { bits_per_pixel: 1, offset_unit: 1 },
          registry: {
            range: { offset: f.start + 1000, complete: true },
            pointer_bias: f.bias - 1000,
          },
          lookup: { offset: f.lookup + 1000, complete: true },
          palette: { offset: f.palettes[0]! + 1000, complete: true },
          payload: { offset: f.table + 120 + 1000, complete: true },
        },
        {
          provenance: "profile-declared",
          hypothesis: { bits_per_pixel: 1, offset_unit: 1 },
          registry: {
            range: { offset: second + 1000, complete: true },
            pointer_bias: f.bias - 1000,
          },
          lookup: { offset: f.lookup + 4 + 1000, complete: true },
          payload: { offset: f.table + 120 + 1000, complete: true },
        },
      ],
    });
    expect(outcome.alternatives).toHaveLength(2);
    expect(await readdir(output_directory)).toEqual([
      "manifest.json",
      "segments.jsonl",
    ]);
  } finally {
    await service.close();
  }
});

it("publishes generic skipped hypotheses and their consistency evidence in the manifest", async () => {
  const root = await createTestTempDirectory("rea-skipped-generic-"),
    table = Buffer.alloc(120),
    payload = Buffer.alloc(640, 0x69);
  for (let i = 0; i < 10; i++) {
    table[i * 12] = 5;
    table.writeUInt16LE(8, i * 12 + 2);
    table.writeUInt16LE(8, i * 12 + 4);
    table.writeUInt32LE(i * 16, i * 12 + 8);
  }
  const bytes = Buffer.concat([table, payload]),
    path = join(root, "source"),
    output_directory = join(root, "output");
  await writeFile(path, bytes);
  const service = new StructuredRasterExportService();
  try {
    const result = await service.export({
      path,
      output_directory,
      expected_sha256: sha256Hex(bytes),
    });
    if (!result.ok) throw result.error;
    const manifest = JSON.parse(
      await readFile(join(output_directory, "manifest.json"), "utf8"),
    );
    expect(manifest.resources).toHaveLength(10);
    expect(manifest.resources[0]).toMatchObject({
      status: "skipped",
      files: {},
      alternatives: [
        {
          hypothesis: { bits_per_pixel: 2, offset_unit: 1 },
          payload: { offset: 120, length: 16, complete: true },
          provenance: "inferred",
          evidence: { matches: 9, consistency: 1, stride: 2, covered: true },
        },
        {
          hypothesis: { bits_per_pixel: 4, offset_unit: 2 },
          payload: { offset: 120, length: 32, complete: true },
          provenance: "inferred",
          evidence: { matches: 9, consistency: 1, stride: 4, covered: true },
        },
        {
          hypothesis: { bits_per_pixel: 8, offset_unit: 4 },
          payload: { offset: 120, length: 64, complete: true },
          provenance: "inferred",
          evidence: { matches: 9, consistency: 1, stride: 8, covered: true },
        },
      ],
    });
    expect(await readdir(output_directory)).toEqual([
      "manifest.json",
      "segments.jsonl",
    ]);
  } finally {
    await service.close();
  }
});
