import {
  resolveJavaScriptSemanticEvidence,
  semanticFixtureGraph,
  semanticGraphTestEvidence,
  unknownSemanticGraphTestEvidence,
} from "../../../tests/support/javascriptSemanticGraphFixture.js";
import { describe, expect, it } from "vitest";
import { freezeJsonSnapshot } from "../immutableJson.js";
import { z } from "zod";

import {
  JAVASCRIPT_SEMANTIC_NODE_KINDS,
  JAVASCRIPT_SEMANTIC_RELATION_FAMILIES,
  JAVASCRIPT_SEMANTIC_RELATION_FAMILY,
  type JavaScriptSemanticGraphInput,
  type JavaScriptSemanticGraphNode,
  type JavaScriptSemanticGraphRelation,
} from "./javascriptSemanticGraphSchemas.js";
import {
  createJavaScriptSemanticGraph,
  createJavaScriptSemanticGraphNode,
  createJavaScriptSemanticGraphRelation,
  createJavaScriptSemanticGraphUnknown,
  JavaScriptSemanticEvidenceContextRegistry,
  type JavaScriptSemanticGraph,
} from "./javascriptSemanticGraph.js";
import { queryJavaScriptSemanticGraph } from "./javascriptSemanticQuery.js";
import { javaScriptSemanticQueryInputSchema } from "./javascriptSemanticQuerySchemas.js";
import type { JsonValue } from "../jsonValue.js";

const SHA = "a".repeat(64);
const JAG_ID = `jag_${"b".repeat(64)}`;
const node = (
  kind: (typeof JAVASCRIPT_SEMANTIC_NODE_KINDS)[number],
  role: string,
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
  properties: Record<string, JsonValue> = {},
  functionNodeId: string | null = null,
): JavaScriptSemanticGraphNode =>
  createJavaScriptSemanticGraphNode(
    {
      kind,
      identity: {
        artifact_sha256: SHA,
        module_path: "bundle.js",
        source_range: {
          start: { line: 1, column: role.length },
          end: { line: 1, column: role.length + 1 },
        },
        role_key: role,
      },
      function_node_id: functionNodeId,
      application_node_ids: [],
      label: role,
      properties,
      evidence: semanticGraphTestEvidence(),
    },
    evidenceContexts,
  );

const graphWithCandidateEdge = (): JavaScriptSemanticGraph => {
  const graph = semanticFixtureGraph();
  const input = constructionInput(graph);
  const evidenceContexts = registryForGraph(graph);
  const literal = graph.nodes.find(({ kind }) => kind === "literal");
  const request = graph.nodes.find(({ kind }) => kind === "request");
  if (literal === undefined || request === undefined)
    throw new TypeError("Semantic fixture nodes are missing");
  const candidate = createJavaScriptSemanticGraphRelation(
    {
      source_node_id: literal.node_id,
      target_node_id: request.node_id,
      relation: "supplies-request-field",
      resolution: "candidate",
      properties: { field: "authorization" },
      evidence: semanticGraphTestEvidence("inferred"),
    },
    evidenceContexts,
  );
  return createJavaScriptSemanticGraph({
    ...input,
    evidence_contexts: evidenceContexts.contexts,
    relations: [...input.relations, candidate],
    coverage: {
      ...graph.coverage,
      families: graph.coverage.families.map((family) =>
        family.family === "request"
          ? {
              ...family,
              retained_relations: family.retained_relations + 1,
            }
          : family,
      ),
    },
  });
};

const constructionInput = (
  graph: JavaScriptSemanticGraph,
): JavaScriptSemanticGraphInput => {
  const { graph_id: _graphId, ...input } = graph;
  return input;
};

const registryForGraph = (
  graph: JavaScriptSemanticGraph,
): JavaScriptSemanticEvidenceContextRegistry => {
  const registry = new JavaScriptSemanticEvidenceContextRegistry();
  for (const { evidence: reference } of [
    ...graph.nodes,
    ...graph.relations,
    ...graph.unknowns,
    ...graph.fingerprints,
  ])
    registry.intern(resolveJavaScriptSemanticEvidence(graph, reference));
  return registry;
};

it("does not admit a semantic-node seed absent from the graph", () => {
  const result = queryJavaScriptSemanticGraph(
    semanticFixtureGraph(),
    javaScriptSemanticQueryInputSchema.parse({
      seed: { kind: "semantic-node", node_id: `jsrg_node_${"f".repeat(64)}` },
      direction: "forward-influence",
    }),
  );

  expect(result).toMatchObject({
    status: "no-match",
    seed_node_ids: [],
    nodes: [],
    summary: { total_seed_matches: 0, traversed_nodes: 0 },
  });
});

