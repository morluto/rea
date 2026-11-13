import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { peImportHintBoundaryImage } from "../fixtures/binaryDiagnostics/peImports.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest, runFileCli } from "../support/cli/cliFixture.js";

const cases = ([32, 64] as const).flatMap((bits) =>
  (["standard", "delay"] as const).flatMap((kind) =>
    (["none", "hint", "name"] as const).map((gap) => ({ bits, kind, gap })),
  ),
);

cliTest.for(cases)(
  "reads a PE$bits $kind hint/name section boundary only with both fields mapped (gap: $gap)",
  async ({ bits, kind, gap }, { cli }) => {
    const root = await createTestTempDirectory("rea-pe-hint-boundary-");
    const path = join(root, "imports.dll");
    const bytes = peImportHintBoundaryImage(bits, kind, gap);
    await writeFile(path, bytes);
    const response = await runFileCli(cli, {
      arguments: ["inspect-pe-imports", path, "--json"],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const report = toolContract("inspect_pe_imports").outputSchema.parse(
      response.json,
    ).normalized_result;
    expect(report.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(report.bits).toBe(bits);
    const rows = kind === "standard" ? report.imports : report.delay_imports;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("KERNEL32.dll");
    if (gap === "none") {
      expect(rows[0]?.functions).toEqual([
        expect.objectContaining({
          name: "GetProcAddress",
          hint: 7,
          ordinal: null,
          thunk_hex: "1ffe",
        }),
      ]);
      expect(report.coverage.status).toBe("complete");
      expect(report.issues).toEqual([]);
    } else {
      expect(rows[0]?.functions).toEqual([]);
      expect(report.coverage.status).toBe("partial");
      expect(report.issues).toContainEqual(
        expect.objectContaining({
          code: "name_unreadable",
          location: "0x1ffe",
        }),
      );
    }
    // Independently decoded with pefile 2024.8.26 on these same fixture bytes.
    expect(report.imphash.md5).toBe(
      gap === "none" && kind === "standard"
        ? "7a7803027531302026dedc7b5f6025f2"
        : null,
    );
  },
);
