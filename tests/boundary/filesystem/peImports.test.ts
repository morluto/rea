import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { peImportsSchema } from "../../../src/domain/native/peImports.js";
import { createPeImportsService } from "../../../src/composition/binaryDiagnostics/peImports.js";
import { peImportImage } from "../../fixtures/binaryDiagnostics/peImports.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { expectFileSelectionErrors } from "../../support/expectFileSelectionErrors.js";

describe("PE import stable filesystem boundary", () => {
  it("reports non-file and missing selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-pe-imports-files-");
    const path = join(root, "app.exe");
    const alias = join(root, "alias.exe");
    await writeFile(path, peImportImage());
    await symlink(path, alias);
    const service = createPeImportsService();
    await expectFileSelectionErrors(
      service,
      "inspect_pe_imports",
      { root, alias, path },
      ".exe",
    );
  });

  it("retains partial Evidence for an import name beyond the read allowance", async () => {
    const root = await createTestTempDirectory("rea-pe-imports-name-limit-");
    const path = join(root, "app.exe");
    await writeFile(
      path,
      peImportImage({
        sectionBytes: 8192,
        dlls: [{ name: "n".repeat(4097), functions: [] }],
      }),
    );
    const result = await createPeImportsService().inspect({ path });
    if (!result.ok) throw result.error;
    const report = peImportsSchema.parse(result.value.normalized_result);
    expect(report.coverage.status).toBe("partial");
    expect(report.imports[0]?.name).toBeNull();
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "name_unreadable",
        message: expect.stringContaining("4096-byte read allowance"),
      }),
    );
    expect(result.value.subject?.local_path).toBe(path);
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-pe-imports-budget-");
    const path = join(root, "app.exe");
    await writeFile(path, peImportImage());
    const service = createPeImportsService();
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

  it("derives limit recovery from the parser's structured limit tag", async () => {
    const root = await createTestTempDirectory("rea-pe-imports-limits-");
    const twoDlls = join(root, "two.exe");
    const longNames = join(root, "names.exe");
    await writeFile(
      twoDlls,
      peImportImage({
        dlls: [
          { name: "A.dll", functions: [{ name: "a" }] },
          { name: "B.dll", functions: [{ name: "b" }] },
        ],
      }),
    );
    const name = "A".repeat(4096);
    await writeFile(
      longNames,
      peImportImage({
        sectionBytes: 0x1200000,
        dlls: [
          {
            name: "KERNEL32.dll",
            functions: Array.from({ length: 4097 }, () => ({ name })),
          },
        ],
      }),
    );
    const service = createPeImportsService();
    const dlls = await service.inspect({ path: twoDlls, max_dlls: 1 });
    if (dlls.ok) throw new Error("Expected DLL budget failure");
    expect(dlls.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      reportedLimits: { boundary: "dlls", maximum: 1 },
      limit: {
        control_kind: "parameter",
        parameter: "max_dlls",
        effective_value: 1,
        default_value: 256,
      },
      retryable: false,
    });
    const text = await service.inspect({
      path: longNames,
      max_file_bytes: 536870912,
    });
    if (text.ok) throw new Error("Expected retained-text failure");
    expect(text.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      reportedLimits: { boundary: "retained_text", maximum: 16777216 },
      limit: {
        control_kind: "parameter",
        parameter: "max_text_bytes",
        effective_value: 16777216,
        unit: "bytes",
      },
      retryable: false,
    });
    const raisedText = await service.inspect({
      path: longNames,
      max_file_bytes: 536870912,
      max_text_bytes: 64 * 1024 * 1024,
    });
    if (!raisedText.ok) throw raisedText.error;
    const raisedReport = peImportsSchema.parse(
      raisedText.value.normalized_result,
    );
    expect(raisedReport.imports[0]?.functions).toHaveLength(4097);
  });
});
