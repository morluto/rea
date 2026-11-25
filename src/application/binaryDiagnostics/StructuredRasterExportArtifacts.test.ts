import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import { StructuredRasterExportService } from "./StructuredRasterExportService.js";
import { RasterExportPublication } from "./RasterExportPublication.js";
import { rasterPngWorkingBytes } from "./RasterResourceRenderingPng.js";
import { structuredRasterExportResultSchema } from "../../domain/native/structuredRasterExport.js";

async function source() {
  const root = await createTestTempDirectory("rea-export-budget-owners-");
  const payloads = Array.from({ length: 12 }, (_, i) =>
    Buffer.alloc(Math.ceil((128 + i) / 8) * 128),
  );
  const table = Buffer.alloc(144);
  let offset = 0;
  for (let i = 0; i < payloads.length; i++) {
    table[i * 12] = 5;
    table.writeUInt16LE(128 + i, i * 12 + 2);
    table.writeUInt16LE(128, i * 12 + 4);
    table.writeUInt32LE(offset, i * 12 + 8);
    offset += payloads[i]!.length;
  }
  const bytes = Buffer.concat([table, ...payloads]);
  const path = join(root, "source");
  await writeFile(path, bytes);
  return {
    path,
    output_directory: join(root, "output"),
    expected_sha256: sha256Hex(bytes),
    formats: ["png"],
    selections: [
      {
        descriptor_offset: 0,
        hypothesis: { bits_per_pixel: 1, offset_unit: 1 },
      },
    ],
  };
}
it("publishes a PNG that fits disk allowance even when rendering working buffers exceed it", async () => {
  const input = await source(),
    allowance = 90000;
  expect(rasterPngWorkingBytes(128, 128)).toBeGreaterThan(allowance);
  const service = new StructuredRasterExportService(
    undefined,
    undefined,
    new RasterExportPublication(undefined, allowance),
  );
  try {
    const result = await service.export(input);
    if (!result.ok) throw result.error;
    const receipt = structuredRasterExportResultSchema.parse(
      result.value.normalized_result,
    );
    expect(receipt.exported).toBe(1);
    expect(receipt.published_bytes).toBeLessThan(allowance);
    const manifest = JSON.parse(
      await readFile(join(input.output_directory, "manifest.json"), "utf8"),
    );
    const png = await readFile(
      join(
        input.output_directory,
        manifest.resources[0].files.png.relativePath,
      ),
    );
    expect(png.readUInt32BE(16)).toBe(128);
    expect(png.readUInt32BE(20)).toBe(128);
  } finally {
    await service.close();
  }
});
it("reports the aggregate disk ceiling and rolls back when encoded PNG bytes do not fit", async () => {
  const input = await source(),
    allowance = 60000;
  const service = new StructuredRasterExportService(
    undefined,
    undefined,
    new RasterExportPublication(undefined, allowance),
  );
  try {
    const result = await service.export(input);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        recovery: { fixedAllowance: { limit: allowance, unit: "bytes" } },
      });
    await expect(access(input.output_directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await service.close();
  }
});
