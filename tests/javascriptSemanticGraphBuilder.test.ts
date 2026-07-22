import { describe, expect, it } from "vitest";

import { buildJavaScriptSemanticGraph } from "../src/application/JavaScriptSemanticGraphBuilder.js";
import type { JavaScriptArtifactAnalysis } from "../src/application/JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../src/application/JavaScriptArtifactFiles.js";
import { queryJavaScriptSemanticGraph } from "../src/domain/javascriptSemanticQuery.js";
import { analyzeJavaScriptSemantics } from "../src/domain/javascriptSemanticAnalysis.js";
import {
  DEFAULT_JAVASCRIPT_SEMANTIC_LIMITS,
  type JavaScriptSemanticLimits,
} from "../src/domain/javascriptSemanticIr.js";

const SHA256 = "a".repeat(64);
const GRAPH_ID = `jag_${"b".repeat(64)}`;

describe("JavaScript semantic companion graph", () => {
  it("projects closure and direct interprocedural flow without execution", () => {
    const graph = graphFor(`
      const outer = 2;
      function add(value) { return value + outer; }
      const input = 40;
      const answer = add(input);
    `);

    const relations = new Set(graph.relations.map(({ relation }) => relation));
    for (const expected of [
      "argument-to-parameter",
      "calls",
      "captures",
      "defines",
      "reads",
      "returns-to-call",
    ] as const)
      expect(relations.has(expected)).toBe(true);
    expect(graph.coverage.families).toHaveLength(12);
    expect(graph.limitations).toContain(
      "The semantic graph contains static syntax observations and conservative relationship candidates; it does not claim runtime execution.",
    );
    const parameter = graph.nodes.find(
      ({ kind, label }) => kind === "parameter" && label === "value",
    );
    if (parameter === undefined) throw new Error("Expected parameter node");
    const provenance = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: parameter.node_id },
      direction: "backward-provenance",
      include_ambiguous_dynamic_edges: true,
    });
    expect(provenance.relations.map(({ relation }) => relation)).toEqual(
      expect.arrayContaining([
        "aliases",
        "argument-to-parameter",
        "defines",
        "reads",
      ]),
    );
  });

  it("keeps dynamic calls explicit and returns bounded deterministic pages", () => {
    const graph = graphFor(`
      const handlers = { ready() { return 1; } };
      const key = process.argv[2];
      handlers[key]();
    `);
    expect(graph.unknowns.some(({ reason }) => reason === "dynamic-call")).toBe(
      true,
    );
    const seedNodeId = graph.relations.find(
      ({ relation }) => relation === "defines",
    )?.source_node_id;
    expect(seedNodeId).toBeDefined();
    if (seedNodeId === undefined) throw new Error("Expected a definition seed");

    const first = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: seedNodeId },
      direction: "forward-influence",
      include_ambiguous_dynamic_edges: true,
      limits: {
        max_seed_matches: 25,
        max_nodes: 2_000,
        max_edges: 4_000,
        max_depth: 12,
        max_functions: 500,
        max_modules: 500,
        page_size: 1,
      },
    });
    const repeated = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: seedNodeId },
      direction: "forward-influence",
      include_ambiguous_dynamic_edges: true,
      limits: first.applied_limits,
    });
    expect(repeated).toEqual(first);
  });

  it("keeps ambiguous interprocedural flow out of the default traversal", () => {
    const graph = graphFor(`
      function left(value) { return value; }
      function right(value) { return value; }
      const input = 1;
      const selected = Math.random() ? left : right;
      selected(input);
    `);
    const input = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "input",
    );
    if (input === undefined) throw new Error("Expected input binding");
    const query = {
      seed: { kind: "semantic-node" as const, node_id: input.node_id },
      direction: "forward-influence" as const,
      allowed_relations: [
        "reads" as const,
        "aliases" as const,
        "argument-to-parameter" as const,
      ],
    };
    const strict = queryJavaScriptSemanticGraph(graph, query);
    expect(
      strict.relations.some(
        ({ relation }) => relation === "argument-to-parameter",
      ),
    ).toBe(false);
    expect(strict.status).toBe("ambiguous");
    const admitted = queryJavaScriptSemanticGraph(graph, {
      ...query,
      include_ambiguous_dynamic_edges: true,
    });
    expect(
      admitted.relations.filter(
        ({ relation }) => relation === "argument-to-parameter",
      ),
    ).toHaveLength(2);
    expect(admitted.status).toBe("ambiguous");
  });

  it("connects caller results, direct returns, parameters, and captures", () => {
    const graph = graphFor(`
      const outer = 2;
      function identity(value) { return value; }
      function readOuter() { return outer; }
      const input = 40;
      const output = identity(input);
    `);
    const binding = (label: string) =>
      graph.nodes.find(
        ({ kind, label: nodeLabel }) =>
          ["binding", "parameter"].includes(kind) && nodeLabel === label,
      );
    const output = binding("output");
    const input = binding("input");
    const outer = binding("outer");
    const readOuter = graph.nodes.find(
      ({ kind, label }) => kind === "function" && label === "readOuter",
    );
    if (
      output === undefined ||
      input === undefined ||
      outer === undefined ||
      readOuter === undefined
    )
      throw new Error("Expected semantic flow nodes");
    const provenance = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: output.node_id },
      direction: "backward-provenance",
    });
    expect(provenance.nodes.map(({ node_id }) => node_id)).toContain(
      input.node_id,
    );
    const influence = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: outer.node_id },
      direction: "forward-influence",
      allowed_relations: ["captures"],
    });
    expect(influence.nodes.map(({ node_id }) => node_id)).toContain(
      readOuter.node_id,
    );
    const capture = graph.relations.find(
      ({ relation }) => relation === "captures",
    );
    expect(capture?.evidence.location).toMatchObject({
      available: true,
      value: { kind: "source-range", source: "app.js" },
    });
    expect(capture?.evidence.location).not.toEqual(readOuter.evidence.location);
  });

  it("preserves semantic analyzer truncation in graph coverage", () => {
    const graph = graphFor(
      "const first = 1; const second = first; const third = second;",
      { maxReferences: 1 },
    );
    expect(graph.coverage).toMatchObject({
      status: "partial",
      truncated: true,
      omitted_nodes: null,
      omitted_relations: null,
      limits: expect.arrayContaining([
        { name: "semantic.maxReferences", value: 1, unit: "items" },
      ]),
    });
    expect(
      graph.coverage.families.find(
        ({ family }) => family === "promise-ownership",
      ),
    ).toMatchObject({ status: "unsupported", retained_relations: 0 });
  });

  it("does not promote transformed return expressions to resolved aliases", () => {
    const graph = graphFor(`
      function increment(value) { return value + 1; }
      const input = 1;
      const output = increment(input);
    `);
    const returnNode = graph.nodes.find(({ kind }) => kind === "return-site");
    if (returnNode === undefined) throw new Error("Expected return site");
    expect(
      graph.relations.filter(
        ({ relation, target_node_id }) =>
          relation === "aliases" && target_node_id === returnNode.node_id,
      ),
    ).toEqual([expect.objectContaining({ resolution: "candidate" })]);
    const output = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "output",
    );
    const input = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "input",
    );
    if (output === undefined || input === undefined)
      throw new Error("Expected caller bindings");
    const strict = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: output.node_id },
      direction: "backward-provenance",
    });
    expect(strict.nodes.map(({ node_id }) => node_id)).not.toContain(
      input.node_id,
    );
    expect(strict.status).toBe("ambiguous");
  });

  it("uses unavailable evidence when no source produced semantic IR", () => {
    const graph = buildJavaScriptSemanticGraph({
      rootArtifactSha256: SHA256,
      applicationGraph: { graph_id: GRAPH_ID, nodes: [] },
      analysis: emptyAnalysis(),
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.evidence).toMatchObject({
      authority: "unknown",
      state: "unavailable",
      location: { available: false, reason: "not-observed" },
    });
  });
});

