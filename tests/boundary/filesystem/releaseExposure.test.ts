import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import { describe, expect, it } from "vitest";

import { createReleaseExposureService } from "../../../src/composition/releaseExposure.js";
import { releaseExposureReportSchema } from "../../../src/domain/releaseExposure.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("release exposure filesystem boundary", () => {
  it("retains unknown JavaScript coverage for an external-section bundle.map", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-map-");
    await writeFile(
      join(root, "bundle.map"),
      JSON.stringify({
        version: 3,
        sections: [{ offset: { line: 0, column: 0 }, url: "external.map" }],
      }),
    );
    const service = createReleaseExposureService();
    try {
      const result = await service.inspect({ path: root });
      if (!result.ok) throw new Error(result.error.message);
      const report = releaseExposureReportSchema.parse(
        result.value.normalized_result,
      );
      for (const id of [
        "javascript.source_maps",
        "javascript.source_map_sources",
      ])
        expect(report.checks.find((check) => check.id === id)?.status).toBe(
          "unknown",
        );
      expect(
        report.checks.find((check) => check.id === "native.debug_companions")
          ?.status,
      ).toBe("not_observed");
    } finally {
      await service.close();
    }
  });

  it("audits an ASAR whose unpacked module was signed after packaging", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-signed-");
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "native.node"), "packaged module");
    const archive = join(root, "app.asar");
    await createPackageWithOptions(source, archive, { unpack: "*.node" });
    await writeFile(
      join(`${archive}.unpacked`, "native.node"),
      "signed module",
    );
    const service = createReleaseExposureService();
    try {
      const result = await service.inspect({ path: archive });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.limitations.join("\n")).toContain(
        "integrity contradiction",
      );
      expect(
        releaseExposureReportSchema
          .parse(result.value.normalized_result)
          .checks.find((check) => check.id === "packaging.extractable_payload")
          ?.status,
      ).toBe("exposed");
    } finally {
      await service.close();
    }
  });

  it("rejects a missing path and a symlink", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-files-");
    const path = join(root, "hello.txt");
    const alias = join(root, "alias.txt");
    await writeFile(path, "hello\n");
    await symlink(path, alias);
    const service = createReleaseExposureService();
    try {
      for (const [candidate, reason] of [
        [alias, "invalid_format"],
        [join(root, "missing.txt"), "invalid_value"],
      ] as const) {
        const result = await service.inspect({ path: candidate });
        if (result.ok) throw new Error("Expected file acquisition failure");
        expect(result.error).toMatchObject({
          _tag: "AnalysisInputError",
          operation: "audit_release_exposure",
          issues: [{ path: ["path"], reason, message: expect.any(String) }],
        });
      }
    } finally {
      await service.close();
    }
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-budget-");
    const path = join(root, "blob.bin");
    await writeFile(path, Buffer.alloc(128, 1));
    const service = createReleaseExposureService();
    try {
      const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
      if (tooSmall.ok) throw new Error("Expected resource budget failure");
      expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
      const cancelled = await service.inspect(
        { path },
        { signal: AbortSignal.abort() },
      );
      if (cancelled.ok) throw new Error("Expected cancellation");
      expect(cancelled.error._tag).toBe("AnalysisCancelledError");
    } finally {
      await service.close();
    }
  });

  it("reads a directory of plain text", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-dir-");
    await writeFile(join(root, "hello.txt"), "hello\n");
    const service = createReleaseExposureService();
    try {
      const result = await service.inspect({ path: root });
      if (!result.ok) throw new Error(result.error.message);
      const report = result.value.normalized_result as {
        summary: {
          no_exposure_observed_in_assessed_checks: boolean;
          by_status: { not_assessed: number };
        };
      };
      expect(report.summary.no_exposure_observed_in_assessed_checks).toBe(true);
      expect(report.summary.by_status.not_assessed).toBe(3);
    } finally {
      await service.close();
    }
  });
});