it("returns reachable influence facts and only their evidence contexts", () => {
  const original = semanticFixtureGraph();
  const evidenceContexts = registryForGraph(original);
  const moduleNode = original.nodes.find(({ kind }) => kind === "module");
  if (moduleNode === undefined)
    throw new Error("Expected the unreachable module");
  const { node_id: _moduleId, evidence, ...moduleInput } = moduleNode;
  const moduleEvidence = resolveJavaScriptSemanticEvidence(original, evidence);
  const unrelated = createJavaScriptSemanticGraphNode(
    {
      ...moduleInput,
      evidence: {
        ...moduleEvidence,
        extractor: { ...moduleEvidence.extractor, name: "unreachable-module" },
      },
    },
    evidenceContexts,
  );
  const graph = createJavaScriptSemanticGraph({
    ...constructionInput(original),
    nodes: original.nodes.map((entry) =>
      entry.node_id === moduleNode.node_id ? unrelated : entry,
    ),
    evidence_contexts: evidenceContexts.contexts,
  });
  const result = queryJavaScriptSemanticGraph(
    graph,
    javaScriptSemanticQueryInputSchema.parse({
      seed: { kind: "literal", value: "TOKEN" },
      direction: "forward-influence",
      expected: { role: "sink", classes: ["request"] },
    }),
  );

  expect(result).toMatchObject({
    status: "found",
    summary: { traversed_nodes: 4, traversed_relations: 3 },
  });
  expect(result.nodes.map(({ kind }) => kind).sort()).toEqual([
    "binding",
    "function",
    "literal",
    "request",
  ]);
  expect(result.relations.map(({ relation }) => relation).sort()).toEqual([
    "captures",
    "constructs-request",
    "defines",
  ]);
  expect(result.expected_match_node_ids).toEqual([
    original.nodes.find(({ kind }) => kind === "request")?.node_id,
  ]);
  expect(result.evidence_contexts).toEqual(
    graph.evidence_contexts.filter(
      ({ context_id }) => context_id !== unrelated.evidence.context_id,
    ),
  );
  for (const fact of [...result.nodes, ...result.relations])
    expect(resolveJavaScriptSemanticEvidence(result, fact.evidence)).toEqual(
      resolveJavaScriptSemanticEvidence(graph, fact.evidence),
    );
});

it("accepts deeply nested semantic properties", () => {
  let nested: JsonValue = "leaf";
  for (let index = 0; index < 12; index += 1)
    nested = { [`level-${String(index)}`]: nested };

  const result = node(
    "binding",
    "deep-properties",
    new JavaScriptSemanticEvidenceContextRegistry(),
    { nested },
  );

  expect(result.properties).toEqual({ nested });
});

it("keeps relevant dynamic frontiers unknown", () => {
  const graph = semanticFixtureGraph(true);
  const result = queryJavaScriptSemanticGraph(
    graph,
    javaScriptSemanticQueryInputSchema.parse({
      seed: { kind: "literal", value: "TOKEN" },
      direction: "forward-influence",
    }),
  );
  expect(result.status).toBe("partial");
  expect(result.coverage.status).toBe("partial");
  expect(result.summary.relevant_unknowns).toBe(1);
  expect(result.unknowns).toEqual(graph.unknowns);
});

it("reports a partial trace when the graph has unknown omission counts", () => {
  const graph = semanticFixtureGraph();
  const partial = createJavaScriptSemanticGraph({
    ...constructionInput(graph),
    coverage: {
      ...graph.coverage,
      status: "partial",
      truncated: true,
      omitted_nodes: null,
      omitted_relations: null,
      limits: [{ name: "nodes", value: 1, unit: "items" }],
    },
    limitations: ["The node ceiling left omission extents unknown."],
  });
  expect(partial.coverage).toMatchObject({
    status: "partial",
    truncated: true,
    omitted_nodes: null,
    omitted_relations: null,
  });
  const result = queryJavaScriptSemanticGraph(
    partial,
    javaScriptSemanticQueryInputSchema.parse({
      seed: { kind: "literal", value: "TOKEN" },
      direction: "forward-influence",
    }),
  );
  expect(result.status).toBe("partial");
});

