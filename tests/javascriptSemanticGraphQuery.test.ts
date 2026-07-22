import { describe, expect, it } from "vitest";

import type { ApplicationGraphEvidence } from "../src/domain/javascriptApplicationEvidenceSchemas.js";
import {
  JAVASCRIPT_SEMANTIC_NODE_KINDS,
  JAVASCRIPT_SEMANTIC_RELATION_FAMILIES,
  JAVASCRIPT_SEMANTIC_RELATIONS,
} from "../src/domain/javascriptSemanticGraphSchemas.js";
import {
  createJavaScriptSemanticFingerprint,
  createJavaScriptSemanticGraph,
  createJavaScriptSemanticGraphNode,
  createJavaScriptSemanticGraphRelation,
  createJavaScriptSemanticGraphUnknown,
  parseJavaScriptSemanticGraph,
  serializeJavaScriptSemanticGraph,
  type JavaScriptSemanticGraph,
  type JavaScriptSemanticGraphNode,
} from "../src/domain/javascriptSemanticGraph.js";
import { queryJavaScriptSemanticGraph } from "../src/domain/javascriptSemanticQuery.js";
import { javaScriptSemanticQueryInputSchema } from "../src/domain/javascriptSemanticQuerySchemas.js";

const SHA = "a".repeat(64);
const JAG_ID = `jag_${"b".repeat(64)}`;
const completeCoverage = {
  status: "complete" as const,
  truncated: false,
  omitted_count: 0,
  limits: [],
};

const evidence = (
  state: "observed" | "inferred" = "observed",
): ApplicationGraphEvidence => ({
  authority:
    state === "observed"
      ? "ast-static-analysis"
      : "static-relationship-inference",
  state,
  confidence: state === "observed" ? "exact" : "high",
  artifact: { available: true, artifact_id: `art_${SHA}`, sha256: SHA },
  location: {
    available: true,
    value: {
      kind: "source-range",
      source: "bundle.js",
      start: { line: 1, column: 0 },
      end: { line: 1, column: 10 },
    },
  },
  extractor: {
    name: "test",
    version: "1",
    operation: "recover-semantic-relation",
    executable_sha256: null,
  },
  coverage: completeCoverage,
  limitations:
    state === "observed"
      ? []
      : ["Static reachability does not prove runtime execution."],
  evidence_ids: [],
});

const unknownEvidence = (): ApplicationGraphEvidence => ({
  authority: "unknown",
  state: "unknown",
  confidence: "unknown",
  artifact: {
    available: false,
    reason: "unknown",
    detail: "Unknown artifact.",
  },
  location: {
    available: false,
    reason: "unresolved",
    detail: "Dynamic call target.",
  },
  extractor: {
    name: "test",
    version: "1",
    operation: "retain-dynamic-call",
    executable_sha256: null,
  },
  coverage: {
    status: "unknown",
    truncated: false,
    omitted_count: null,
    limits: [],
  },
  limitations: ["Dynamic call target remains unknown."],
  evidence_ids: [],
});

const node = (
  kind: (typeof JAVASCRIPT_SEMANTIC_NODE_KINDS)[number],
  role: string,
  properties: Record<string, string | number | boolean | null> = {},
  functionNodeId: string | null = null,
): JavaScriptSemanticGraphNode =>
  createJavaScriptSemanticGraphNode({
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
    evidence: evidence(),
  });

