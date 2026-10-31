import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { ELECTRON_TOOL_CONTRACTS } from "../../../src/contracts/javascript/electronToolContracts.js";
import { APPLICATION_TOOL_CONTRACTS } from "../../../src/contracts/applicationToolContracts.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { javaScriptSemanticTraceResultSchema } from "../../../src/domain/javascript/javascriptSemanticTraceSchemas.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { runNodeJsonControl } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const analysisContract = ELECTRON_TOOL_CONTRACTS.find(
  (contract) => contract.name === "analyze_javascript_application",
);
const traceContract = APPLICATION_TOOL_CONTRACTS.find(
  (contract) => contract.name === "trace_javascript_semantics",
);
if (analysisContract === undefined || traceContract === undefined)
  throw new Error("Missing JavaScript analysis/trace contract");

cliTest(
  "retains captured destructuring dependencies through CLI and a reusable MCP connection",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-destructuring-capture-");
    const relative = "source ' %/main.cjs";
    const filename = join(root, relative);
    const source = `
const config = { mode: "strict" };
const { mode: selected } = config;
config.mode = "loose";
const array = ["strict"];
const [element] = array;
array[0] = "loose";
const nested = { value: { mode: "strict" } };
const { value: { mode: deep } } = nested;
nested.value.mode = "loose";
const assignedConfig = { mode: "strict" };
let assigned;
({ mode: assigned } = assignedConfig);
assignedConfig.mode = "loose";
const assignedArray = ["strict"];
let assignedElement;
[assignedElement] = assignedArray;
assignedArray[0] = "loose";
const assignedNested = { value: { mode: "strict" } };
let assignedDeep;
({ value: { mode: assignedDeep } } = assignedNested);
assignedNested.value.mode = "loose";
console.log(JSON.stringify([selected, element, deep, assigned, assignedElement, assignedDeep]));
`;
    await writeFixtureFiles(root, { [relative]: source });
    expect(await runNodeJsonControl(root, filename)).toEqual([
      "strict",
      "strict",
      "strict",
      "strict",
      "strict",
      "strict",
    ]);
    const response = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--artifact-format",
        "directory",
        "--source-path",
        relative,
        "--json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const analysis = analysisContract.outputSchema.parse(response.json);
    const graph = javascriptApplicationAnalysisResultSchema.parse(
      analysis.normalized_result,
    ).semantic_graph;
    const { client, call } = await connectLocalToolsMcp();
    const missing = await call("trace_javascript_semantics", {
      application: {
        kind: "retained-evidence",
        evidence_id: analysis.evidence_id,
      },
      query: {
        seed: {
          kind: "semantic-node",
          node_id: graph.nodes.find(
            (node) => node.kind === "binding" && node.label === "selected",
          )!.node_id,
        },
        direction: "backward-provenance",
      },
    });
    expect(missing.isError).toBe(true);
    await client.ping();
    const retained = await call("analyze_javascript_application", {
      input_path: root,
      format: "directory",
      source_paths: [relative],
    });
    expect(retained.isError, JSON.stringify(retained.content)).not.toBe(true);
    const retainedEvidence = analysisContract.outputSchema.parse(
      retained.structuredContent,
    );
    expect(retainedEvidence.evidence_id).toBe(analysis.evidence_id);
    for (const name of [
      "selected",
      "element",
      "deep",
      "assigned",
      "assignedElement",
      "assignedDeep",
    ]) {
      const binding = graph.nodes.find(
        (node) => node.kind === "binding" && node.label === name,
      );
      expect(binding).toBeDefined();
      const query = {
        seed: { kind: "semantic-node" as const, node_id: binding!.node_id },
        direction: "backward-provenance" as const,
      };
      const request = join(root, "trace.json");
      await writeFile(
        request,
        JSON.stringify({ application: analysis, query }),
      );
      const tracedCli = await cli.run({
        arguments: ["trace-javascript-semantics", request, "--json"],
      });
      expect(tracedCli.exitCode, tracedCli.stderr).toBe(0);
      const cliEvidence = traceContract.outputSchema.parse(tracedCli.json);
      const traced = await call("trace_javascript_semantics", {
        application: {
          kind: "retained-evidence",
          evidence_id: analysis.evidence_id,
        },
        query,
      });
      expect(traced.isError, JSON.stringify(traced.content)).not.toBe(true);
      const mcpEvidence = traceContract.outputSchema.parse(
        traced.structuredContent,
      );
      expect(mcpEvidence.evidence_id).toBe(cliEvidence.evidence_id);
      const trace = javaScriptSemanticTraceResultSchema.parse(
        mcpEvidence.normalized_result,
      );
      expect(trace.relations).toContainEqual(
        expect.objectContaining({
          relation: "destructures",
          target_node_id: binding!.node_id,
          resolution: "resolved",
        }),
      );
      if (name.startsWith("assigned"))
        expect(trace.unknowns).toContainEqual(
          expect.objectContaining({
            family: "data-flow",
            reason: "unknown-value",
            node_id: binding!.node_id,
            relation_kinds: ["defines"],
          }),
        );
      else
        expect(trace.nodes).toContainEqual(
          expect.objectContaining({
            kind: "literal",
            properties: expect.objectContaining({ value: "strict" }),
          }),
        );
    }
    await client.ping();
    expect(await readFile(filename, "utf8")).toBe(source);
  },
);