it("excludes candidate edges unless the caller explicitly opts in", () => {
  const graph = graphWithCandidateEdge();
  const input = {
    seed: { kind: "literal" as const, value: "TOKEN" },
    direction: "forward-influence" as const,
    allowed_relations: ["supplies-request-field" as const],
  };
  const conservative = queryJavaScriptSemanticGraph(
    graph,
    javaScriptSemanticQueryInputSchema.parse(input),
  );
  const optedIn = queryJavaScriptSemanticGraph(
    graph,
    javaScriptSemanticQueryInputSchema.parse({
      ...input,
      include_ambiguous_dynamic_edges: true,
    }),
  );
  expect(conservative.summary.traversed_relations).toBe(0);
  expect(optedIn.summary.traversed_relations).toBe(1);
  expect(conservative.status).toBe("ambiguous");
  expect(conservative.coverage.status).toBe("partial");
  expect(optedIn.status).toBe("ambiguous");
  expect(optedIn.relations).toMatchObject([
    { relation: "supplies-request-field", resolution: "candidate" },
  ]);
});

it("rejects an empty relation selection at the query schema boundary", () => {
  expect(() =>
    javaScriptSemanticQueryInputSchema.parse({
      seed: { kind: "literal", value: "TOKEN" },
      direction: "forward-influence",
      allowed_relations: [],
    }),
  ).toThrow(z.ZodError);
});

it("retains every structural application node linked to one semantic node", () => {
  const evidenceContexts = new JavaScriptSemanticEvidenceContextRegistry();
  const original = node("module", "module", evidenceContexts);
  const linked = createJavaScriptSemanticGraphNode(
    {
      kind: original.kind,
      identity: original.identity,
      function_node_id: original.function_node_id,
      application_node_ids: Array.from(
        { length: 65 },
        (_, index) => `jag_node_${index.toString(16).padStart(64, "0")}`,
      ),
      label: original.label,
      properties: original.properties,
      evidence: evidenceContexts.resolve(original.evidence),
    },
    evidenceContexts,
  );
  expect(linked.application_node_ids).toHaveLength(65);
});

it("retains all explicit unresolved candidate node identifiers", () => {
  const evidenceContexts = new JavaScriptSemanticEvidenceContextRegistry();
  const unknown = createJavaScriptSemanticGraphUnknown(
    {
      node_id: null,
      family: "call-flow",
      relation_kinds: ["calls"],
      reason: "ambiguous-target",
      detail: "All candidate targets are retained.",
      candidate_node_ids: Array.from(
        { length: 1_001 },
        (_, index) => `jsrg_node_${index.toString(16).padStart(64, "0")}`,
      ),
      evidence: unknownSemanticGraphTestEvidence(),
    },
    evidenceContexts,
  );
  expect(unknown.candidate_node_ids).toHaveLength(1_001);
});

const directionalGraph = (
  nodes: readonly JavaScriptSemanticGraphNode[],
  relations: readonly JavaScriptSemanticGraphRelation[],
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
  partial = false,
): JavaScriptSemanticGraph =>
  createJavaScriptSemanticGraph({
    schema: "JavaScriptSemanticRelationGraph",
    root_artifact_sha256: SHA,
    application_graph_id: JAG_ID,
    root_node_ids: nodes.slice(0, 1).map(({ node_id }) => node_id),
    evidence_contexts: evidenceContexts.contexts,
    nodes: [...nodes],
    relations: [...relations],
    fingerprints: [],
    unknowns: [],
    coverage: {
      status: partial ? "partial" : "complete",
      truncated: false,
      omitted_nodes: partial ? 1 : 0,
      omitted_relations: 0,
      limits: [],
      families: JAVASCRIPT_SEMANTIC_RELATION_FAMILIES.map((family) => ({
        family,
        status: "complete",
        retained_relations: relations.filter(
          ({ relation }) =>
            JAVASCRIPT_SEMANTIC_RELATION_FAMILY[relation] === family,
        ).length,
        omitted_relations: 0,
        unknown_ids: [],
      })),
    },
    limitations: partial ? ["One source graph node was omitted."] : [],
  });

const relationBetween = (
  source: JavaScriptSemanticGraphNode,
  target: JavaScriptSemanticGraphNode,
  relation: JavaScriptSemanticGraphRelation["relation"],
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
  resolution: JavaScriptSemanticGraphRelation["resolution"] = "resolved",
) =>
  createJavaScriptSemanticGraphRelation(
    {
      source_node_id: source.node_id,
      target_node_id: target.node_id,
      relation,
      resolution,
      properties: {},
      evidence: semanticGraphTestEvidence("inferred"),
    },
    evidenceContexts,
  );

