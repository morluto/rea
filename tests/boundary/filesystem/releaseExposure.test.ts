import { mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import { describe, expect, it } from "vitest";

import {
  buildDenoSection,
  denoElf,
} from "../../../src/artifacts/deno/DenoStandalone.fixture.js";

import { createReleaseExposureService } from "../../../src/composition/releaseExposure.js";
import { DEFAULT_ASAR_MAX_HEADER_BYTES } from "../../../src/domain/analysisResourceLimits.js";
import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import { releaseExposureReportSchema } from "../../../src/domain/releaseExposure.js";
import { prependAsarJsonWhitespace } from "../../fixtures/asarHeader.js";
import { thinFuseImage } from "../../fixtures/electron/fuseImage.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("release exposure Deno filesystem boundary", () => {
  it.each(["vfs", "remote"] as const)(
    "audits Deno %s source maps using their retained roles",
    async (kind) => {
      const root = await createTestTempDirectory("rea-release-exposure-deno-");
      const path = join(root, "application");
      const script = Buffer.from("export const value = 1;\n");
      const map = Buffer.from(
        JSON.stringify({
          version: 3,
          sources: ["private.ts"],
          sourcesContent: ["export const value: number = 1;"],
          names: [],
          mappings: "AAAA",
        }),
      );
      await writeFile(
        path,
        denoElf(
          buildDenoSection(
            kind === "remote"
              ? {
                  specifiers: [{ text: "https://example.com/module", id: 1 }],
                  remoteModules: [
                    {
                      specifierId: 1,
                      mediaType: 0,
                      data: `export const value = 1;\n//# sourceMappingURL=data:application/json;base64,${map.toString("base64")}`,
                    },
                  ],
                }
              : {
                  vfs: [
                    {
                      File: {
                        n: "main.ts",
                        o: [0, script.length],
                        s: [script.length, map.length],
                        u: true,
                      },
                    },
                  ],
                  vfsFileData: Buffer.concat([script, map]),
                },
          ),
        ),
      );
      const service = createReleaseExposureService();
      try {
        const result = await service.inspect({ path });
        if (!result.ok) throw result.error;
        const report = releaseExposureReportSchema.parse(
          result.value.normalized_result,
        );
        expect(
          report.checks.find(
            (check) => check.id === "javascript.source_map_sources",
          )?.status,
        ).toBe("exposed");
      } finally {
        await service.close();
      }
    },
  );
});

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
      if (!result.ok) throw result.error;
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
      if (!result.ok) throw result.error;
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
      if (!result.ok) throw result.error;
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

describe("release exposure app bundle boundary", () => {
  it("reports a sidecar's RunAsNode fuse in an app bundle with safe outer fuses", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-app-");
    const app = join(root, "Sample.app");
    const framework = join(
      app,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
    );
    const resources = join(app, "Contents", "Resources");
    await mkdir(framework, { recursive: true });
    await mkdir(resources, { recursive: true });
    const disabled = 0x30;
    const enabled = 0x31;
    await writeFile(
      join(framework, "Electron Framework"),
      thinFuseImage(Array.from({ length: 6 }, () => disabled)).bytes,
    );
    const sidecar = join(resources, "sidecar");
    await writeFile(
      sidecar,
      thinFuseImage([enabled, disabled, disabled, disabled, disabled, disabled])
        .bytes,
    );
    const service = createReleaseExposureService();
    try {
      const result = await service.inspect({ path: app });
      if (!result.ok) throw result.error;
      const check = releaseExposureReportSchema
        .parse(result.value.normalized_result)
        .checks.find((item) => item.id === "electron.run_as_node");
      expect(check?.status).toBe("exposed");
      expect(JSON.stringify(check?.locations)).toContain("sidecar");
    } finally {
      await service.close();
    }
  });
});

describe("release exposure ASAR header admission", () => {
  it("keeps a directory ASAR's header admission instead of the file-size ceiling", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-header-");
    const archive = join(root, "app.asar");
    const headerBytes = DEFAULT_ASAR_MAX_HEADER_BYTES + 4;
    const json = Buffer.from("{}");
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(headerBytes, 4);
    prefix.writeUInt32LE(headerBytes - 4, 8);
    prefix.writeUInt32LE(json.length, 12);
    await writeFile(archive, Buffer.concat([prefix, json]));
    // Declare the extent without allocating a header-sized buffer.
    await truncate(archive, headerBytes + 8);
    const service = createReleaseExposureService({});
    try {
      const result = await service.inspect({ path: root });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const error = result.error;
      expect(error).toBeInstanceOf(AnalysisResourceConstraintError);
      if (!(error instanceof AnalysisResourceConstraintError)) return;
      expect(error.resource).not.toBe("file-size");
      expect(error.reportedLimits).not.toHaveProperty("max_file_bytes");
      expect(error.reportedLimits).toMatchObject({
        asar_max_header_bytes: DEFAULT_ASAR_MAX_HEADER_BYTES,
        required_header_bytes: headerBytes,
      });
      expect(error.reason).toContain("ASAR header/index");
      expect(error.fixedAllowance).toBeUndefined();
      expect(error.remediationAction).toContain("asar.max_header_bytes");
      expect(error.limit).toMatchObject({
        setting: "asar.max_header_bytes",
        effective_value: DEFAULT_ASAR_MAX_HEADER_BYTES,
        source: "default",
      });
    } finally {
      await service.close();
    }
  });

  it("reads a 20 MiB header under a 32 MiB setting and refuses it under a lower caller limit", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-wide-");
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "main.js"), "console.log('app');\n");
    const install = join(root, "install");
    await mkdir(install);
    const archive = join(install, "app.asar");
    await createPackageWithOptions(source, archive, {});
    await prependAsarJsonWhitespace(archive, " ".repeat(20 * 1024 * 1024));
    const environment = {
      REA_ASAR_MAX_HEADER_BYTES: String(32 * 1024 * 1024),
    };

    const admitted = createReleaseExposureService(environment);
    try {
      const result = await admitted.inspect({ path: install });
      if (!result.ok) throw result.error;
      expect(
        releaseExposureReportSchema
          .parse(result.value.normalized_result)
          .checks.find((check) => check.id === "packaging.extractable_payload")
          ?.status,
      ).toBe("exposed");
    } finally {
      await admitted.close();
    }

    const lowered = createReleaseExposureService(environment, () => ({
      revision: 1,
      overrides: { "asar.max_header_bytes": DEFAULT_ASAR_MAX_HEADER_BYTES },
    }));
    try {
      const result = await lowered.inspect({ path: install });
      if (result.ok) throw new Error("Expected ASAR header admission refusal");
      const error = result.error;
      expect(error).toBeInstanceOf(AnalysisResourceConstraintError);
      if (!(error instanceof AnalysisResourceConstraintError)) return;
      expect(error.reportedLimits).toMatchObject({
        asar_max_header_bytes: DEFAULT_ASAR_MAX_HEADER_BYTES,
      });
      expect(error.limit).toMatchObject({
        setting: "asar.max_header_bytes",
        effective_value: DEFAULT_ASAR_MAX_HEADER_BYTES,
        source: "runtime",
      });
    } finally {
      await lowered.close();
    }
  }, 60_000);
});
