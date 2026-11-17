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
it("keeps container parse causes and invalid_format attribution through inspection", async () => {
  const root = await createTestTempDirectory("rea-raster-parse-"),
    path = join(root, "source");
  await writeFile(path, new Uint8Array(64));
  const service = new StructuredRasterDiscoveryService();
  try {
    const r = await service.inspect({ path, profile: "fgs-records" });
    if (r.ok) throw new Error("Expected parse failure");
    expect(r.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [{ path: ["path"], reason: "invalid_format" }],
      cause: { failure: { kind: "malformed", format: "fgs-records" } },
    });
  } finally {
    await service.close();
  }
});
it("does not flatten a logical-span decode limit into invalid input", async () => {
  const root = await createTestTempDirectory("rea-raster-limit-"),
    path = join(root, "source");
  await writeFile(path, new Uint8Array(2));
  const service = new StructuredRasterDiscoveryService();
  try {
    const r = await service.inspect({
      path,
      segments: [
        { logicalOffset: 0, fileOffset: 0, length: 1 },
        { logicalOffset: 16 * 1024 * 1024, fileOffset: 1, length: 1 },
      ],
    });
    if (r.ok) throw new Error("Expected decode limit");
    expect(r.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      resource: "capacity",
      retryable: false,
      reportedLimits: {
        boundary: "raster-logical-span-bytes",
        maximum: 16 * 1024 * 1024,
        required: 16 * 1024 * 1024 + 1,
      },
      cause: { failure: { kind: "limit" } },
    });
  } finally {
    await service.close();
  }
});
it("attributes parsed mapping defects to segments while retaining their cause", async () => {
  const root = await createTestTempDirectory("rea-raster-mapping-"),
    path = join(root, "source");
  await writeFile(path, new Uint8Array(4));
  const service = new StructuredRasterDiscoveryService();
  try {
    const r = await service.inspect({
      path,
      segments: [{ logicalOffset: 0, fileOffset: 3, length: 2 }],
    });
    if (r.ok) throw new Error("Expected mapping failure");
    expect(r.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [{ path: ["segments"], reason: "invalid_format" }],
      cause: {
        failure: { kind: "malformed", format: "raster-logical-segments" },
      },
    });
  } finally {
    await service.close();
  }
});
it("preserves parser failures through export preparation without creating output", async () => {
  const { StructuredRasterExportService } =
    await import("./StructuredRasterExportService.js");
  const { sha256Hex } = await import("../../kernel/sha256Hex.js");
  const { access } = await import("node:fs/promises");
  const root = await createTestTempDirectory("rea-raster-export-parse-"),
    path = join(root, "source"),
    output_directory = join(root, "output"),
    bytes = new Uint8Array(64);
  await writeFile(path, bytes);
  const service = new StructuredRasterExportService();
  try {
    const r = await service.export({
      path,
      profile: "fgs-records",
      expected_sha256: sha256Hex(bytes),
      output_directory,
    });
    if (r.ok) throw new Error("Expected export parser refusal");
    expect(r.error).toMatchObject({
      _tag: "AnalysisInputError",
      operation: "export_structured_raster_resources",
      cause: { failure: { kind: "malformed", format: "fgs-records" } },
    });
    await expect(access(output_directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await service.close();
  }
});
