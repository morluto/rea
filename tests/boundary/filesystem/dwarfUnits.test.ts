import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDwarfUnitsService } from "../../../src/composition/binaryDiagnostics.js";
import { elfImage } from "../../../src/native/dwarf/DwarfUnits.fixture.js";
import { AnalysisUnsupportedTargetError } from "../../../src/domain/analysisErrorCore.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("DWARF compile-unit stable filesystem boundary", () => {
  it("reports non-file and malformed selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-dwarf-units-files-");
    const path = join(root, "program");
    const alias = join(root, "alias");
    const malformed = join(root, "malformed");
    const foreign = join(root, "foreign");
    await writeFile(path, elfImage());
    await writeFile(malformed, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    await writeFile(foreign, Buffer.from("not an image"));
    await symlink(path, alias);
    const service = createDwarfUnitsService();
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
          operation: "inspect_dwarf_units",
          issues: [
            {
              path: ["path"],
              reason,
              message: expect.any(String),
            },
          ],
        });
      }
      const foreignResult = await service.inspect({ path: foreign });
      if (foreignResult.ok) throw new Error("Expected an unsupported file");
      expect(foreignResult.error).toBeInstanceOf(
        AnalysisUnsupportedTargetError,
      );
    } finally {
      await service.close();
    }
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-dwarf-units-budget-");
    const path = join(root, "program");
    await writeFile(path, elfImage());
    const service = createDwarfUnitsService();
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
});
