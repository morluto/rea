import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWindowsMinidumpService } from "../../../src/composition/binaryDiagnostics.js";
import { windowsMinidumpFixture } from "../../../src/native/minidump/WindowsMinidump.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("Windows minidump stable filesystem boundary", () => {
  it("inspects a recorded file and binds Evidence to its digest", async () => {
    const root = await createTestTempDirectory("rea-minidump-files-");
    const path = join(root, "crash.dmp");
    await writeFile(path, windowsMinidumpFixture().bytes);
    const service = createWindowsMinidumpService();
    const result = await service.inspect({ path });
    await service.close();
    if (!result.ok) throw result.error;
    expect(result.value.normalized_result).toMatchObject({
      artifact: { path },
      format: "windows-minidump",
      coverage: { status: "complete" },
    });
  });

  it("reports non-file, malformed and truncated selections as input errors", async () => {
    const root = await createTestTempDirectory("rea-minidump-invalid-");
    const path = join(root, "crash.dmp");
    const alias = join(root, "alias.dmp");
    const truncated = join(root, "truncated.dmp");
    const { bytes } = windowsMinidumpFixture();
    await writeFile(path, bytes);
    await writeFile(truncated, bytes.subarray(0, 200));
    await symlink(path, alias);
    const service = createWindowsMinidumpService();
    for (const [candidate, reason] of [
      [root, "invalid_format"],
      [alias, "invalid_format"],
      [truncated, "invalid_format"],
      [join(root, "missing.dmp"), "invalid_value"],
    ] as const) {
      const result = await service.inspect({ path: candidate });
      if (result.ok) throw new Error("Expected acquisition failure");
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        operation: "inspect_windows_minidump",
        issues: [{ path: ["path"], reason }],
      });
    }
  });

  it("returns typed budget and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-minidump-budget-");
    const path = join(root, "crash.dmp");
    await writeFile(path, windowsMinidumpFixture().bytes);
    const service = createWindowsMinidumpService();
    for (const [input, resource, setting] of [
      [{ path, max_file_bytes: 64 }, "file-size", /max_file_bytes above 64/],
      [{ path, max_entries: 2 }, "capacity", /max_entries above 2/],
    ] as const) {
      const result = await service.inspect(input);
      if (result.ok) throw new Error("Expected budget failure");
      expect(result.error).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        resource,
        remediationAction: expect.stringMatching(setting),
      });
    }
    const result = await service.inspect(
      { path },
      { signal: AbortSignal.abort() },
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
  });
});