const emptyAnalysis = (): JavaScriptArtifactAnalysis => ({
  files: [],
  packages: [],
  json_modules: [],
  html_scripts: [],
  source_maps: [],
  visited_ast_nodes: 0,
  findings: 0,
  modules: 0,
  parse_failures: 0,
  truncated_scopes: 0,
  limitations: [],
});

const graphFor = (
  source: string,
  inputLimits: Partial<JavaScriptSemanticLimits> = {},
) => {
  const file: JavaScriptArtifactFile = {
    path: "app.js",
    container_sha256: SHA256,
    sha256: SHA256,
    bytes: Buffer.byteLength(source),
    inventory_artifact_id: `art_${SHA256}`,
    kind: "javascript",
    unpacked: false,
    text: { included: true, value: source },
  };
  const semanticLimits = {
    ...DEFAULT_JAVASCRIPT_SEMANTIC_LIMITS,
    ...inputLimits,
  };
  const analysis: JavaScriptArtifactAnalysis = {
    files: [
      {
        file,
        javascript: null,
        semantic: {
          ir: analyzeJavaScriptSemantics(source, inputLimits),
          limits: semanticLimits,
        },
      },
    ],
    packages: [],
    json_modules: [],
    html_scripts: [],
    source_maps: [],
    visited_ast_nodes: 0,
    findings: 0,
    modules: 0,
    parse_failures: 0,
    truncated_scopes: 0,
    limitations: [],
  };
  return buildJavaScriptSemanticGraph({
    rootArtifactSha256: SHA256,
    applicationGraph: { graph_id: GRAPH_ID, nodes: [] },
    analysis,
  });
};
