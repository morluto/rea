import { mkdir, open, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  MAX_FIRMWARE_STAGING_BYTES,
  MAX_FIRMWARE_STAGING_ENTRIES,
} from "../../../src/domain/firmware/firmwareAnalysis.js";
import { inventoryFirmwareOutput } from "../../../src/firmware/FirmwareFiles.js";
import { checkFirmwareStagingBudget } from "../../../src/firmware/FirmwareStagingBudget.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("reports the cumulative staging-byte limit and only offers supported increases", async () => {
  const root = await createTestTempDirectory("rea-firmware-ceiling-bytes-");
  // Each file fits either budget. Together they exceed even the ceiling.
  await writeFile(join(root, "first.bin"), "12");
  const sparse = await open(join(root, "second.bin"), "w");
  try {
    await sparse.truncate(MAX_FIRMWARE_STAGING_BYTES - 1);
  } finally {
    await sparse.close();
  }

  for (const [limit, adjustable] of [
    [MAX_FIRMWARE_STAGING_BYTES - 1, true],
    [MAX_FIRMWARE_STAGING_BYTES, false],
  ] as const) {
    const failure: unknown = await inventoryFirmwareOutput(
      root,
      limit,
      MAX_FIRMWARE_STAGING_ENTRIES,
      Number.MAX_SAFE_INTEGER,
      "extract_firmware",
    ).catch((cause: unknown) => cause);
    if (!(failure instanceof AnalysisResourceConstraintError))
      throw new Error("Expected a staging capacity failure", {
        cause: failure,
      });

    const projected = projectAnalysisError(failure);
    expect(projected).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      details: {
        resource: "capacity",
        reported_limits: { max_output_bytes: limit },
      },
    });
    const action = projected.remediation.action;
    expect(action).toContain(`max_output_bytes=${limit}`);
    expect(action).toContain(`maximum ${MAX_FIRMWARE_STAGING_BYTES}`);
    expect(action).toContain("analysis_timeout_ms does not raise");
    expect(action.includes("Increase max_output_bytes")).toBe(adjustable);
    expect(action).toContain(
      adjustable
        ? "narrower firmware byte range"
        : "smaller firmware byte range",
    );
  }
});

describe("checkFirmwareStagingBudget", () => {
  it("counts files, directories, symlinks, and raw non-UTF8 names within budgets", async () => {
    const root = await createTestTempDirectory("rea-staging-budget-fast-");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "a.bin"), "abcd");
    await writeFile(join(root, "b.bin"), "ef");
    if (process.platform !== "win32")
      await symlink("dangling-target", join(root, "sub", "dangling"));
    const usage = await checkFirmwareStagingBudget({
      root,
      maxBytes: 6,
      maxEntries: process.platform === "win32" ? 3 : 4,
      fileSizeBytes: 5,
      operation: "extract_firmware",
    });
    expect(usage).toEqual({
      bytes: 6,
      entries: process.platform === "win32" ? 3 : 4,
    });
    await expect(
      checkFirmwareStagingBudget({
        root,
        maxBytes: 5,
        maxEntries: 10,
        fileSizeBytes: 10,
        operation: "extract_firmware",
      }),
    ).rejects.toMatchObject({ _tag: "AnalysisResourceConstraintError" });
    await expect(
      checkFirmwareStagingBudget({
        root,
        maxBytes: 100,
        maxEntries: 10,
        fileSizeBytes: 4,
        operation: "extract_firmware",
      }),
    ).rejects.toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      resource: "file-size",
    });
  });
});
