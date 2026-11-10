import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { applicationVersionComparisonResultSchema } from "../../../src/domain/javascript/javascriptApplicationVersionComparisonSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "compares URL-backed source-map declarations through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-source-map-version-cli-");
    const map = JSON.stringify({
      version: 3,
      sourceRoot: "webpack:///",
      sources: ["src/main.ts"],
      sourcesContent: ["export const value = 1"],
      names: [],
      mappings: "AAAA",
    });
    const versions = [];
    for (const side of ["left", "right"]) {
      const path = join(root, side);
      await mkdir(path);
      await writeFile(
        join(path, "main.js"),
        `//# sourceMapping${"URL"}=main.js.map`,
      );
      await writeFile(join(path, "main.js.map"), map);
      await writeFile(join(path, "sibling.js"), `${side}();`);
      const analyzed = await cli.run({
        arguments: ["analyze-javascript-application", path, "--json"],
      });
      expect(analyzed.exitCode, analyzed.stderr).toBe(0);
      versions.push(parseEvidence(analyzed.json));
    }
    const [left, right] = versions;
    if (left === undefined || right === undefined)
      throw new Error("Expected both application Evidence records");
    const input = join(root, "comparison.json");
    await writeFile(input, JSON.stringify({ left, right }));
    const result = await cli.run({
      arguments: ["compare-application-versions", input, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const cliEvidence = parseEvidence(result.json);
    const cliComparison = applicationVersionComparisonResultSchema.parse(
      cliEvidence.normalized_result,
    );
    const originals = cliComparison.items.filter(
      ({ node_kind }) => node_kind === "source-module",
    );
    expect(originals).toEqual([
      expect.objectContaining({
        match: {
          status: "matched",
          basis: "source-map-identity",
          confidence: "high",
          candidate_left_node_ids: [],
          candidate_right_node_ids: [],
        },
        status: "unchanged",
      }),
    ]);

    const client = new Client({
      name: "source-map-version-test",
      version: "1",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport);
      // retain each graph in this session instead of resending full evidence as tool input.
      for (const [side, expected] of [
        ["left", left],
        ["right", right],
      ] as const) {
        const analyzed = await client.callTool({
          name: "analyze_javascript_application",
          arguments: { input_path: join(root, side) },
        });
        expect(analyzed.isError, JSON.stringify(analyzed)).not.toBe(true);
        expect(parseEvidence(analyzed.structuredContent).evidence_id).toBe(
          expected.evidence_id,
        );
      }
      const response = await client.callTool({
        name: "compare_application_versions",
        arguments: {
          left: { kind: "retained-evidence", evidence_id: left.evidence_id },
          right: { kind: "retained-evidence", evidence_id: right.evidence_id },
        },
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const mcpEvidence = parseEvidence(response.structuredContent);
      const mcpComparison = applicationVersionComparisonResultSchema.parse(
        mcpEvidence.normalized_result,
      );
      expect(mcpEvidence.evidence_id).toBe(cliEvidence.evidence_id);
      expect(
        mcpComparison.items.filter(
          ({ node_kind }) => node_kind === "source-module",
        ),
      ).toEqual(originals);
    } finally {
      await client.close();
    }
  },
);
