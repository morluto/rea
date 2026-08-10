import { expect, it } from "vitest";

import type { ApplicationGraphEvidence } from "./javascriptApplicationEvidenceSchemas.js";
import {
  JAVASCRIPT_SEMANTIC_NODE_KINDS,
  JAVASCRIPT_SEMANTIC_RELATION_FAMILIES,
  JAVASCRIPT_SEMANTIC_RELATIONS,
} from "./javascriptSemanticGraphSchemas.js";
import {
  createJavaScriptSemanticFingerprint,
  createJavaScriptSemanticGraph,
  createJavaScriptSemanticGraphNode,
  createJavaScriptSemanticGraphRelation,
  createJavaScriptSemanticGraphUnknown,
  type JavaScriptSemanticGraph,
  type JavaScriptSemanticGraphNode,
} from "./javascriptSemanticGraph.js";
import {
  parseJavaScriptSemanticGraph,
  serializeJavaScriptSemanticGraph,
} from "./javascriptSemanticGraphSerialization.js";

const SHA = "a".repeat(64);
const JAG_ID = `jag_${"b".repeat(64)}`;
const completeCoverage = {
  status: "complete",
  truncated: false,
  omitted_count: 0,
  limits: [],
} satisfies ApplicationGraphEvidence["coverage"];

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
  const graphWithUnknown = fixtureGraph(true);
  const { graph_id: _unknownGraphId, ...unknownGraphInput } = graphWithUnknown;
  const originalUnknown = graphWithUnknown.unknowns[0];
  if (originalUnknown === undefined)
    throw new Error("Expected unknown frontier");
  const { unknown_id: _unknownId, ...unknownInput } = originalUnknown;
  expect(() =>
    createJavaScriptSemanticGraph({
      ...unknownGraphInput,
      unknowns: [
        createJavaScriptSemanticGraphUnknown({
          ...unknownInput,
          candidate_node_ids: [`jsrg_node_${"f".repeat(64)}`],
        }),
      ],
    }),
  ).toThrow(/candidate node is absent/u);
});
