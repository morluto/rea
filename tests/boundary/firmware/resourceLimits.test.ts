import { access } from "node:fs/promises";
import { expect, it } from "vitest";
import { firmwareResultSchemas } from "../../../src/domain/firmware/firmwareAnalysis.js";
import { FIRMWARE_LIMITS } from "../../../src/firmware/FirmwareRelease.js";
import { firmwareFileSizeService } from "../../fixtures/firmware/fileSizeProducer.js";
import { assertFirmwareCleanup } from "../../fixtures/firmware/provider.js";

const linux = it.skipIf(process.platform !== "linux");
const budget = 16 * 1024 * 1024;
const limits = {
  probeFileBytes: FIRMWARE_LIMITS.reportBytes + 1,
  extractionFileBytes: budget + 1,
};

linux("publishes a staged file of exactly the staging budget", async () => {
  const fixture = await firmwareFileSizeService({
    ...limits,
    attemptedBytes: budget,
  });
  const outcome = await fixture.service.execute("extract_firmware", {
    path: fixture.path,
    output_directory: fixture.output,
    max_output_bytes: budget,
  });
  if (!outcome.ok) throw outcome.error;
  const result = firmwareResultSchemas.extract_firmware.parse(
    outcome.value.normalized_result,
  );
  expect(result.files).toEqual([
    expect.objectContaining({ relative_path: "rootfs/config", size: budget }),
  ]);
  await assertFirmwareCleanup(fixture.launches);
});

linux(
  "rejects a staged file the kernel stops at the per-file limit",
  async () => {
    const fixture = await firmwareFileSizeService({
      ...limits,
      attemptedBytes: budget + 4096,
    });
    const outcome = await fixture.service.execute("extract_firmware", {
      path: fixture.path,
      output_directory: fixture.output,
      max_output_bytes: budget,
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        resource: "capacity",
        reportedLimits: { max_output_bytes: budget },
      },
    });
    await expect(access(fixture.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assertFirmwareCleanup(fixture.launches);
  },
);
