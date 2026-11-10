import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { javascriptRuntimeReconciliationResultSchema } from "../../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { nodeReconciliationFixture } from "../../fixtures/nodeRuntimeReconciliation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "reconciles synthetic Node target entry Evidence through %s",
  async (surface, { cli }) => {
    const input = nodeReconciliationFixture(false);
    let document: unknown;
    if (surface === "CLI") {
      const root = await createTestTempDirectory(
        "rea-node-reconciliation-cli-",
      );
      const path = join(root, "input.json");
      await writeFile(path, JSON.stringify(input));
      const response = await cli.run({
        arguments: ["reconcile-javascript-runtime", path, "--format", "json"],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      document = response.json;
    } else {
      const call = await cli.sharedMcpCall!();
      const response = await call("reconcile_javascript_runtime", input);
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      document = response.structuredContent;
    }
    const result = javascriptRuntimeReconciliationResultSchema.parse(
      (document as { normalized_result: unknown }).normalized_result,
    );
    expect(result.reconciliations).toEqual([
      expect.objectContaining({
        entity_kind: "target",
        status: "matched",
        reason: "unique-location-match",
        confidence: "medium",
        candidate_static_count: 1,
      }),
    ]);
    expect(result.summary).toMatchObject({
      runtime_scripts: 0,
      static_loaded: 0,
      static_not_observed: 0,
    });
    expect(
      result.graph.edges.filter(({ relation }) => relation === "observed_as"),
    ).toHaveLength(1);
  },
);
