import { expect, it } from "vitest";
import { z } from "zod";

import type { ApplicationGraphEvidence } from "./javascriptApplicationEvidenceSchemas.js";
import {
  JAVASCRIPT_SEMANTIC_NODE_KINDS,
  JAVASCRIPT_SEMANTIC_RELATION_FAMILIES,
  JAVASCRIPT_SEMANTIC_RELATIONS,
  type JavaScriptSemanticGraphInput,
} from "./javascriptSemanticGraphSchemas.js";
import {
  createJavaScriptSemanticFingerprint,
  createJavaScriptSemanticGraph,
  createJavaScriptSemanticGraphNode,
  createJavaScriptSemanticGraphRelation,
  createJavaScriptSemanticGraphUnknown,
  createImmutableJavaScriptSemanticGraphSteps,
  isValidatedImmutableJavaScriptSemanticGraph,
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
  options: {
    readonly functionNodeId?: string | null;
    readonly modulePath?: string;
  } = {},
): JavaScriptSemanticGraphNode =>
  createJavaScriptSemanticGraphNode({
    kind,
    identity: {
      artifact_sha256: SHA,
      module_path: options.modulePath ?? "bundle.js",
      source_range: {
        start: { line: 1, column: role.length },
        end: { line: 1, column: role.length + 1 },
      },
      role_key: role,
    },
    function_node_id: options.functionNodeId ?? null,
    application_node_ids: [],
    label: role,
    properties,
    evidence: evidence(),
  });

it("accepts semantic module paths longer than the former schema ceiling", () => {
  const modulePath = `${"segment/".repeat(600)}entry.js`;
  expect(
    node("module", "long-path", {}, { modulePath }).identity.module_path,
  ).toBe(modulePath);
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
    algorithm: "rea.javascript-semantic-function",
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

it("defines every required relation family and canonicalizes records", () => {
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

const complete = <Value>(steps: Iterator<void, Value>): Value => {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
};

it("captures nested input before yielding and preserves the synchronous graph commitment", () => {
  const { graph_id: _graphId, ...input } = fixtureGraph(true);
  const node = input.nodes[0];
  if (node === undefined) throw new Error("Expected fixture node");
  const nested = { text: 'Unicode: \u{1f600} \ud800 " \\ ', rows: [1, 2, 3] };
  node.properties = { nested, padding: "x".repeat(64_000) };
  input.nodes.reverse();
  input.relations.reverse();
  input.coverage.families.reverse();
  const expected = createJavaScriptSemanticGraph(input);
  const steps = createImmutableJavaScriptSemanticGraphSteps(input);
  expect(steps.next().done).toBe(false);
  nested.text = "Changed while the owned graph is being hashed.";
  nested.rows.push(4);
  input.relations.length = 0;
  input.coverage.families.length = 0;
  const graph = complete(steps);
  expect(graph).toEqual(expected);
  expect(
    parseJavaScriptSemanticGraph(
      JSON.parse(serializeJavaScriptSemanticGraph(graph)),
    ),
  ).toEqual(expected);
  expect(isValidatedImmutableJavaScriptSemanticGraph(graph)).toBe(true);
  expect(isValidatedImmutableJavaScriptSemanticGraph(expected)).toBe(false);
  expect(Object.isFrozen(nested)).toBe(false);
});

const invalidGraphCases: {
  readonly label: string;
  readonly change: (input: JavaScriptSemanticGraphInput) => void;
  readonly message: string;
}[] = [
  {
    label: "node identity and ownership",
    change: (input) => {
      input.nodes = input.nodes.map((node, index) =>
        index === 0
          ? {
              ...node,
              node_id: `jsrg_node_${"f".repeat(64)}`,
              function_node_id: `jsrg_node_${"e".repeat(64)}`,
            }
          : node,
      );
    },
    message: "Node identifier is stale",
  },
  {
    label: "relation identity, endpoints and authority",
    change: (input) => {
      input.relations = input.relations.map((relation) => ({
        ...relation,
        source_node_id: `jsrg_node_${"f".repeat(64)}`,
        target_node_id: `jsrg_node_${"f".repeat(64)}`,
        resolution: "candidate",
        evidence: evidence(),
      }));
    },
    message: "Relation identifier is stale",
  },
  {
    label: "unknown identity and candidates",
    change: (input) => {
      input.unknowns = input.unknowns.map((unknown) => ({
        ...unknown,
        candidate_node_ids: [`jsrg_node_${"f".repeat(64)}`],
        evidence: evidence(),
      }));
    },
    message: "Unknown frontier candidate node is absent",
  },
  {
    label: "fingerprint identity and components",
    change: (input) => {
      input.fingerprints = input.fingerprints.map((fingerprint) => ({
        ...fingerprint,
        function_node_id: `jsrg_node_${"f".repeat(64)}`,
        fingerprint_sha256: "f".repeat(64),
        components: { ...fingerprint.components, parameter_arity: 42 },
      }));
    },
    message: "Fingerprint component commitment is stale",
  },
  {
    label: "coverage completeness and references",
    change: (input) => {
      input.coverage.status = "complete";
      input.coverage.families = input.coverage.families.map((family) => ({
        ...family,
        retained_relations: family.retained_relations + 1,
        unknown_ids: [`jsrg_unknown_${"f".repeat(64)}`],
      }));
    },
    message: "Family retained relation count does not match graph content",
  },
];

it.each(invalidGraphCases)(
  "retains full validation diagnostics for $label in owned steps",
  ({ change, message }) => {
    const { graph_id: _graphId, ...input } = fixtureGraph(true);
    change(input);
    const issues = (action: () => unknown) => {
      try {
        action();
      } catch (error: unknown) {
        if (error instanceof z.ZodError) return error.issues;
        throw error;
      }
      throw new Error("Expected invalid graph to fail validation");
    };
    const expected = issues(() => createJavaScriptSemanticGraph(input));
    expect(expected.map(({ message }) => message)).toContain(message);
    const steps = createImmutableJavaScriptSemanticGraphSteps(input);
    expect(steps.next().done).toBe(false);
    expect(issues(() => complete(steps))).toEqual(expected);
  },
);