it.each([
  {
    direction: "forward-influence",
    relation: "calls",
    incoming: true,
    relevant: false,
  },
  {
    direction: "forward-influence",
    relation: "calls",
    incoming: false,
    relevant: true,
  },
  {
    direction: "backward-provenance",
    relation: "calls",
    incoming: false,
    relevant: false,
  },
  {
    direction: "backward-provenance",
    relation: "calls",
    incoming: true,
    relevant: true,
  },
  { direction: "callers", relation: "reads", incoming: true, relevant: false },
  { direction: "callers", relation: "calls", incoming: false, relevant: false },
  { direction: "callers", relation: "calls", incoming: true, relevant: true },
  {
    direction: "ownership",
    relation: "reads",
    incoming: false,
    relevant: false,
  },
  { direction: "ownership", relation: "owns", incoming: false, relevant: true },
  { direction: "ownership", relation: "owns", incoming: true, relevant: true },
] as const)(
  "limits $direction ambiguity to traversable $relation candidates (incoming=$incoming)",
  ({ direction, relation, incoming, relevant }) => {
    const evidenceContexts = new JavaScriptSemanticEvidenceContextRegistry();
    const seed = node("function", "directional-seed", evidenceContexts);
    const reached = node("function", "directional-reached", evidenceContexts);
    const other = node("function", "directional-other", evidenceContexts);
    const reverse =
      direction === "callers" || direction === "backward-provenance";
    const resolved = relationBetween(
      reverse ? reached : seed,
      reverse ? seed : reached,
      direction === "ownership" ? "owns" : "calls",
      evidenceContexts,
    );
    const candidate = relationBetween(
      incoming ? other : reached,
      incoming ? reached : other,
      relation,
      evidenceContexts,
      "candidate",
    );
    const nodes = [seed, reached, other];
    const control = queryJavaScriptSemanticGraph(
      directionalGraph(nodes, [resolved], evidenceContexts),
      javaScriptSemanticQueryInputSchema.parse({
        seed: { kind: "semantic-node", node_id: seed.node_id },
        direction,
      }),
    );
    expect(control).toMatchObject({
      status: "found",
      coverage: { status: "complete" },
    });
    for (const include of [false, true]) {
      const result = queryJavaScriptSemanticGraph(
        directionalGraph(nodes, [resolved, candidate], evidenceContexts),
        javaScriptSemanticQueryInputSchema.parse({
          seed: { kind: "semantic-node", node_id: seed.node_id },
          direction,
          include_ambiguous_dynamic_edges: include,
        }),
      );
      expect(result).toMatchObject({
        status: relevant ? "ambiguous" : "found",
        coverage: { status: relevant ? "partial" : "complete" },
      });
      if (!relevant || !include) {
        expect(result.nodes).toEqual(control.nodes);
        expect(result.relations).toEqual(control.relations);
      } else {
        expect(result.nodes).toHaveLength(3);
        expect(result.relations).toContainEqual(
          expect.objectContaining({
            source_node_id: candidate.source_node_id,
            target_node_id: candidate.target_node_id,
            relation: candidate.relation,
            resolution: candidate.resolution,
          }),
        );
      }
    }
  },
);

it("excludes explicitly filtered candidates without hiding partial graph coverage", () => {
  const evidenceContexts = new JavaScriptSemanticEvidenceContextRegistry();
  const seed = node("function", "filtered-seed", evidenceContexts);
  const other = node("function", "filtered-other", evidenceContexts);
  const candidate = relationBetween(
    seed,
    other,
    "reads",
    evidenceContexts,
    "candidate",
  );
  for (const partial of [false, true]) {
    const result = queryJavaScriptSemanticGraph(
      directionalGraph([seed, other], [candidate], evidenceContexts, partial),
      javaScriptSemanticQueryInputSchema.parse({
        seed: { kind: "semantic-node", node_id: seed.node_id },
        direction: "forward-influence",
        allowed_relations: ["calls"],
      }),
    );
    expect(result).toMatchObject({
      status: "found",
      coverage: { status: partial ? "partial" : "complete" },
      relations: [],
    });
  }
});

it("keeps candidate uncertainty at the end of a long reachable path", () => {
  const evidenceContexts = new JavaScriptSemanticEvidenceContextRegistry();
  const chain = Array.from({ length: 72 }, (_, index) =>
    node("binding", `candidate-chain-${index}`, evidenceContexts),
  );
  const relations = chain.slice(1).map((target, index) => {
    const source = chain[index];
    if (source === undefined) throw new TypeError("Missing chain source");
    return relationBetween(
      source,
      target,
      "reads",
      evidenceContexts,
      index === 70 ? "candidate" : "resolved",
    );
  });
  const seed = chain[0];
  if (seed === undefined) throw new TypeError("Missing chain seed");
  for (const include of [false, true]) {
    const result = queryJavaScriptSemanticGraph(
      directionalGraph(chain, relations, evidenceContexts),
      javaScriptSemanticQueryInputSchema.parse({
        seed: { kind: "semantic-node", node_id: seed.node_id },
        direction: "forward-influence",
        include_ambiguous_dynamic_edges: include,
      }),
    );
    expect(result).toMatchObject({
      status: "ambiguous",
      coverage: { status: "partial" },
      summary: {
        traversed_nodes: include ? 72 : 71,
        traversed_relations: include ? 71 : 70,
      },
    });
    const reachable = include ? chain : chain.slice(0, -1);
    expect(result.nodes.map(({ node_id }) => node_id).toSorted()).toEqual(
      reachable.map(({ node_id }) => node_id).toSorted(),
    );
  }
});

