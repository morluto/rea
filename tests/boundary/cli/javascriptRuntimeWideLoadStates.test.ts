import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "../../../src/domain/javascript/javascriptApplicationGraph.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createJavaScriptSemanticGraph } from "../../../src/domain/javascript/javascriptSemanticGraph.js";
import { javascriptRuntimeReconciliationResultSchema } from "../../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { nodeReconciliationFixture } from "../../fixtures/nodeRuntimeReconciliation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";

/** Construct authenticated synthetic observations, without a live Inspector. */
const wideRequest = (count: number) => {
  const input = nodeReconciliationFixture(false);
  const original = input.static_layers[0]!.analysis;
  const result = javascriptApplicationAnalysisResultSchema.parse(
    original.normalized_result,
  );
  const observation = result.graph.nodes.find(
    ({ kind }) => kind === "javascript-asset",
  )!.observations[0]!;
  const nodes = [...result.graph.nodes];
  for (let index = 0; index < count; index++) {
    const path = `part-${String(index)}.js`;
    const source = `export const value=${String(index)};\n`;
    const sha256 = createHash("sha256").update(source).digest("hex");
    nodes.push(
      createJavaScriptApplicationNode({
        kind: "javascript-asset",
        identity: {
          strategy: "content-digest",
          stability: "global-exact",
          sha256,
        },
        observations: [
          {
            label: path,
            properties: { path, bytes: source.length },
            evidence: {
              ...observation.evidence,
              artifact: {
                available: true,
                artifact_id: `art_${sha256}`,
                sha256,
              },
              location: {
                available: true,
                value: { kind: "artifact-path", path },
              },
            },
          },
        ],
      }),
    );
  }
  const { graph_id: _oldGraphId, ...graphContent } = result.graph;
  const graph = createJavaScriptApplicationGraph({ ...graphContent, nodes });
  const { graph_id: _oldSemanticId, ...semanticContent } =
    result.semantic_graph;
  const semanticGraph = createJavaScriptSemanticGraph({
    ...semanticContent,
    application_graph_id: graph.graph_id,
  });
  const analysis = createEvidence(
    {
      path: result.input_path,
      sha256: result.root_artifact_sha256,
      format: result.format,
    },
    original.provider,
    {
      predicateType: original.predicate_type,
      operation: original.operation,
      parameters: original.parameters,
      result: { ...result, graph, semantic_graph: semanticGraph },
      confidence: original.confidence,
      authority: original.authority,
    },
  );
  return {
    input: { ...input, static_layers: [{ analysis }] },
    assetIds: graph.nodes
      .filter(({ kind }) => kind === "javascript-asset")
      .map(({ node_id }) => node_id),
    analysisId: analysis.evidence_id,
  };
};

processTest.for([1_000, 16_000])(
  "retains every static load state for %s added assets through the compiled CLI",
  async (count, { processes }) => {
    const root = await createTestTempDirectory("rea-runtime-wide-states-");
    const path = join(root, "request.json");
    const { input, assetIds, analysisId } = wideRequest(count);
    const text = JSON.stringify(input);
    await writeFile(path, text);
    const response = await processes.run(
      process.execPath,
      [
        // Exercise the same argument-stack bound with a smaller portable fixture.
        // The normal-stack 130,001-asset reproducer is recorded in #10352.
        "--stack_size=128",
        fileURLToPath(new URL("../../../scripts/rea.mjs", import.meta.url)),
        "reconcile-javascript-runtime",
        path,
        "--json",
      ],
      { cwd: root },
    );
    expect(
      response.exitCode,
      response.stderr + response.stdout.slice(0, 2000),
    ).toBe(0);
    const evidence = parseEvidence(JSON.parse(response.stdout));
    expect(evidence.operation).toBe("reconcile_javascript_runtime");
    const result = javascriptRuntimeReconciliationResultSchema.parse(
      evidence.normalized_result,
    );
    expect(result.static_layers[0]?.evidence_id).toBe(analysisId);
    expect(result.static_load_states).toHaveLength(count + 1);
    const expected = new Set(assetIds);
    for (const state of result.static_load_states) {
      expect(expected.delete(state.static_node_id)).toBe(true);
      expect(state).toMatchObject({
        kind: "javascript-asset",
        status: "unknown",
        runtime_node_ids: [],
        reason: "static-or-runtime-coverage-incomplete",
      });
    }
    expect(expected.size).toBe(0);
    expect(result.summary).toMatchObject({
      runtime_scripts: 0,
      static_loaded: 0,
      static_not_observed: 0,
      static_unknown: count + 1,
    });
    expect(await readFile(path, "utf8")).toBe(text);
  },
);
