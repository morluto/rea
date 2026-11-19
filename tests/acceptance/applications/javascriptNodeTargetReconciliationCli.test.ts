import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
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
    const evidence = parseEvidence(document);
    expect(evidence.operation).toBe("reconcile_javascript_runtime");
    const result = javascriptRuntimeReconciliationResultSchema.parse(
      evidence.normalized_result,
    );
    const appEvidenceId = input.static_layers[0]?.analysis.evidence_id;
    const runtimeEvidenceId = input.runtime_observations[0]?.evidence_id;
    const asset = result.graph.nodes.find(
      ({ kind, observations }) =>
        kind === "javascript-asset" &&
        observations.some(
          ({ properties }) => properties.path === "renderer.js",
        ),
    );
    const [capture] = result.runtime_captures;
    if (asset === undefined || capture === undefined)
      throw new Error("Missing renderer asset or runtime capture");
    expect(result.evidence_links).toEqual(
      [appEvidenceId, runtimeEvidenceId].sort(),
    );
    expect(capture).toMatchObject({
      evidence_id: runtimeEvidenceId,
      kind: "v8-inspector",
      scripts: 0,
    });
    expect(result.reconciliations).toEqual([
      expect.objectContaining({
        entity_kind: "target",
        status: "matched",
        basis: "artifact-path",
        static_node_id: asset.node_id,
        runtime_node_id: capture.target_node_id,
        runtime_evidence_id: runtimeEvidenceId,
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
    ).toMatchObject([
      {
        source_node_id: asset.node_id,
        target_node_id: capture.target_node_id,
        evidence: {
          state: "inferred",
          evidence_ids: [appEvidenceId, runtimeEvidenceId].sort(),
        },
      },
    ]);
    expect(
      result.static_load_states.find(
        ({ static_node_id }) => static_node_id === asset.node_id,
      ),
    ).toMatchObject({
      status: "unknown",
      runtime_node_ids: [],
      reason: "static-or-runtime-coverage-incomplete",
    });
  },
);
