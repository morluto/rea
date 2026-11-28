import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { pythonPycFixture } from "../../../src/python/PythonPyc.fixture.js";
import { pythonPycLimit } from "../../../src/python/PythonPyc.errors.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// The nested-code allowances are max_objects * max_depth, and no marshal
// fixture can spend them: each code object costs dozens of objects, so the
// object and depth budgets refuse first. The parser is therefore replaced
// here so the provider's real classification and projection run on the
// refusal it would raise.
const parser = vi.hoisted(() => ({ limit: undefined as unknown }));
vi.mock("../../../src/python/PythonPycParser.js", () => ({
  parsePythonPyc: () => {
    throw parser.limit;
  },
}));

const { createPythonPycService } =
  await import("../../../src/composition/pythonPyc.js");

describe("pyc nested-code limits", () => {
  it.each(["nested_code_steps", "nested_code_references"] as const)(
    "reports %s as a product of two controls, not one range",
    async (name) => {
      parser.limit = pythonPycLimit(
        name,
        4096,
        "Nested code walk is too large.",
      );
      const root = await createTestTempDirectory("rea-pyc-nested-limit-");
      const path = join(root, "sample.pyc");
      await writeFile(path, pythonPycFixture("py311"));
      const refused = await createPythonPycService().inspect({
        path,
        max_objects: 64,
        max_depth: 64,
      });
      if (refused.ok) throw new Error(`Expected ${name} refusal`);
      const { details, remediation } = projectAnalysisError(refused.error);
      expect(details).toMatchObject({
        resource: "memory",
        related_parameters: ["max_objects", "max_depth"],
      });
      expect(details).not.toHaveProperty("limit");
      expect(remediation?.action).toContain("Raise max_objects above 64");
      expect(remediation?.action).toContain("Raise max_depth above 64");
    },
  );
});