const fixtureGraph = (withUnknown = false): JavaScriptSemanticGraph => {
  const module = node("module", "module");
  const literal = node("literal", "literal", { value: "TOKEN" });
  const binding = node("binding", "binding");
  const callable = node("function", "function");
  const request = node("request", "request", {
    endpoint: "https://example.invalid/v1",
  });
  const relations = [
    createJavaScriptSemanticGraphRelation({
      source_node_id: literal.node_id,
      target_node_id: binding.node_id,
      relation: "defines",
      resolution: "resolved",
      properties: {},
      evidence: evidence("inferred"),
    }),
    createJavaScriptSemanticGraphRelation({
      source_node_id: binding.node_id,
      target_node_id: callable.node_id,
      relation: "captures",
      resolution: "resolved",
      properties: {},
      evidence: evidence("inferred"),
    }),
    createJavaScriptSemanticGraphRelation({
      source_node_id: callable.node_id,
      target_node_id: request.node_id,
      relation: "constructs-request",
      resolution: "resolved",
      properties: {},
      evidence: evidence("inferred"),
    }),
  ];
  const dynamic = createJavaScriptSemanticGraphUnknown({
    node_id: callable.node_id,
    family: "call-flow",
    relation_kinds: ["calls"],
    reason: "dynamic-call",
    detail: "Computed callee is unresolved.",
    candidate_node_ids: [],
    evidence: unknownEvidence(),
  });
  const unknowns = withUnknown ? [dynamic] : [];
  const coverageFamilies = JAVASCRIPT_SEMANTIC_RELATION_FAMILIES.map(
    (family) => ({
      family,
      status:
        withUnknown && family === "call-flow"
          ? ("unknown" as const)
          : ("complete" as const),
      retained_relations: relations.filter(({ relation }) =>
        relation === "defines"
          ? family === "data-flow"
          : relation === "captures"
            ? family === "closure"
            : family === "request",
      ).length,
      omitted_relations: withUnknown && family === "call-flow" ? null : 0,
      unknown_ids:
        withUnknown && family === "call-flow" ? [dynamic.unknown_id] : [],
    }),
  );
  const fingerprint = createJavaScriptSemanticFingerprint({
    function_node_id: callable.node_id,
    algorithm: "rea.javascript-semantic-function/v1",
    status: "complete",
    components: {
      parameter_arity: 0,
      normalized_ast_sha256: "1".repeat(64),
      control_flow_sha256: "2".repeat(64),
      relation_shape_sha256: "3".repeat(64),
      literal_set_sha256: "4".repeat(64),
      effects: ["network"],
    },
    limitations: [],
    evidence: evidence("inferred"),
  });
  return createJavaScriptSemanticGraph({
    schema: "JavaScriptSemanticRelationGraph",
    schema_version: 1,
    root_artifact_sha256: SHA,
    application_graph_id: JAG_ID,
    root_node_ids: [module.node_id],
    nodes: [request, callable, binding, literal, module],
    relations,
    fingerprints: [fingerprint],
    unknowns,
    coverage: {
      status: withUnknown ? "partial" : "complete",
      truncated: false,
      omitted_nodes: withUnknown ? null : 0,
      omitted_relations: withUnknown ? null : 0,
      limits: [],
      families: coverageFamilies,
    },
    limitations: withUnknown ? ["Dynamic call target remains unknown."] : [],
  });
};

