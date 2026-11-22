import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const report = (value: unknown) =>
  javascriptApplicationAnalysisResultSchema.parse(
    toolContract("analyze_javascript_application").outputSchema.parse(value)
      .normalized_result,
  );

cliTest(
  "keeps only possible host effects through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-rejected-effects-");
    const path = join(root, "main.mjs");
    const source = `import { spawn } from "node:child_process";
import tls from "node:tls";
export function rejected(url) {
  spawn("");
  fetch(url, { method: "CONNECT" });
  fetch(url, { headers: { "a b": "1" } });
  new WebSocket("wss://example.test/ws#fragment");
  tls.connect({ port: 443, secureProtocol: "bogus" });
}
export function possible(url) {
  spawn("node");
  fetch(url, { method: "PATCH" });
  new WebSocket("wss://example.test/ws");
  tls.connect({ port: 443, secureProtocol: "TLS_method" });
  spawn("node", [], { get a() { this.detached = true; return 0; }, detached: 1 });
  fetch(url, { get cache() { delete this.method; return "default"; }, method: "CONNECT" });
  fetch(url, { headers: { get x() { delete this["a b"]; return "1"; }, "a b": "1" } });
}
`;
    await writeFile(path, source);
    const result = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const analysis = report(result.json);
    const methods = (kind: string) =>
      analysis.semantic_graph.nodes
        .filter((node) => node.kind === kind)
        .map((node) => node.properties.method)
        .sort();
    expect(methods("child-process")).toEqual(["spawn", "spawn"]);
    expect(methods("request")).toEqual([
      "WebSocket",
      "fetch",
      "fetch",
      "fetch",
    ]);
    expect(methods("resource")).toEqual(["connect"]);
    const { call } = await connectLocalToolsMcp();
    const mcp = await call("analyze_javascript_application", {
      input_path: root,
      detail: "complete",
    });
    expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true);
    expect(report(mcp.structuredContent).semantic_graph).toEqual(
      analysis.semantic_graph,
    );
    expect(await readFile(path, "utf8")).toBe(source);
  },
);

cliTest(
  "qualifies replaced response readers through CLI and named stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-response-reader-identity-");
    const path = join(root, "main.mjs");
    const scenarios = [
      {
        label: "replaced",
        binding: "const",
        method: "json",
        effect: "response.json = () => ({ fake: true });",
        resolution: "candidate",
      },
      {
        label: "conditional",
        binding: "const",
        method: "json",
        effect: "if (flag) response.json = () => ({ fake: true });",
        resolution: "candidate",
      },
      {
        label: "reassigned",
        binding: "let",
        method: "text",
        effect: 'response = { text: () => "fake" };',
        resolution: "candidate",
      },
      {
        label: "unchanged",
        binding: "const",
        method: "text",
        effect: "",
        resolution: "resolved",
      },
    ] as const;
    const source = scenarios
      .map(
        ({ label, binding, method, effect }) => `
export async function ${label}(flag) {
  ${binding} response = await fetch("https://example.invalid/${label}");
  ${effect}
  return response.${method}();
}`,
      )
      .join("\n");
    await writeFile(path, source);
    const before = await readFile(path);
    const result = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const analysis = report(result.json);
    const { call } = await connectLocalToolsMcp();
    const response = await call("analyze_javascript_application", {
      input_path: root,
      detail: "complete",
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(report(response.structuredContent).semantic_graph).toEqual(
      analysis.semantic_graph,
    );
    const { nodes, relations } = analysis.semantic_graph;
    const sourceSha = createHash("sha256").update(before).digest("hex");
    for (const scenario of scenarios) {
      const request = nodes.find(
        (node) =>
          node.kind === "request" &&
          node.properties.endpoint ===
            `https://example.invalid/${scenario.label}`,
      );
      expect(request, scenario.label).toBeDefined();
      if (request === undefined)
        throw new Error(`Missing request ${scenario.label}`);
      expect(request.identity).toMatchObject({
        artifact_sha256: sourceSha,
        module_path: "main.mjs",
      });
      expect(request.identity.source_range).not.toBeNull();
      const requestLinks = relations.filter(
        (edge) =>
          edge.relation === "consumed-by" &&
          edge.source_node_id === request.node_id,
      );
      expect(requestLinks, scenario.label).toHaveLength(1);
      expect(requestLinks[0]).toMatchObject({
        resolution: scenario.resolution,
      });
      const responseNode = nodes.find(
        (node) => node.node_id === requestLinks[0]?.target_node_id,
      );
      expect(responseNode, scenario.label).toMatchObject({ kind: "response" });
      if (responseNode === undefined)
        throw new Error(`Missing response ${scenario.label}`);
      expect(responseNode.identity).toMatchObject({
        artifact_sha256: sourceSha,
        module_path: "main.mjs",
      });
      expect(responseNode.identity.source_range).not.toBeNull();
      const consumed = relations.filter(
        (edge) =>
          edge.relation === "consumed-by" &&
          edge.source_node_id === responseNode.node_id,
      );
      expect(consumed, scenario.label).toHaveLength(1);
      expect(consumed[0]).toMatchObject({
        resolution: scenario.resolution,
        properties: { method: scenario.method },
      });
      if (scenario.resolution === "candidate")
        expect(responseNode.properties.endpoint).toBeNull();
    }
    expect((await readFile(path)).equals(before)).toBe(true);
  },
);
