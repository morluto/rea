import { BINARY_LAYOUT_TEST_PROVIDER } from "./binaryDiagnostics/layout.js";
import { binaryLayoutFixture } from "./binaryDiagnostics/layout.js";
import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "../../src/contracts/javascript/javascriptRuntimeReconciliationExample.js";
import { createEvidence, type Evidence } from "../../src/domain/evidence.js";
import type { JavaScriptApplicationAnalysisResult } from "../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { javascriptApplicationAnalysisResultSchema } from "../../src/domain/javascript/javascriptApplicationAnalysis.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "../../src/domain/javascript/javascriptApplicationGraph.js";
import type { BinaryLayout } from "../../src/domain/native/binaryLayout.js";
import { binaryLayoutSchema } from "../../src/domain/native/binaryLayout.js";

const hex = (value: number): string =>
  value === 0 ? "0x0" : `0x${value.toString(16)}`;

const layoutName = (display: string, offset: number) => ({
  display,
  bytes_base64: Buffer.from(display, "utf8").toString("base64"),
  location: { offset: hex(offset), bytes: hex(display.length + 1) },
  unknown_reason: null,
});

const layoutSection = (
  index: number,
  display: string,
  nameOffset: number,
): BinaryLayout["sections"][number] => ({
  index,
  name: layoutName(display, nameOffset),
  name_offset: hex(nameOffset),
  type: 1,
  header_location: { offset: hex(index * 16), bytes: "0x10" },
  address: "0x0",
  offset: hex(64 + index * 16),
  size: "0x10",
  alignment: "0x1",
  flags: "0x6",
  link: 0,
  info: 0,
  entry_size: "0x0",
  file_backing: "file",
});

const layoutSymbol = (
  entryIndex: number,
  display: string,
  nameOffset: number,
): BinaryLayout["symbols"][number] => ({
  table_index: 0,
  entry_index: entryIndex,
  name: layoutName(display, nameOffset),
  name_offset: hex(nameOffset),
  location: { offset: hex(nameOffset), bytes: hex(display.length + 1) },
  value: "0x0",
  value_meaning: "no-address",
  size: "0x0",
  binding: 1,
  type: 2,
  visibility: 0,
  section_index: 1,
});

/** Layout fixture with duplicate section/symbol names for selected-view tests. */
export const analysisViewLayoutFixture = (): BinaryLayout =>
  binaryLayoutSchema.parse({
    ...binaryLayoutFixture("/artifacts/view-source.elf"),
    artifact: {
      path: "/artifacts/view-source.elf",
      sha256: "b".repeat(64),
      bytes: 512,
    },
    sections: [
      layoutSection(0, ".text", 256),
      layoutSection(1, ".text", 262),
      layoutSection(2, ".data", 268),
    ],
    symbols: [
      layoutSymbol(0, "main", 280),
      layoutSymbol(1, "main", 285),
      layoutSymbol(2, "start", 290),
    ],
  });

/** Wrap a layout observation as inspect_binary_layout Evidence. */
export const analysisViewLayoutEvidence = (
  layout: BinaryLayout = analysisViewLayoutFixture(),
): Evidence =>
  createEvidence(
    {
      path: layout.artifact.path,
      format: "elf",
      architecture: "x86_64",
      sha256: layout.artifact.sha256,
    },
    BINARY_LAYOUT_TEST_PROVIDER,
    {
      operation: "inspect_binary_layout",
      parameters: { path: layout.artifact.path },
      result: layout,
      rawResult: layout,
      confidence: "observed",
      limitations: layout.limitations,
      locations: [{ kind: "artifact-path", path: layout.artifact.path }],
    },
  );

/** Minimal authenticated JavaScript application analysis used by view tests. */
export const analysisViewJavaScriptAnalysis =
  (): JavaScriptApplicationAnalysisResult =>
    javascriptApplicationAnalysisResultSchema.parse(
      JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.normalized_result,
    );

/** Application analysis whose module observations include source text. */
export const analysisViewJavaScriptAnalysisWithSource =
  (): JavaScriptApplicationAnalysisResult => {
    const analysis = analysisViewJavaScriptAnalysis();
    const original = analysis.graph.nodes[0];
    if (original === undefined)
      throw new Error("JavaScript application example is missing its module");
    const withSource = createJavaScriptApplicationNode({
      kind: original.kind,
      identity: original.identity,
      observations: original.observations.map((observation) => ({
        label: observation.label,
        properties: {
          ...observation.properties,
          source: "export const secret = 1;\n",
          text: "should not leak",
        },
        evidence: observation.evidence,
      })),
    });
    const graph = createJavaScriptApplicationGraph({
      schema: "JavaScriptApplicationGraph",
      root_node_ids: [withSource.node_id],
      nodes: [withSource],
      edges: [],
      coverage: analysis.graph.coverage,
      limitations: analysis.graph.limitations,
    });
    return javascriptApplicationAnalysisResultSchema.parse({
      ...analysis,
      graph,
      semantic_graph: {
        ...analysis.semantic_graph,
        application_graph_id: graph.graph_id,
      },
    });
  };

/** Wrap JavaScript application analysis as producer Evidence. */
export const analysisViewJavaScriptEvidence = (
  analysis: JavaScriptApplicationAnalysisResult = analysisViewJavaScriptAnalysis(),
): Evidence =>
  createEvidence(
    {
      path: analysis.input_path,
      format: analysis.format,
      sha256: analysis.root_artifact_sha256,
    },
    {
      id: "rea-javascript-application",
      name: "REA JavaScript application analyzer",
      version: "1",
    },
    {
      predicateType: "rea.javascript-application-analysis",
      operation: "analyze_javascript_application",
      parameters: { input_path: analysis.input_path, format: analysis.format },
      result: analysis,
      confidence: "derived",
      authority: "shipped-artifact",
      limitations: analysis.limitations,
    },
  );
