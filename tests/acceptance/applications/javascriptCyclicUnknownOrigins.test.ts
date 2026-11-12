import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "retains semantic Evidence for cyclic unknown inputs within the selected heap through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-cyclic-unknown-origins-");
    const branches = Array.from(
      { length: 16 },
      (_, index) => `if (flag === ${index}) node = node.m${index};`,
    ).join(" else ");
    const body = `let node = seed; while (node) { ${branches} use(node.state); } return seed.keep;`;
    await writeFile(
      join(root, "entry.mjs"),
      `throw new Error("This analysis fixture must not execute");
export function parameter(seed) { ${body} }
export function caught() { try { run(); } catch (seed) { ${body} } }
export function unaffected() { return 42; }`,
    );
    const verify = (document: unknown): void => {
      const result = javascriptApplicationAnalysisResultSchema.parse(
        parseEvidence(document).normalized_result,
      );
      expect(result.statistics).toMatchObject({
        parsed_javascript_files: 1,
        skipped_javascript_files: 0,
        parse_failures: 0,
      });
      expect(result.semantic_graph.coverage.truncated).toBe(false);
      expect(
        result.semantic_graph.unknowns.filter(
          ({ reason }) => reason === "resource-limit",
        ),
      ).toEqual([]);
      for (const [name, status, value] of [
        ["parameter", "unknown", null],
        ["caught", "unknown", null],
        ["unaffected", "literal", 42],
      ] as const) {
        const observation = result.graph.nodes
          .flatMap(({ observations }) => observations)
          .find(
            ({ properties }) =>
              properties.semantic_role === "export-return-shapes" &&
              properties.exported_name === name,
          );
        expect(observation, name).toBeDefined();
        expect(observation?.properties.static_return_shapes).toMatchObject([
          {
            value_status: status,
            fields: [{ path: "", state: status, value }],
          },
        ]);
      }
    };
    const response = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--max-heap-mb",
        "128",
        "--analysis-timeout-ms",
        "5000",
        "--json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    expect(response.signal).toBeNull();
    verify(response.json);

    const { call } = await connectLocalToolsMcp();
    const analyzed = await call("analyze_javascript_application", {
      input_path: root,
      format: "directory",
      max_heap_mb: 128,
      analysis_timeout_ms: 5000,
    });
    expect(analyzed.isError, JSON.stringify(analyzed.content)).not.toBe(true);
    verify(analyzed.structuredContent);
  },
  60_000,
);
