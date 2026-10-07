import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { parseEvidence } from "../../dist/domain/evidence.js";
import { analysisProfileSchema } from "../../dist/domain/analysisProfile.js";
import { nativeValueTraceSchema } from "../../dist/domain/native/nativeValueTrace.js";

const defaultEntrypoint = fileURLToPath(new URL("../rea.mjs", import.meta.url));
const environment = () => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "ghidra",
  HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
  ...(process.env.GHIDRA_INSTALL_DIR === undefined
    ? {}
    : { GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR }),
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { JAVA_HOME: process.env.JAVA_HOME }),
});

const verifyGraph = (input, target, procedure, globalAddress) => {
  const graph = nativeValueTraceSchema.parse(input);
  assert.equal(graph.target_sha256, target.sha256);
  assert.equal(graph.seed, procedure);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const kind of ["argument-binding", "parameter-use", "return-binding"]) {
    const edges = graph.edges.filter((edge) => edge.kind === kind);
    assert.ok(edges.length > 0, `Real native dependency graph lacks ${kind}`);
    for (const edge of edges) {
      const source = nodes.get(edge.source);
      const destination = nodes.get(edge.target);
      assert.ok(source, `Missing source node ${edge.source}`);
      assert.ok(destination, `Missing target node ${edge.target}`);
      assert.equal(edge.status, "derived");
      if (kind === "argument-binding") {
        assert.match(source.operation?.opcode ?? "", /^CALL(?:IND)?$/u);
        assert.equal(destination.kind, "parameter");
        assert.equal(edge.input_index, destination.parameter.ordinal + 1);
      } else if (kind === "parameter-use") {
        assert.equal(source.kind, "parameter");
        assert.ok(destination.operation.inputs[edge.input_index]);
      } else {
        assert.equal(source.operation?.opcode, "RETURN");
        assert.match(destination.operation?.opcode ?? "", /^CALL(?:IND)?$/u);
        assert.equal(edge.input_index, 1);
      }
    }
  }
  assert.ok(
    graph.nodes.some((node) =>
      node.operation?.inputs.some((value) => value.location === globalAddress),
    ),
    "Source-owned global operand is absent from the real dependency graph",
  );
  for (const node of graph.nodes)
    assert.match(node.evidence_id, /^ev_[a-f0-9]{64}$/u);
  for (const procedure of graph.procedures) {
    assert.equal(procedure.provider, "ghidra");
    assert.match(procedure.analysis_profile_digest, /^[a-f0-9]{64}$/u);
  }
  return graph;
};

