import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPythonPycService } from "../../../src/composition/pythonPyc.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { pythonPycFixture } from "../../../src/python/PythonPyc.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { expectFileSelectionErrors } from "../../support/expectFileSelectionErrors.js";

describe("Python pyc stable filesystem boundary", () => {
  it("reports non-file and missing selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-python-pyc-files-");
    const path = join(root, "sample.pyc");
    const alias = join(root, "alias.pyc");
    await writeFile(path, pythonPycFixture());
    await symlink(path, alias);
    const service = createPythonPycService();
    await expectFileSelectionErrors(
      service,
      "inspect_python_pyc",
      { root, alias, path },
      ".pyc",
    );
  });

  it("reports each selected pyc limit and reopens the same artifact successfully", async () => {
    const root = await createTestTempDirectory("rea-python-pyc-budget-");
    const path = join(root, "sample.pyc");
    const bytes = pythonPycFixture("py311", { nested: true });
    await writeFile(path, bytes);
    const service = createPythonPycService();
    // Expected ranges are the published schema bounds, written out literally.
    const ranges = {
      max_file_bytes: {
        minimum: 16,
        maximum: 67108864,
        default_value: 16777216,
      },
      max_objects: { minimum: 1, maximum: 65536, default_value: 16384 },
      max_depth: { minimum: 1, maximum: 256, default_value: 64 },
      max_string_bytes: {
        minimum: 1,
        maximum: 8388608,
        default_value: 1048576,
      },
    } as const;
    for (const [field, maximum, resource, unit] of [
      ["max_file_bytes", 16, "file-size", "bytes"],
      ["max_objects", 1, "memory", "count"],
      ["max_depth", 1, "capacity", "count"],
      ["max_string_bytes", 2, "memory", "bytes"],
    ] as const) {
      const refused = await service.inspect({ path, [field]: maximum });
      if (refused.ok) throw new Error(`Expected ${field} refusal`);
      expect(projectAnalysisError(refused.error)).toMatchObject({
        code: "resource_constraint",
        retryable: false,
        details: {
          resource,
          reported_limits:
            field === "max_file_bytes"
              ? { max_file_bytes: maximum }
              : { boundary: field, maximum },
          limit: {
            control_kind: "parameter",
            parameter: field,
            effective_value: maximum,
            unit,
            ...ranges[field],
            applies_at: "next_call",
          },
        },
        remediation: {
          action: expect.stringContaining(`Raise ${field} above`),
        },
      });
      // Contract fields only; the CLI adds its own flag spelling.
      expect(
        JSON.stringify(projectAnalysisError(refused.error).remediation),
      ).not.toContain("--");
    }
    const control = await service.inspect({ path });
    if (!control.ok) throw control.error;
    expect(control.value.normalized_result).toMatchObject({
      artifact: { path, bytes: bytes.length },
      coverage: { status: "complete", code_objects: 2 },
    });
  });
});
