import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { writeOutputTree } from "./DesktopOutputTree.js";

describe("writeOutputTree", () => {
  it("refuses an output destination whose parent path contains a regular file", async () => {
    const root = await createTestTempDirectory("desktop-output-parent-file-");
    const occupied = join(root, "parentfile");
    await writeFile(occupied, "keep\n");
    for (const directory of [
      join(occupied, "bundle"),
      join(occupied, "missing", "bundle"),
    ]) {
      await expect(
        writeOutputTree(
          directory,
          async () => {},
          { operation: "export_desktop_application", field: "directory" },
          undefined,
        ),
      ).rejects.toMatchObject({
        _tag: "AnalysisInputError",
        operation: "export_desktop_application",
        issues: [{ path: ["directory"], reason: "invalid_value" }],
      });
    }
  });
});
