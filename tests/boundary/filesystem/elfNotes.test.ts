import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createElfNotesService } from "../../../src/composition/binaryDiagnostics/elfNotes.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { elfNoteFixture } from "../../../src/native/elf/ElfNotes.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("ELF note stable filesystem boundary", () => {
  it("reports non-file and missing selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-elf-notes-files-");
    const path = join(root, "program");
    const alias = join(root, "alias");
    await writeFile(path, elfNoteFixture());
    await symlink(path, alias);
    const service = createElfNotesService();
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
        operation: "inspect_elf_notes",
        issues: [
          {
            path: ["path"],
            reason,
            message: expect.any(String),
          },
        ],
      });
    }
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-elf-notes-budget-");
    const path = join(root, "program");
    await writeFile(path, elfNoteFixture());
    const service = createElfNotesService();
    const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
    if (tooSmall.ok) throw new Error("Expected resource budget failure");
    expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
    // The refusal names the per-call control that stopped it, so a caller
    // can raise it without parsing the remediation text.
    expect(projectAnalysisError(tooSmall.error).details).toMatchObject({
      limit: {
        control_kind: "parameter",
        parameter: "max_file_bytes",
        effective_value: 64,
        unit: "bytes",
        minimum: 64,
        maximum: 536870912,
        default_value: 67108864,
        applies_at: "next_call",
      },
    });
    const fewEntries = await service.inspect({ path, max_entries: 1 });
    if (fewEntries.ok) throw new Error("Expected note entry budget failure");
    expect(projectAnalysisError(fewEntries.error).details).toMatchObject({
      limit: {
        control_kind: "parameter",
        parameter: "max_entries",
        effective_value: 1,
        unit: "count",
        minimum: 1,
        maximum: 256,
        default_value: 128,
        applies_at: "next_call",
      },
    });
    // Both controls admit the same file once raised.
    expect((await service.inspect({ path, max_entries: 256 })).ok).toBe(true);
    const cancelled = await service.inspect(
      { path },
      { signal: AbortSignal.abort() },
    );
    if (cancelled.ok) throw new Error("Expected cancellation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  });
});
