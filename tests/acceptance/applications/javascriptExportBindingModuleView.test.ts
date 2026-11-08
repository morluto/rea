import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, runFileCli } from "../../support/cli/cliFixture.js";

cliTest(
  "pages only module units for a CommonJS file that exports symbols",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-export-binding-view-");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "export-binding-view", version: "1.0.0" }),
    );
    await writeFile(
      join(root, "index.js"),
      [
        "exports.alpha = function alpha() { return 1; };",
        "exports.beta = function beta() { return 2; };",
      ].join("\n"),
    );
    const analyzed = await runFileCli(cli, {
      arguments: ["analyze-javascript-application", root, "--format", "json"],
    });
    expect(analyzed.exitCode, analyzed.stdout + analyzed.stderr).toBe(0);
    const evidence = parseEvidence(analyzed.json);
    const nodeIds = (
      evidence.normalized_result as {
        graph: { nodes: { node_id: string; observations: { properties: unknown }[] }[] };
      }
    ).graph.nodes;
    const exportBindingIds = nodeIds
      .filter(({ observations }) =>
        observations.some(
          ({ properties }) =>
            (properties as Record<string, unknown>).semantic_role ===
            "export-binding",
        ),
      )
      .map(({ node_id }) => node_id);
    expect(exportBindingIds).toHaveLength(2);
    const evidencePath = join(root, "evidence.json");
    await writeFile(evidencePath, JSON.stringify(evidence));
    const queryPath = join(root, "query.json");

    const inspect = async (view: Record<string, unknown>) => {
      await writeFile(
        queryPath,
        JSON.stringify({
          source: { kind: "evidence-file", path: evidencePath },
          view,
        }),
      );
      const result = await runFileCli(cli, {
        arguments: ["inspect-analysis-view", queryPath, "--json"],
      });
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      return analysisViewResultSchema.parse(
        parseEvidence(result.json).normalized_result,
      );
    };

    const page = await inspect({
      kind: "page",
      collection: "modules",
      offset: 0,
      limit: 100,
    });
    if (page.kind !== "page") throw new Error("expected modules page");
    const pageNodeIds = page.items.map((item) =>
      String((item as { node_id?: unknown }).node_id),
    );
    expect(
      pageNodeIds.filter((nodeId) => exportBindingIds.includes(nodeId)),
    ).toEqual([]);
    expect(page.coverage).toMatchObject({
      total: page.items.length,
      examined: page.items.length,
      exhausted: true,
    });

    // The remaining path ambiguity names only module units, never export
    // bindings, so an ambiguous selector stays actionable.
    await writeFile(
      queryPath,
      JSON.stringify({
        source: { kind: "evidence-file", path: evidencePath },
        view: {
          kind: "item",
          collection: "modules",
          selector: { path: "index.js" },
        },
      }),
    );
    const item = await cli.run({
      arguments: ["inspect-analysis-view", queryPath, "--json"],
    });
    expect(item.exitCode).not.toBe(0);
    const failure = JSON.parse(item.stdout) as {
      details?: { issues?: { expected?: { node_id: string }[] }[] };
    };
    const candidates =
      failure.details?.issues?.flatMap(({ expected }) => expected ?? []) ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    expect(
      candidates.filter(({ node_id }) => exportBindingIds.includes(node_id)),
    ).toEqual([]);
  },
);
