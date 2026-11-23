import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPythonPycService } from "../../../src/composition/pythonPyc.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { pythonPycFixture } from "../../../src/python/PythonPyc.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("Python pyc stable filesystem boundary", () => {
  it("reports non-file and malformed pyc selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-python-pyc-files-");
    const path = join(root, "sample.pyc");
    const alias = join(root, "alias.pyc");
    const malformed = join(root, "malformed.pyc");
    await writeFile(path, pythonPycFixture());
    await writeFile(malformed, Buffer.from("not a pyc"));
    await symlink(path, alias);
    const service = createPythonPycService();
    for (const [candidate, reason] of [
      [root, "invalid_format"],
      [alias, "invalid_format"],
      [malformed, "invalid_format"],
      [join(root, "missing.pyc"), "invalid_value"],
      [join(path, "child.pyc"), "invalid_value"],
    ] as const) {
      const result = await service.inspect({ path: candidate });
      if (result.ok) throw new Error("Expected file acquisition failure");
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        operation: "inspect_python_pyc",
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

  it("reports each selected pyc limit and reopens the same artifact successfully", async () => {
    const root = await createTestTempDirectory("rea-python-pyc-budget-");
    const path = join(root, "sample.pyc");
    const bytes = pythonPycFixture("py311", { nested: true });
    await writeFile(path, bytes);
    const service = createPythonPycService();
    for (const [field, maximum, resource] of [
      ["max_file_bytes", 16, "file-size"],
      ["max_objects", 1, "memory"],
      ["max_depth", 1, "capacity"],
      ["max_string_bytes", 2, "memory"],
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
        },
        remediation: {
          action: expect.stringContaining(
            `${field} (--${field.replaceAll("_", "-")})`,
          ),
        },
      });
    }
    const control = await service.inspect({ path });
    if (!control.ok) throw control.error;
    expect(control.value.normalized_result).toMatchObject({
      artifact: { path, bytes: bytes.length },
      coverage: { status: "complete", code_objects: 2 },
    });
  });
});
