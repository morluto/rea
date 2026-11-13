import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKernelBuildConfigService } from "../../../src/composition/binaryDiagnostics.js";
import {
  kernelBuildConfigFixture,
  plainIkcfgStringFixture,
} from "../../../src/native/elf/KernelBuildConfig.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("kernel build config stable filesystem boundary", () => {
  it("reports non-file selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-kernel-config-files-");
    const path = join(root, "vmlinux");
    const alias = join(root, "alias");
    await writeFile(path, kernelBuildConfigFixture());
    await symlink(path, alias);
    const service = createKernelBuildConfigService();
    try {
      for (const [candidate, reason] of [
        [root, "invalid_format"],
        [alias, "invalid_format"],
        [join(root, "missing"), "invalid_value"],
        [join(path, "child"), "invalid_value"],
      ] as const) {
        const result = await service.inspect({ path: candidate });
        if (result.ok) throw new Error("Expected file acquisition failure");
        expect(result.error).toMatchObject({
          _tag: "AnalysisInputError",
          operation: "inspect_kernel_build_config",
          issues: [{ path: ["path"], reason, message: expect.any(String) }],
        });
      }
    } finally {
      await service.close();
    }
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-kernel-config-budget-");
    const path = join(root, "vmlinux");
    await writeFile(path, kernelBuildConfigFixture());
    const service = createKernelBuildConfigService();
    try {
      const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
      if (tooSmall.ok) throw new Error("Expected resource budget failure");
      expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
      const tooMany = await service.inspect({ path, max_entries: 1 });
      if (tooMany.ok) throw new Error("Expected entry budget failure");
      expect(tooMany.error).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        remediationAction: expect.stringContaining("max_entries"),
      });
      const inflated = await service.inspect({ path, max_config_bytes: 64 });
      if (inflated.ok) throw new Error("Expected config budget failure");
      expect(inflated.error).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        remediationAction: expect.stringContaining(
          "Raise max_config_bytes above 64",
        ),
      });
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

  it("reports an ordinary IKCFG_ST string as no config with file Evidence", async () => {
    const root = await createTestTempDirectory("rea-kernel-config-plain-");
    const path = join(root, "vmlinux");
    await writeFile(path, plainIkcfgStringFixture());
    const service = createKernelBuildConfigService();
    try {
      const result = await service.inspect({ path });
      if (!result.ok) throw result.error;
      expect(result.value.subject?.format).toBe("elf");
      expect(result.value.normalized_result).toMatchObject({
        banner: { status: "present", version: "6.6.0" },
        config: { status: "absent", entries: [] },
        coverage: { status: "complete" },
      });
    } finally {
      await service.close();
    }
  });
});