describe("immutable SemanticGraphIndex parity and empty seed fast-exit", () => {
  it("matches mutable query results across seed kinds and directions", () => {
    const mutable = graphWithCandidateEdge();
    const immutable = freezeJsonSnapshot(structuredClone(mutable));
    const seedNode = mutable.nodes[0];
    const literalNode = mutable.nodes.find(({ kind }) => kind === "literal");
    if (seedNode === undefined || literalNode === undefined)
      throw new TypeError("Missing fixture nodes");

    const queries = [
      { kind: "semantic-node", node_id: seedNode.node_id },
      {
        kind: "literal",
        value: literalNode.properties.value ?? literalNode.label ?? "",
      },
      { kind: "property", name: "token" },
      { kind: "endpoint", value: "https://example.invalid" },
      { kind: "boundary-field", field: "authorization" },
    ] as const;

    for (const seed of queries)
      for (const direction of [
        "backward-provenance",
        "forward-influence",
        "callers",
        "ownership",
      ] as const) {
        const input = javaScriptSemanticQueryInputSchema.parse({
          seed,
          direction,
          include_ambiguous_dynamic_edges: true,
        });
        const expected = queryJavaScriptSemanticGraph(mutable, input);
        expect(queryJavaScriptSemanticGraph(immutable, input)).toEqual(
          expected,
        );
        expect(queryJavaScriptSemanticGraph(immutable, input)).toEqual(
          expected,
        );
      }
  });

  it("fast-exits on empty seed match while retaining only graph-wide unknowns", () => {
    const original = semanticFixtureGraph(true);
    const evidenceContexts = registryForGraph(original);
    const existing = original.nodes[0];
    const baseUnknown = original.unknowns[0];
    if (existing === undefined || baseUnknown === undefined)
      throw new TypeError("Missing fixture node or unknown");
    const nodeUnknown = createJavaScriptSemanticGraphUnknown(
      {
        family: baseUnknown.family,
        relation_kinds: baseUnknown.relation_kinds,
        reason: baseUnknown.reason,
        detail: "Scoped to node",
        node_id: existing.node_id,
        candidate_node_ids: [],
        evidence: unknownSemanticGraphTestEvidence(),
      },
      evidenceContexts,
    );
    const globalUnknown = createJavaScriptSemanticGraphUnknown(
      {
        family: baseUnknown.family,
        relation_kinds: baseUnknown.relation_kinds,
        reason: baseUnknown.reason,
        detail: "Graph-wide unknown",
        node_id: null,
        candidate_node_ids: [],
        evidence: unknownSemanticGraphTestEvidence(),
      },
      evidenceContexts,
    );
    const mutable = createJavaScriptSemanticGraph({
      ...constructionInput(original),
      unknowns: [...original.unknowns, nodeUnknown, globalUnknown],
      coverage: {
        ...original.coverage,
        families: original.coverage.families.map((family) =>
          family.family === baseUnknown.family
            ? {
                ...family,
                unknown_ids: [
                  ...family.unknown_ids,
                  nodeUnknown.unknown_id,
                  globalUnknown.unknown_id,
                ],
              }
            : family,
        ),
      },
      evidence_contexts: evidenceContexts.contexts,
    });
    const immutable = freezeJsonSnapshot(structuredClone(mutable));
    const missInput = javaScriptSemanticQueryInputSchema.parse({
      seed: {
        kind: "semantic-node",
        node_id: `jsrg_node_${"f".repeat(64)}`,
      },
      direction: "forward-influence",
    });
    const mutableRes = queryJavaScriptSemanticGraph(mutable, missInput);
    const immutableRes = queryJavaScriptSemanticGraph(immutable, missInput);
    expect(immutableRes).toEqual(mutableRes);
    const ids = immutableRes.unknowns.map((u) => u.unknown_id);
    expect(ids).toContain(globalUnknown.unknown_id);
    expect(ids).not.toContain(nodeUnknown.unknown_id);
  });
});
