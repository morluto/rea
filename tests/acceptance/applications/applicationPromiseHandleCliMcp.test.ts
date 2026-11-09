import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for([false, true])(
  "distinguishes the FileHandle carrier with awaited=%s through CLI and MCP",
  async (awaited, { cli }) => {
    const { client, call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "electron",
      REA_MCP_INPUT_SCHEMA_PROFILE: "full",
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "full",
    });
    const definition = (await client.listTools()).tools.find(
      ({ name }) => name === "analyze_javascript_application",
    );
    if (definition === undefined)
      throw new Error("Missing JavaScript analysis definition");
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(definition.inputSchema);
    const root = await createTestTempDirectory("rea-promise-handle-");
    const source = `import { open } from "node:fs/promises";\nconst handle = ${awaited ? "await " : ""}open("input.txt", "r");\nhandle.close();\n`;
    const sha = createHash("sha256").update(source).digest("hex");
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "promise-handle",
          type: "module",
          main: "main.js",
        }),
      ),
      writeFile(join(root, "main.js"), source),
    ]);
    const response = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
    });
    expect(response.exitCode, response.stdout).toBe(0);
    const args = { input_path: root };
    expect(validate(args), JSON.stringify(validate.errors)).toBe(true);
    const mcp = await call(definition.name, args);
    expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true);
    for (const evidence of [response.json, mcp.structuredContent]) {
      const result = javascriptApplicationAnalysisResultSchema.parse(
        parseEvidence(evidence).normalized_result,
      );
      expect(result.statistics.parsed_javascript_files).toBe(1);
      expect(result.statistics.parse_failures).toBe(0);
      const graph = result.semantic_graph;
      if (graph === undefined) throw new Error("Missing semantic graph");
      expect(
        graph.nodes.filter(({ kind }) => kind === "resource"),
      ).toHaveLength(1);
      expect(
        graph.relations.filter(({ relation }) => relation === "acquires"),
      ).toHaveLength(1);
      expect
        .soft(graph.relations.filter(({ relation }) => relation === "releases"))
        .toHaveLength(awaited ? 1 : 0);
      expect(
        graph.nodes.some(
          ({ identity }) =>
            identity.artifact_sha256 === sha &&
            identity.module_path === "main.js",
        ),
      ).toBe(true);
    }
  },
);
