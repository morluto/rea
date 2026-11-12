import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { javaScriptSemanticTraceResultSchema } from "../../../src/domain/javascript/javascriptSemanticTraceSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "preserves exact empty events and unresolved property queries through public Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-graph-query-coverage-");
    await writeFile(
      join(root, "main.cjs"),
      'const { EventEmitter } = require("node:events"); const bus = new EventEmitter(); bus.on("", function emptyListener() {}); function read() { return this.speed; }',
    );
    await writeFile(join(root, "other.js"), "export const answer = 42;");
    const response = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--source-path",
        "main.cjs",
        "--source-path",
        "other.js",
        "--format",
        "json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const evidence = parseEvidence(response.json);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      evidence.normalized_result,
    );
    expect(result.source_selection?.unselected_files).toBe(0);
    expect(
      result.graph.limitations.some((text) =>
        text.includes("relationships through unselected sources"),
      ),
    ).toBe(false);
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected shared MCP session");
    for (const seed of [
      { kind: "event", name: "" },
      { kind: "property", name: "speed" },
    ] as const) {
      const traced = await call("trace_javascript_semantics", {
        application: evidence,
        query: { seed, direction: "forward-influence" },
      });
      expect(traced.isError, JSON.stringify(traced.content)).not.toBe(true);
      const trace = javaScriptSemanticTraceResultSchema.parse(
        parseEvidence(traced.structuredContent).normalized_result,
      );
      expect(trace.summary.total_seed_matches).toBeGreaterThan(0);
      expect(trace.seed).toEqual(seed);
      expect(trace.seed_node_ids).toHaveLength(
        trace.summary.total_seed_matches,
      );
      const seedNodes = trace.seed_node_ids.map((id) =>
        trace.nodes.find(({ node_id }) => node_id === id),
      );
      if (seed.kind === "event") {
        expect(seedNodes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "event",
              properties: expect.objectContaining({ event_name: "" }),
            }),
            expect.objectContaining({
              kind: "listener",
              properties: expect.objectContaining({ event_name: "" }),
            }),
          ]),
        );
      } else {
        expect(trace.summary.relevant_unknowns).toBeGreaterThan(0);
        expect(seedNodes).toContainEqual(
          expect.objectContaining({
            kind: "expression",
            properties: expect.objectContaining({
              property_path: ["speed"],
              property_slot_resolution: "unresolved",
            }),
          }),
        );
        const seedUnknown = trace.unknowns.find(
          ({ node_id }) =>
            node_id !== null && trace.seed_node_ids.includes(node_id),
        );
        expect(seedUnknown).toMatchObject({
          family: "object-flow",
          reason: "ambiguous-target",
        });
      }
    }
  },
);

cliTest(
  "traces a coercion boundary through its assigned result",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-graph-boundary-result-");
    await writeFile(
      join(root, "main.js"),
      "function parse(raw) { const n = Number(raw); return n; } module.exports = parse;",
    );
    const analysis = await cli.run({
      arguments: ["analyze-javascript-application", root, "--format", "json"],
    });
    expect(analysis.exitCode, analysis.stderr).toBe(0);
    const application = parseEvidence(analysis.json);
    const graph = javascriptApplicationAnalysisResultSchema.parse(
      application.normalized_result,
    ).semantic_graph;
    if (graph === null) throw new Error("Expected semantic graph");
    const read = graph.nodes.find((node) =>
      node.identity.role_key.endsWith("read:n"),
    );
    if (read === undefined) throw new Error("Expected result read");
    const query = {
      seed: { kind: "boundary-field", field: "Number" },
      direction: "forward-influence",
    };
    const request = join(root, "request.json");
    await writeFile(request, JSON.stringify({ application, query }));
    const result = await cli.run({
      arguments: ["trace-javascript-semantics", request, "--format", "json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const trace = javaScriptSemanticTraceResultSchema.parse(
      parseEvidence(result.json).normalized_result,
    );
    expect(trace.nodes).toContainEqual(read);
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected shared MCP session");
    const mcp = await call("trace_javascript_semantics", {
      application,
      query,
    });
    expect(mcp.isError, JSON.stringify(mcp.content)).not.toBe(true);
    const mcpTrace = javaScriptSemanticTraceResultSchema.parse(
      parseEvidence(mcp.structuredContent).normalized_result,
    );
    expect(mcpTrace.nodes).toContainEqual(read);
  },
);

cliTest(
  "retains candidate Electron loader evidence through semantic traces",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-conditional-electron-trace-",
    );
    await writeFile(
      join(root, "main.MJS"),
      'const { contextBridge, ipcRenderer } = require("electron"); contextBridge.exposeInMainWorld("api", { ping: () => ipcRenderer.invoke("ping") });',
    );
    const analysis = await cli.run({
      arguments: ["analyze-javascript-application", root, "--format", "json"],
    });
    expect(analysis.exitCode, analysis.stderr).toBe(0);
    const application = parseEvidence(analysis.json);
    const graph = javascriptApplicationAnalysisResultSchema.parse(
      application.normalized_result,
    ).semantic_graph;
    const seed = graph.nodes.find(
      (node) =>
        node.properties.loader_authority === "candidate" &&
        node.properties.step_kind === "exposure",
    );
    if (seed === undefined)
      throw new Error("Expected candidate Electron exposure");
    const query = {
      seed: { kind: "semantic-node", node_id: seed.node_id },
      direction: "forward-influence",
      include_ambiguous_dynamic_edges: true,
    };
    const request = join(root, "trace.json");
    await writeFile(request, JSON.stringify({ application, query }));
    const response = await cli.run({
      arguments: ["trace-javascript-semantics", request, "--format", "json"],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const mcpCall = await cli.sharedMcpCall?.();
    if (mcpCall === undefined) throw new Error("Expected shared MCP session");
    const mcp = await mcpCall("trace_javascript_semantics", {
      application,
      query,
    });
    expect(mcp.isError, JSON.stringify(mcp.content)).not.toBe(true);
    for (const evidence of [
      parseEvidence(response.json),
      parseEvidence(mcp.structuredContent),
    ]) {
      const trace = javaScriptSemanticTraceResultSchema.parse(
        evidence.normalized_result,
      );
      const node = trace.nodes.find(({ node_id }) => node_id === seed.node_id);
      expect(node?.properties.loader_authority).toBe("candidate");
      const context = trace.evidence_contexts.find(
        ({ context_id }) => context_id === node?.evidence.context_id,
      );
      expect(context).toMatchObject({ state: "inferred", confidence: "low" });
      expect(context?.limitations.join(" ")).toContain("loader is unknown");
      const candidateRelations = trace.relations.filter(
        ({ properties }) => properties.loader_authority === "candidate",
      );
      expect(candidateRelations.length).toBeGreaterThan(0);
      for (const relation of candidateRelations) {
        const relationContext = trace.evidence_contexts.find(
          ({ context_id }) => context_id === relation.evidence.context_id,
        );
        expect(relationContext).toMatchObject({
          state: "inferred",
          confidence: "low",
        });
        expect(relationContext?.limitations.join(" ")).toContain(
          "loader is unknown",
        );
      }
    }
  },
);