/** Verify real Ghidra dependency composition through production CLI and stdio MCP. */
export async function verifyNativeValueE2e(
  target,
  procedure,
  globalAddress,
  { entrypoint = defaultEntrypoint } = {},
) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      entrypoint,
      "trace-native-values",
      target.path,
      procedure,
      "--provider",
      "ghidra",
      "--max-depth",
      "2",
      "--max-functions",
      "8",
      "--limit",
      "5000",
      "--json",
    ],
    { env: environment(), timeout: 240000, maxBuffer: 72 * 1024 * 1024 },
  );
  const evidence = parseEvidence(JSON.parse(stdout));
  assert.equal(evidence.operation, "trace_native_values");
  assert.equal(evidence.provider.id, "rea-workflow");
  const workflowProfile = analysisProfileSchema.parse(
    evidence.analysis_profile,
  );
  assert.equal(workflowProfile.provider.id, "rea-workflow");
  const upstreamProfile = analysisProfileSchema.parse(
    workflowProfile.parameters.upstream_analysis_profile,
  );
  assert.equal(upstreamProfile.provider.id, "ghidra");
  const cliGraph = verifyGraph(
    evidence.normalized_result,
    target,
    procedure,
    globalAddress,
  );
  for (const procedure of cliGraph.procedures)
    assert.equal(procedure.analysis_profile_digest, upstreamProfile.digest);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env: environment(),
    stderr: "pipe",
  });
  const client = new Client({ name: "native-values-real-e2e", version: "1" });
  try {
    await client.connect(transport);
    const opened = await client.callTool(
      {
        name: "open_binary",
        arguments: { path: target.path, provider: "ghidra" },
      },
      { timeout: 180000 },
    );
    assert.notEqual(opened.isError, true, JSON.stringify(opened));
    const inventory = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    assert.notEqual(inventory.isError, true, JSON.stringify(inventory));
    assert.ok(
      inventory.structuredContent?.result?.tool_availability.some(
        (tool) => tool.name === "trace_native_values" && tool.available,
      ),
      "Native value tracing is unavailable in real provider discovery",
    );
    const result = await client.callTool(
      {
        name: "trace_native_values",
        arguments: { procedure, max_depth: 2, max_functions: 8, limit: 5000 },
      },
      { timeout: 180000 },
    );
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const mcpEvidence = parseEvidence(result.structuredContent?.evidence);
    assert.equal(mcpEvidence.operation, "trace_native_values");
    assert.equal(mcpEvidence.provider.id, "rea-workflow");
    assert.deepEqual(mcpEvidence.analysis_profile, workflowProfile);
    const mcpGraph = verifyGraph(
      result.structuredContent?.result,
      target,
      procedure,
      globalAddress,
    );
    assert.deepEqual(mcpEvidence.normalized_result, mcpGraph);
    assert.deepEqual(mcpGraph, cliGraph);
    const analyzed = await client.callTool(
      { name: "analyze_function", arguments: { procedure } },
      { timeout: 180000 },
    );
    assert.notEqual(analyzed.isError, true, JSON.stringify(analyzed));
    const functionEvidence = parseEvidence(
      analyzed.structuredContent?.evidence,
    );
    assert.equal(functionEvidence.operation, "analyze_function");
    assert.equal(functionEvidence.provider.id, "rea-workflow");
    const functionProfile = analysisProfileSchema.parse(
      functionEvidence.analysis_profile,
    );
    assert.deepEqual(
      functionProfile.parameters.upstream_analysis_profile,
      upstreamProfile,
    );
    assert.deepEqual(
      functionEvidence.normalized_result,
      analyzed.structuredContent?.result,
    );
    const comparison = await client.callTool(
      {
        name: "compare_functions",
        arguments: {
          left: analyzed.structuredContent.evidence,
          right: analyzed.structuredContent.evidence,
        },
      },
      { timeout: 180000 },
    );
    assert.notEqual(comparison.isError, true, JSON.stringify(comparison));
    const comparisonEvidence = parseEvidence(
      comparison.structuredContent?.evidence,
    );
    assert.equal(comparisonEvidence.normalized_result.status, "unchanged");
    assert.deepEqual(
      comparisonEvidence.normalized_result,
      comparison.structuredContent?.result,
    );
    assert.ok(
      comparisonEvidence.evidence_links.includes(functionEvidence.evidence_id),
    );
    const bundle = await client.callTool({
      name: "get_evidence_bundle",
      arguments: {},
    });
    assert.notEqual(bundle.isError, true, JSON.stringify(bundle));
    for (const evidence of [
      mcpEvidence,
      functionEvidence,
      comparisonEvidence,
    ]) {
      assert.deepEqual(
        bundle.structuredContent?.result?.records.find(
          (record) => record.evidence_id === evidence.evidence_id,
        ),
        evidence,
      );
    }
    const closed = await client.callTool({
      name: "close_binary",
      arguments: {},
    });
    assert.notEqual(closed.isError, true, JSON.stringify(closed));
    const status = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    assert.equal(status.structuredContent?.result?.open, false);
  } finally {
    await client.close();
    await transport.close();
  }
  return {
    mocked: false,
    cli: true,
    stdio_mcp: true,
    inline_evidence: true,
    direct_function_comparison: true,
    nodes: cliGraph.total_nodes,
    edges: cliGraph.total_edges,
    decompilations: cliGraph.decompilations,
    unknowns: cliGraph.unknowns.length,
  };
}
