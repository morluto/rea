import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPeRichHeaderService } from "../../../src/composition/binaryDiagnostics.js";
import { peRichHeaderImage } from "../../../src/native/pe/PeRichHeader.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("PE Rich header stable filesystem boundary", () => {
  it("reports non-file and malformed PE selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-pe-rich-files-");
    const path = join(root, "app.exe");
    const alias = join(root, "alias.exe");
    const malformed = join(root, "malformed.exe");
    await writeFile(path, peRichHeaderImage());
    await writeFile(malformed, Buffer.from("not a pe"));
    await symlink(path, alias);
    const service = createPeRichHeaderService();
    for (const [candidate, reason] of [
      [root, "invalid_format"],
      [alias, "invalid_format"],
      [malformed, "invalid_format"],
      [join(root, "missing.exe"), "invalid_value"],
      [join(path, "child.exe"), "invalid_value"],
    ] as const) {
      const result = await service.inspect({ path: candidate });
      if (result.ok) throw new Error("Expected file acquisition failure");
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        operation: "inspect_pe_rich_header",
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
    const root = await createTestTempDirectory("rea-pe-rich-budget-");
    const path = join(root, "app.exe");
    await writeFile(path, peRichHeaderImage());
    const service = createPeRichHeaderService();
    const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
    if (tooSmall.ok) throw new Error("Expected file-size failure");
    expect(tooSmall.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      resource: "file-size",
    });
    const entries = await service.inspect({ path, max_entries: 2 });
    if (entries.ok) throw new Error("Expected entry budget failure");
    expect(entries.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      resource: "capacity",
      recovery: { retryable: false },
    });
    const cancelled = await service.inspect(
      { path },
      { signal: AbortSignal.abort() },
    );
    if (cancelled.ok) throw new Error("Expected cancellation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  });
});
