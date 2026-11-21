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
