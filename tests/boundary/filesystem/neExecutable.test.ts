import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNeExecutableService } from "../../../src/composition/binaryDiagnostics/neExecutable.js";
import { neFixture } from "../../../src/native/ne/NeExecutable.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { expectFileSelectionErrors } from "../../support/expectFileSelectionErrors.js";

describe("NE executable stable filesystem boundary", () => {
  it("reports non-file and missing selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-ne-files-");
    const path = join(root, "sample.dll");
    const alias = join(root, "alias.dll");
    await writeFile(path, neFixture().bytes);
    await symlink(path, alias);
    await expectFileSelectionErrors(
      createNeExecutableService(),
      "inspect_ne_executable",
      { root, alias, path },
      ".dll",
    );
  });

  it("refuses non-NE bytes as a malformed target", async () => {
    const root = await createTestTempDirectory("rea-ne-malformed-");
    const path = join(root, "malformed.dll");
    await writeFile(path, Buffer.from("not an NE image"));
    const result = await createNeExecutableService().inspect({ path });
    if (result.ok) throw new Error("Expected malformed target");
    expect(result.error).toMatchObject({
      _tag: "AnalysisMalformedTargetError",
      operation: "inspect_ne_executable",
    });
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-ne-budget-");
    const path = join(root, "sample.dll");
    await writeFile(path, neFixture().bytes);
    const service = createNeExecutableService();
    for (const [input, boundary] of [
      [{ path, max_file_bytes: 64 }, "file-size"],
      [{ path, max_rows: 1 }, "capacity"],
    ] as const) {
      const result = await service.inspect(input);
      if (result.ok) throw new Error("Expected budget failure");
      expect(result.error).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        resource: boundary,
        retryable: false,
      });
    }
    const result = await service.inspect(
      { path },
      { signal: AbortSignal.abort() },
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
  });

  it("returns complete Evidence for a stable NE file", async () => {
    const root = await createTestTempDirectory("rea-ne-complete-");
    const path = join(root, "sample.dll");
    const fixture = neFixture();
    await writeFile(path, fixture.bytes);
    const result = await createNeExecutableService().inspect({ path });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.normalized_result).toMatchObject({
      artifact: { path, bytes: fixture.bytes.length },
      module_name: { name: "SAMPLE" },
      coverage: { status: "complete", examined_rows: 13 },
    });
  });
});
