import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// A 448 MiB parent heap gives one Evidence a budget of about 39 MB, which this
// source's semantic facts exceed while the small source fits its share.
cliTest.skipIf(process.versions.bun !== undefined)(
  "bounds semantic facts per source and pages exact coverage and unknowns",
  { timeout: 90_000 },
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-semantic-budget-");
    const large = Array.from(
      { length: 2400 },
      (_, index) =>
        `export function method_${String(index)}(input) { const value = input + ${String(index)}; const pair = { value }; return pair.value; }`,
    ).join("\n");
    await writeFile(join(root, "a-large.mjs"), large);
    await writeFile(
      join(root, "b-small.mjs"),
      "export const run = (handlers, key) => handlers[key]();\n",
    );
    const environment = {
      HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
      NODE_OPTIONS: "--max-old-space-size=448 --max-semi-space-size=8",
    };
    const analyzed = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
      environment,
      timeoutMs: 60_000,
    });
    expect(analyzed.exitCode).toBe(0);
    const evidence = parseEvidence(analyzed.json);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      evidence.normalized_result,
    );
    const { coverage } = result.semantic_graph;
    const [largeCoverage, smallCoverage] = coverage.files;
    expect(largeCoverage).toMatchObject({
      module_path: "a-large.mjs",
      status: "truncated",
    });
    expect(smallCoverage).toMatchObject({
      module_path: "b-small.mjs",
      status: "complete",
      omitted_nodes: 0,
    });
    if (
      largeCoverage?.graph_byte_budget == null ||
      largeCoverage.retained_graph_bytes === null
    )
      throw new Error("A truncated source reports its byte budget");
    // Final linking can add application IDs under the shared allowance.
    expect(largeCoverage.retained_graph_bytes).toBeLessThanOrEqual(
      largeCoverage.final_shared_graph_byte_budget ??
        largeCoverage.graph_byte_budget,
    );
    // Projection stopped before all facts were examined; totals stay unknown.
    expect(largeCoverage.omitted_nodes).toBeNull();
    expect(largeCoverage.omitted_fingerprints).toBeNull();
    expect(
      coverage.families.find(({ family }) => family === "data-flow")
        ?.omitted_unknowns,
    ).toBeNull();
    expect(coverage.limits).toContainEqual(
      expect.objectContaining({
        name: "javascript_analysis_evidence_budget_bytes",
        unit: "bytes",
      }),
    );
    const nodeIds = new Set(
      result.semantic_graph.nodes.map(({ node_id }) => node_id),
    );
    expect(
      result.semantic_graph.relations.every(
        ({ source_node_id, target_node_id }) =>
          nodeIds.has(source_node_id) && nodeIds.has(target_node_id),
      ),
    ).toBe(true);

    const view = async (collection: string, offset: number, limit: number) => {
      const input = join(root, `${collection}-${String(offset)}.json`);
      await writeFile(
        input,
        JSON.stringify({
          source: { kind: "inline", evidence },
          view: { kind: "page", collection, offset, limit },
        }),
      );
      const response = await cli.run({
        arguments: ["inspect-analysis-view", input, "--json"],
        environment,
        timeoutMs: 60_000,
      });
      expect(response.exitCode).toBe(0);
      return response.json;
    };
    expect(await view("semantic_files", 1, 1)).toMatchObject({
      normalized_result: {
        kind: "page",
        items: [smallCoverage],
        coverage: { total: 2, next_offset: null, exhausted: true },
      },
    });
    // The large source closed its budget before its frontiers were offered, so
    // the retained frontiers all belong to the small source.
    expect(
      coverage.files[0]?.unknowns.every(({ retained }) => retained === 0),
    ).toBe(true);
    expect(await view("semantic_unknowns", 0, 1)).toMatchObject({
      normalized_result: {
        kind: "page",
        items: [
          {
            module_path: "b-small.mjs",
            unknown_id: result.semantic_graph.unknowns[0]?.unknown_id,
          },
        ],
        coverage: {
          examined: 1,
          total: result.semantic_graph.unknowns.length,
          next_offset: 1,
        },
      },
    });
  },
);

cliTest.skipIf(process.versions.bun !== undefined)(
  "refuses exported application facts that exceed the Evidence budget",
  { timeout: 180_000 },
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-application-budget-");
    // Each export emits about 6 KB of export, return-shape and relationship
    // records: about 50 MB in total.
    await writeFile(
      join(root, "exports.mjs"),
      Array.from(
        { length: 8000 },
        (_, index) =>
          `export function method_${String(index)}(input) { const value = input + ${String(index)}; const pair = { value }; return pair.value; }`,
      ).join("\n"),
    );
    const heapOptions = "--max-old-space-size=448 --max-semi-space-size=8";
    const analyzed = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
      environment: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        XDG_CACHE_HOME: root,
        NODE_OPTIONS: heapOptions,
      },
      timeoutMs: 150_000,
    });
    expect(analyzed.exitCode).toBe(0);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(analyzed.json).normalized_result,
    );
    expect(result.limitations).toContainEqual(
      expect.stringContaining(
        "source file(s) have analysis or application projection failures",
      ),
    );
    expect(result.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observations: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                path: expect.stringContaining("exports.mjs"),
                operation: "analyze-javascript-source",
                limitation: expect.stringContaining(
                  "Exported application facts exceed the remaining Evidence budget",
                ),
                analysis_failure: expect.objectContaining({
                  code: "resource_constraint",
                }),
              }),
            }),
          ]),
        }),
      ]),
    );
    expect(
      result.graph.nodes.some(({ observations }) =>
        observations.some(
          ({ properties }) => properties.semantic_role === "export-binding",
        ),
      ),
    ).toBe(false);
    // The parent offers one Evidence a twelfth of its heap limit.
    const heapLimit = Number(
      execFileSync(
        process.execPath,
        [
          ...heapOptions.split(" "),
          "-p",
          "require('node:v8').getHeapStatistics().heap_size_limit",
        ],
        { encoding: "utf8" },
      ),
    );
    expect(Buffer.byteLength(analyzed.stdout)).toBeLessThanOrEqual(
      Math.floor(heapLimit / 12),
    );
  },
);
