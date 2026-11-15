import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBinaryHardeningService } from "../../../src/composition/binaryDiagnostics.js";
import { elfHardeningFixture } from "../../../src/native/hardening/BinaryHardening.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("binary hardening stable filesystem boundary", () => {
  it("reports non-file, missing and malformed selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-binary-hardening-files-");
    const path = join(root, "app");
    const alias = join(root, "alias");
    const malformed = join(root, "malformed");
    const bytes = elfHardeningFixture();
    await writeFile(path, bytes);
    await writeFile(malformed, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]));
    await symlink(path, alias);
    const service = createBinaryHardeningService();
    try {
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
          operation: "inspect_binary_hardening",
          issues: [{ path: ["path"], reason, message: expect.any(String) }],
        });
      }
      const foreign = join(root, "foreign");
      await writeFile(foreign, Buffer.from("not a binary"));
      const unsupported = await service.inspect({ path: foreign });
      if (unsupported.ok) throw new Error("Expected an unsupported target");
      expect(unsupported.error._tag).toBe("AnalysisUnsupportedTargetError");
    } finally {
      await service.close();
    }
  });

  it("returns typed resource and cancellation failures and leaves bytes unchanged", async () => {
    const root = await createTestTempDirectory("rea-binary-hardening-budget-");
    const path = join(root, "app");
    const bytes = elfHardeningFixture();
    await writeFile(path, bytes);
    const service = createBinaryHardeningService();
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
      const result = await service.inspect({ path });
      if (!result.ok) throw result.error;
      expect(result.value.normalized_result).toMatchObject({
        format: "elf",
        images: [{ status: "parsed", architecture: "x86_64" }],
      });
      expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
    } finally {
      await service.close();
    }
  });
});