const graphWithCandidateEdge = (): JavaScriptSemanticGraph => {
  const graph = fixtureGraph();
  const literal = graph.nodes.find(({ kind }) => kind === "literal");
  const request = graph.nodes.find(({ kind }) => kind === "request");
  if (literal === undefined || request === undefined)
    throw new TypeError("Semantic fixture nodes are missing");
  const candidate = createJavaScriptSemanticGraphRelation({
    source_node_id: literal.node_id,
    target_node_id: request.node_id,
    relation: "supplies-request-field",
    resolution: "candidate",
    properties: { field: "authorization" },
    evidence: evidence("inferred"),
  });
  const { graph_id: _graphId, ...input } = graph;
  return createJavaScriptSemanticGraph({
    ...input,
    relations: [...graph.relations, candidate],
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

const graphWithDuplicateLiteral = (): JavaScriptSemanticGraph => {
  const graph = fixtureGraph();
  const duplicate = node("literal", "literal-copy", { value: "TOKEN" });
  const { graph_id: _graphId, ...input } = graph;
  return createJavaScriptSemanticGraph({
    ...input,
    nodes: [...graph.nodes, duplicate],
  });
};

describe("JavaScript semantic relation graph", () => {
  it("defines every required v1 relation family and canonicalizes records", () => {
    expect(JAVASCRIPT_SEMANTIC_RELATIONS).toContain("argument-to-parameter");
    expect(JAVASCRIPT_SEMANTIC_RELATIONS).toContain("detaches-task");
    expect(JAVASCRIPT_SEMANTIC_RELATIONS).toContain("forwards-signal");
    expect(JAVASCRIPT_SEMANTIC_RELATIONS).toContain("validates");
    const graph = fixtureGraph();
    expect(
      parseJavaScriptSemanticGraph(
        JSON.parse(serializeJavaScriptSemanticGraph(graph)),
      ),
    ).toEqual(graph);
    expect(graph.nodes.map(({ node_id }) => node_id)).toEqual(
      graph.nodes.map(({ node_id }) => node_id).toSorted(),
    );
  });

  it("rejects stale identities, dangling endpoints, and incomplete coverage claims", () => {
    const graph = fixtureGraph();
    const { graph_id: _graphId, ...graphInput } = graph;
    expect(() =>
      parseJavaScriptSemanticGraph({
        ...graph,
        graph_id: `jsrg_${"0".repeat(64)}`,
      }),
    ).toThrow();
    expect(() =>
      createJavaScriptSemanticGraph({
        ...graphInput,
        relations: [
          {
            ...graph.relations[0],
            target_node_id: `jsrg_node_${"f".repeat(64)}`,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createJavaScriptSemanticGraph({
        ...graphInput,
        coverage: { ...graph.coverage, omitted_nodes: 1 },
      }),
    ).toThrow(/Complete graph coverage/u);
  });
});

describe("JavaScript semantic query", () => {
  it("traces deterministic forward influence and pages without changing identity", () => {
    const graph = fixtureGraph();
    const input = {
      seed: { kind: "literal" as const, value: "TOKEN" },
      direction: "forward-influence" as const,
      expected: { role: "sink" as const, classes: ["request" as const] },
      limits: {
        max_seed_matches: 25,
        max_nodes: 20,
        max_edges: 20,
        max_depth: 12,
        max_functions: 10,
        max_modules: 10,
        page_size: 2,
      },
    };
    const first = queryJavaScriptSemanticGraph(graph, input);
    expect(first).toMatchObject({
      status: "found",
      summary: { traversed_nodes: 4, traversed_relations: 3 },
      page: { offset: 0, size: 2 },
    });
    expect(first.expected_match_node_ids).toHaveLength(1);
    expect(first.page.next_cursor).not.toBeNull();
    const second = queryJavaScriptSemanticGraph(graph, {
      ...input,
      cursor: first.page.next_cursor,
    });
    expect(second.query_id).toBe(first.query_id);
    expect(second.page).toMatchObject({
      offset: 2,
      size: 1,
      next_cursor: null,
    });
    expect(second.relations[0]?.relation_id).not.toBe(
      first.relations[0]?.relation_id,
    );
  });

  it("keeps relevant dynamic frontiers unknown", () => {
    const result = queryJavaScriptSemanticGraph(fixtureGraph(true), {
      seed: { kind: "literal", value: "TOKEN" },
      direction: "forward-influence",
    });
    expect(result.status).toBe("partial");
    expect(result.coverage.status).toBe("partial");
    expect(result.unknowns).toMatchObject([
      { reason: "dynamic-call", relation_kinds: ["calls"] },
    ]);
  });

  it("excludes candidate edges unless the caller explicitly opts in", () => {
    const graph = graphWithCandidateEdge();
    const input = {
      seed: { kind: "literal" as const, value: "TOKEN" },
      direction: "forward-influence" as const,
      allowed_relations: ["supplies-request-field" as const],
    };
    const conservative = queryJavaScriptSemanticGraph(graph, input);
    const optedIn = queryJavaScriptSemanticGraph(graph, {
      ...input,
      include_ambiguous_dynamic_edges: true,
    });
    expect(conservative.summary.traversed_relations).toBe(0);
    expect(optedIn.summary.traversed_relations).toBe(1);
    expect(conservative.status).toBe("ambiguous");
    expect(conservative.coverage.status).toBe("partial");
    expect(optedIn.status).toBe("ambiguous");
    expect(optedIn.relations).toMatchObject([
      { relation: "supplies-request-field", resolution: "candidate" },
    ]);
  });

  it("bounds seed ambiguity before traversal", () => {
    const result = queryJavaScriptSemanticGraph(graphWithDuplicateLiteral(), {
      seed: { kind: "literal", value: "TOKEN" },
      direction: "forward-influence",
      limits: {
        max_seed_matches: 1,
        max_nodes: 20,
        max_edges: 20,
        max_depth: 12,
        max_functions: 10,
        max_modules: 10,
        page_size: 10,
      },
    });
    expect(result.summary).toMatchObject({
      total_seed_matches: 2,
      retained_seed_matches: 1,
    });
    expect(result.status).toBe("truncated");
    expect(result.coverage.frontier).toContainEqual(
      expect.objectContaining({ reason: "max-seed-matches", depth: 0 }),
    );
  });

  it("reports exact caller limits and a deterministic truncation frontier", () => {
    const result = queryJavaScriptSemanticGraph(fixtureGraph(), {
      seed: { kind: "literal", value: "TOKEN" },
      direction: "forward-influence",
      limits: {
        max_seed_matches: 1,
        max_nodes: 2,
        max_edges: 10,
        max_depth: 12,
        max_functions: 10,
        max_modules: 10,
        page_size: 10,
      },
    });
    expect(result.status).toBe("truncated");
    expect(result.coverage.frontier).toMatchObject([{ reason: "max-nodes" }]);
    expect(result.applied_limits.max_nodes).toBe(2);
    expect(result.accepted_limit_ranges.max_nodes).toEqual({
      minimum: 1,
      maximum: 50_000,
    });
  });

  it.each([
    {
      limit: { max_edges: 1 },
      reason: "max-edges",
    },
    {
      limit: { max_depth: 0 },
      reason: "max-depth",
    },
  ])("reports the $reason frontier", ({ limit, reason }) => {
    const result = queryJavaScriptSemanticGraph(fixtureGraph(), {
      seed: { kind: "literal", value: "TOKEN" },
      direction: "forward-influence",
      limits: {
        max_seed_matches: 10,
        max_nodes: 20,
        max_edges: limit.max_edges ?? 20,
        max_depth: limit.max_depth ?? 12,
        max_functions: 10,
        max_modules: 10,
        page_size: 10,
      },
    });
    expect(result.status).toBe("truncated");
    expect(result.coverage.frontier).toContainEqual(
      expect.objectContaining({ reason }),
    );
  });

  it("rejects out-of-range limits and cursors from another query", () => {
    expect(() =>
      javaScriptSemanticQueryInputSchema.parse({
        seed: { kind: "literal", value: "TOKEN" },
        direction: "forward-influence",
        limits: { max_nodes: 50_001 },
      }),
    ).toThrow();
    const graph = fixtureGraph();
    const first = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "literal", value: "TOKEN" },
      direction: "forward-influence",
      limits: { page_size: 1 },
    });
    expect(() =>
      queryJavaScriptSemanticGraph(graph, {
        seed: { kind: "endpoint", value: "https://example.invalid/v1" },
        direction: "backward-provenance",
        limits: { page_size: 1 },
        cursor: first.page.next_cursor,
      }),
    ).toThrow(/cursor does not match/u);
  });
});
