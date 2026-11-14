import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNativeInitializersService } from "../../../src/composition/binaryDiagnostics.js";
import { elf64PieInitializers } from "../../../src/native/initializers/NativeInitializers.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("native initializer stable filesystem boundary", () => {
  it("reports non-file and malformed selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-native-init-files-");
    const path = join(root, "program");
    const alias = join(root, "alias");
    const malformed = join(root, "malformed");
    await writeFile(path, elf64PieInitializers());
    await writeFile(malformed, Buffer.from("not an executable image"));
    await symlink(path, alias);
    const service = createNativeInitializersService();
    for (const [candidate, reason] of [
      [root, "invalid_format"],
      [alias, "invalid_format"],
      [malformed, "invalid_format"],
      [join(root, "missing"), "invalid_value"],
      [join(path, "child"), "invalid_value"],
    ] as const) {
      const result = await service.inspect({ path: candidate });
      if (result.ok) throw new Error("Expected file acquisition failure");
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        operation: "inspect_native_initializers",
        issues: [{ path: ["path"], reason, message: expect.any(String) }],
      });
    }
  });

  it("reads a stable file and returns typed budget and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-native-init-budget-");
    const path = join(root, "program");
    await writeFile(path, elf64PieInitializers());
    const service = createNativeInitializersService();
    const read = await service.inspect({ path });
    if (!read.ok) throw read.error;
    expect(read.value).toMatchObject({
      operation: "inspect_native_initializers",
      provider: { id: "rea-native-initializers" },
      normalized_result: { format: "elf", status: "parsed" },
    });
    const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
    if (tooSmall.ok) throw new Error("Expected resource budget failure");
    expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
    const cancelled = await service.inspect(
      { path },
      { signal: AbortSignal.abort() },
    );
    if (cancelled.ok) throw new Error("Expected cancellation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  });
});
