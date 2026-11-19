import { javaScriptSemanticQueryInputSchema } from "./javascriptSemanticQuerySchemas.js";
import {
  resolveJavaScriptSemanticEvidence,
  semanticFixtureGraph,
  semanticFixtureInput,
  semanticGraphTestEvidence,
  unknownSemanticGraphTestEvidence,
} from "../../../tests/support/javascriptSemanticGraphFixture.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { digestCanonicalValue } from "../canonicalDigest.js";
import type { JsonValue } from "../jsonValue.js";
import {
  JAVASCRIPT_SEMANTIC_RELATION_FAMILIES,
  JAVASCRIPT_SEMANTIC_RELATION_FAMILY,
  JAVASCRIPT_SEMANTIC_NODE_KINDS,
  JAVASCRIPT_SEMANTIC_RELATIONS,
  type JavaScriptSemanticGraphInput,
  type JavaScriptSemanticGraphNode,
} from "./javascriptSemanticGraphSchemas.js";
import {
  createJavaScriptSemanticGraph,
  createJavaScriptSemanticGraphNode,
  createJavaScriptSemanticGraphRelation,
  createJavaScriptSemanticGraphUnknown,
  createOwnedJavaScriptSemanticFingerprint,
  createOwnedJavaScriptSemanticGraphNode,
  withJavaScriptSemanticNodeApplicationIds,
  sealTransferredJavaScriptSemanticGraphSteps,
  isValidatedImmutableJavaScriptSemanticGraph,
  JavaScriptSemanticEvidenceContextRegistry,
  javaScriptSemanticGraphSchema,
  type JavaScriptSemanticGraph,
} from "./javascriptSemanticGraph.js";
import { queryJavaScriptSemanticGraph } from "./javascriptSemanticQuery.js";

const SHA = "a".repeat(64);

it.each(["unknown", "partial"] as const)(
  "rejects contradictory truncated %s graph coverage",
  (status) => {
    const input = semanticFixtureInput();
    expect(() =>
      createJavaScriptSemanticGraph({
        ...input,
        coverage: {
          ...input.coverage,
          status,
          truncated: true,
          limits: [{ name: "nodes", value: 1, unit: "items" }],
        },
        limitations: [
          "Authored truncation tests status and omission coupling.",
        ],
      }),
    ).toThrow(
      status === "partial"
        ? "Truncated semantic graph coverage must acknowledge omitted facts"
        : "Truncated semantic graph coverage must be partial",
    );
  },
);

it("accepts omitted unknown occurrences as the reason for semantic truncation", () => {
  const input = semanticFixtureInput();
  const family = input.coverage.families[0]!.family;
  const graph = createJavaScriptSemanticGraph({
    ...input,
    coverage: {
      ...input.coverage,
      status: "partial",
      truncated: true,
      omitted_unknown_occurrences: [
        { family, reason: "resource-limit", occurrences: 1 },
      ],
      limits: [{ name: "unknowns", value: 1, unit: "items" }],
      families: input.coverage.families.map((coverage) =>
        coverage.family === family
          ? { ...coverage, status: "partial" }
          : coverage,
      ),
    },
    limitations: ["Unknown ceiling omitted one resource-limit occurrence."],
  });
  expect(graph.coverage).toMatchObject({
    truncated: true,
    omitted_nodes: 0,
    omitted_relations: 0,
    omitted_unknown_occurrences: [
      { family, reason: "resource-limit", occurrences: 1 },
    ],
  });
});
const node = (
  kind: (typeof JAVASCRIPT_SEMANTIC_NODE_KINDS)[number],
  role: string,
  properties: Record<string, JsonValue> = {},
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
  options: {
    readonly functionNodeId?: string | null;
    readonly modulePath?: string;
  } = {},
): JavaScriptSemanticGraphNode =>
  createJavaScriptSemanticGraphNode(
    {
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
      evidence: semanticGraphTestEvidence(),
    },
    evidenceContexts,
  );

it("accepts a semantic module path of more than 600 segments", () => {
  const modulePath = `${"segment/".repeat(600)}entry.js`;
  const evidenceContexts = new JavaScriptSemanticEvidenceContextRegistry();
  expect(
    node("module", "long-path", {}, evidenceContexts, { modulePath }).identity
      .module_path,
  ).toBe(modulePath);
});

it("captures caller-owned node identity, properties, and provenance", () => {
  const contexts = new JavaScriptSemanticEvidenceContextRegistry();
  const input = {
    kind: "literal",
    identity: {
      artifact_sha256: SHA,
      module_path: "bundle.js",
      source_range: null,
      role_key: "literal",
    },
    function_node_id: null,
    application_node_ids: [],
    label: "literal",
    properties: { nested: ["original"] },
    evidence: semanticGraphTestEvidence(),
  };
  const captured = createJavaScriptSemanticGraphNode(input, contexts);
  const expected = structuredClone(captured);
  const expectedEvidence = structuredClone(input.evidence);

  input.identity.module_path = "replaced.js";
  input.properties.nested[0] = "replaced";
  input.evidence.limitations.push("later mutation");
  if (input.evidence.location.available)
    input.evidence.location.value = {
      kind: "artifact-path",
      path: "replaced.js",
    };

  expect(captured).toEqual(expected);
  expect(
    resolveJavaScriptSemanticEvidence(
      { evidence_contexts: contexts.contexts },
      captured.evidence,
    ),
  ).toEqual(expectedEvidence);
});

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

const graphWithCandidateRelations = (): JavaScriptSemanticGraph => {
  const base = semanticFixtureGraph();
  const evidenceContexts = registryForGraph(base);
  const relations = base.relations.map(
    ({ relation_id: _relationId, ...relation }) =>
      createJavaScriptSemanticGraphRelation(
        {
          ...relation,
          resolution: "candidate",
          evidence: resolveJavaScriptSemanticEvidence(base, relation.evidence),
        },
        evidenceContexts,
      ),
  );
  const binding = base.nodes.find(({ label }) => label === "binding");
  const callable = base.nodes.find(({ label }) => label === "function");
  if (binding === undefined || callable === undefined)
    throw new Error("Expected candidate-cycle endpoints");
  for (const [source, target] of [
    [binding, callable],
    [callable, binding],
  ] as const)
    relations.push(
      createJavaScriptSemanticGraphRelation(
        {
          source_node_id: source.node_id,
          target_node_id: target.node_id,
          relation: "owns",
          resolution: "candidate",
          properties: {},
          evidence: semanticGraphTestEvidence("inferred"),
        },
        evidenceContexts,
      ),
    );

  const { graph_id: _graphId, ...input } = base;
  return createJavaScriptSemanticGraph({
    ...input,
    evidence_contexts: evidenceContexts.contexts,
    relations,
    coverage: {
      ...input.coverage,
      families: input.coverage.families.map((family) => ({
        ...family,
        retained_relations: relations.filter(
          ({ relation }) =>
            JAVASCRIPT_SEMANTIC_RELATION_FAMILY[relation] === family.family,
        ).length,
      })),
    },
  });
};

it("counts candidate edges by query direction and relation filter", () => {
  const graph = graphWithCandidateRelations();
  const binding = graph.nodes.find(({ label }) => label === "binding");
  if (binding === undefined) throw new Error("Expected binding seed");
  const query = (
    direction: "forward-influence" | "backward-provenance",
    allowedRelations: (typeof JAVASCRIPT_SEMANTIC_RELATIONS)[number][],
  ) =>
    queryJavaScriptSemanticGraph(
      graph,
      javaScriptSemanticQueryInputSchema.parse({
        seed: { kind: "semantic-node", node_id: binding.node_id },
        direction,
        allowed_relations: allowedRelations,
      }),
    );

  expect(query("forward-influence", ["captures"]).status).toBe("ambiguous");
  expect(query("forward-influence", ["defines"]).status).toBe("found");
  expect(query("backward-provenance", ["defines"]).status).toBe("ambiguous");
  expect(query("backward-provenance", ["captures"]).status).toBe("found");
});

it("matches scalar literal seeds and skips non-scalar literal metadata", () => {
  const input = semanticFixtureInput();
  const metadataContexts = new JavaScriptSemanticEvidenceContextRegistry();
  const literals = [
    node("literal", "string-seven", { value: "7" }, metadataContexts),
    node("literal", "number-seven", { value: 7 }, metadataContexts),
    node("literal", "boolean-true", { value: true }, metadataContexts),
    node("literal", "null", { value: null }, metadataContexts),
    node("literal", "empty-string", { value: "" }, metadataContexts),
    node("literal", "zero", { value: 0 }, metadataContexts),
    node("literal", "negative-zero", { value: -0 }, metadataContexts),
    node("literal", "missing-value", {}, metadataContexts),
    node(
      "literal",
      "structured-value",
      { value: { nested: "metadata" } },
      metadataContexts,
    ),
  ];
  input.nodes.push(...literals);
  const graph = createJavaScriptSemanticGraph(input);
  const query = (value: string | number | boolean | null) =>
    queryJavaScriptSemanticGraph(
      graph,
      javaScriptSemanticQueryInputSchema.parse({
        seed: { kind: "literal", value },
        direction: "forward-influence",
      }),
    ).seed_node_ids;
  const nodeId = (role: string) => {
    const literal = literals.find(({ identity }) => identity.role_key === role);
    if (literal === undefined) throw new Error(`Missing literal ${role}`);
    return literal.node_id;
  };

  expect(query("7")).toEqual([nodeId("string-seven")]);
  expect(query(7)).toEqual([nodeId("number-seven")]);
  expect(query(true)).toEqual([nodeId("boolean-true")]);
  expect(query(null)).toEqual([nodeId("null")]);
  expect(query("")).toEqual([nodeId("empty-string")]);
  expect(query(0)).toEqual(
    [nodeId("zero"), nodeId("negative-zero")].toSorted(),
  );
  expect(query("unmatched")).toEqual([]);
});

it("matches exact endpoint properties on request and response carriers only", () => {
  const input = semanticFixtureInput();
  const contexts = new JavaScriptSemanticEvidenceContextRegistry();
  const endpoint = "https://example.invalid/v1";
  const response = node("response", "response", { endpoint }, contexts);
  const other = node(
    "response",
    "other-endpoint",
    { endpoint: `${endpoint}/other` },
    contexts,
  );
  const displayOnly = node("response", endpoint, { endpoint: null }, contexts);
  input.nodes.push(
    response,
    displayOnly,
    node("response", "missing-endpoint", {}, contexts),
    other,
    node("response", "array-endpoint", { endpoint: [endpoint] }, contexts),
    node("boundary", "unrelated-carrier", { endpoint }, contexts),
  );
  const graph = createJavaScriptSemanticGraph(input);
  const request = input.nodes.find(({ kind }) => kind === "request");
  if (request === undefined) throw new Error("Expected request carrier");
  const query = (value: string) =>
    queryJavaScriptSemanticGraph(
      graph,
      javaScriptSemanticQueryInputSchema.parse({
        seed: { kind: "endpoint", value },
        direction: "forward-influence",
      }),
    );
  expect(query(endpoint).seed_node_ids).toEqual(
    [request.node_id, response.node_id].toSorted(),
  );
  expect(query(`${endpoint}/other`).seed_node_ids).toEqual([other.node_id]);
  expect(query("response").seed_node_ids).toEqual([]);
  expect(query(`${endpoint}/missing`).seed_node_ids).toEqual([]);
});

it("scopes callers unknowns to call relations while preserving graph uncertainty", () => {
  const contexts = new JavaScriptSemanticEvidenceContextRegistry();
  const caller = node("function", "caller", {}, contexts);
  const seed = node("function", "seed", {}, contexts);
  const call = createJavaScriptSemanticGraphRelation(
    {
      source_node_id: caller.node_id,
      target_node_id: seed.node_id,
      relation: "calls",
      resolution: "resolved",
      properties: {},
      evidence: semanticGraphTestEvidence("inferred"),
    },
    contexts,
  );
  const readUnknown = createJavaScriptSemanticGraphUnknown(
    {
      node_id: caller.node_id,
      family: "data-flow",
      relation_kinds: ["reads"],
      reason: "dynamic-property",
      detail: "Unresolved property read at the caller.",
      candidate_node_ids: [],
      evidence: unknownSemanticGraphTestEvidence(),
    },
    contexts,
  );
  const graph = createJavaScriptSemanticGraph({
    schema: "JavaScriptSemanticRelationGraph",
    root_artifact_sha256: SHA,
    application_graph_id: `jag_${"b".repeat(64)}`,
    root_node_ids: [seed.node_id],
    evidence_contexts: contexts.contexts,
    nodes: [caller, seed],
    relations: [call],
    fingerprints: [],
    unknowns: [readUnknown],
    coverage: {
      status: "partial",
      truncated: false,
      omitted_nodes: null,
      omitted_relations: null,
      limits: [],
      families: JAVASCRIPT_SEMANTIC_RELATION_FAMILIES.map((family) => ({
        family,
        status:
          family === "data-flow" ? ("unknown" as const) : ("complete" as const),
        retained_relations:
          JAVASCRIPT_SEMANTIC_RELATION_FAMILY[call.relation] === family ? 1 : 0,
        omitted_relations: family === "data-flow" ? null : 0,
        unknown_ids: family === "data-flow" ? [readUnknown.unknown_id] : [],
      })),
    },
    limitations: ["One property read remains unresolved."],
  });
  const query = (
    direction: "callers" | "backward-provenance",
    allowed_relations?: ["calls"],
  ) =>
    queryJavaScriptSemanticGraph(
      graph,
      javaScriptSemanticQueryInputSchema.parse({
        seed: { kind: "semantic-node", node_id: seed.node_id },
        direction,
        ...(allowed_relations === undefined ? {} : { allowed_relations }),
      }),
    );
  const callers = query("callers");
  const filtered = query("callers", ["calls"]);
  const backward = query("backward-provenance");
  expect(callers.summary.traversed_nodes).toBe(2);
  expect(callers.unknowns).toEqual([]);
  expect(callers.summary.relevant_unknowns).toBe(0);
  expect(callers.limitations).not.toContain(
    "Relevant dynamic, unsupported, incomplete, or ambiguous semantics remain unknown.",
  );
  expect(filtered.unknowns).toEqual(callers.unknowns);
  expect(backward.unknowns.map(({ unknown_id }) => unknown_id)).toEqual([
    readUnknown.unknown_id,
  ]);
  expect(callers.coverage.status).toBe("partial");
});

it("counts candidate ownership cycles once and traverses them finitely", () => {
  const graph = graphWithCandidateRelations();
  const binding = graph.nodes.find(({ label }) => label === "binding");
  if (binding === undefined) throw new Error("Expected binding seed");
  const result = queryJavaScriptSemanticGraph(
    graph,
    javaScriptSemanticQueryInputSchema.parse({
      seed: { kind: "semantic-node", node_id: binding.node_id },
      direction: "ownership",
      allowed_relations: ["owns"],
      include_ambiguous_dynamic_edges: true,
    }),
  );

  expect(result.status).toBe("ambiguous");
  expect(result.relations).toHaveLength(2);
  expect(result.summary.traversed_nodes).toBe(2);
  expect(result.summary.traversed_relations).toBe(2);
  expect(
    queryJavaScriptSemanticGraph(
      graph,
      javaScriptSemanticQueryInputSchema.parse({
        seed: { kind: "semantic-node", node_id: binding.node_id },
        direction: "ownership",
        allowed_relations: ["constructs-request"],
      }),
    ).status,
  ).toBe("found");
});

it("rejects stale identities, dangling endpoints, and incomplete coverage claims", () => {
  const graph = semanticFixtureGraph();
  expect(() =>
    javaScriptSemanticGraphSchema.parse({
      ...graph,
      graph_id: `jsrg_${"0".repeat(64)}`,
    }),
  ).toThrow();
  const dangling = semanticFixtureInput();
  const { relation_id: _relationId, ...relation } = dangling.relations[0]!;
  const danglingRelation = createJavaScriptSemanticGraphRelation(
    {
      ...relation,
      evidence: resolveJavaScriptSemanticEvidence(graph, relation.evidence),
      target_node_id: `jsrg_node_${"f".repeat(64)}`,
    },
    registryForGraph(graph),
  );
  expect(() =>
    createJavaScriptSemanticGraph({
      ...dangling,
      relations: [danglingRelation, ...dangling.relations.slice(1)],
    }),
  ).toThrow(/Relation endpoints must name semantic nodes/u);
  expect(() =>
    createJavaScriptSemanticGraph({
      ...semanticFixtureInput(),
      coverage: { ...semanticFixtureInput().coverage, omitted_nodes: 1 },
    }),
  ).toThrow(/Complete graph coverage/u);
  const unknownGraphInput = semanticFixtureInput(true);
  const originalUnknown = unknownGraphInput.unknowns[0];
  if (originalUnknown === undefined)
    throw new Error("Expected unknown frontier");
  const { unknown_id: _unknownId, ...unknownInput } = originalUnknown;
  const validatedUnknownGraph =
    createJavaScriptSemanticGraph(unknownGraphInput);
  const evidenceContexts = registryForGraph(validatedUnknownGraph);
  unknownGraphInput.unknowns = [
    createJavaScriptSemanticGraphUnknown(
      {
        ...unknownInput,
        candidate_node_ids: [`jsrg_node_${"f".repeat(64)}`],
        evidence: resolveJavaScriptSemanticEvidence(
          validatedUnknownGraph,
          originalUnknown.evidence,
        ),
      },
      evidenceContexts,
    ),
  ];
  unknownGraphInput.evidence_contexts = evidenceContexts.contexts;
  expect(() => createJavaScriptSemanticGraph(unknownGraphInput)).toThrow(
    /candidate node is absent/u,
  );
});

it("rejects complete family coverage with an unlisted retained frontier", () => {
  const input = semanticFixtureInput(true);
  const valid = createJavaScriptSemanticGraph(input);
  const coverage = {
    ...valid.coverage,
    status: "complete" as const,
    truncated: false,
    omitted_nodes: 0,
    omitted_relations: 0,
    families: valid.coverage.families.map((family) =>
      family.family === "call-flow"
        ? {
            ...family,
            status: "complete" as const,
            omitted_relations: 0,
            unknown_ids: [],
          }
        : family,
    ),
  };
  const { graph_id: _previousId, ...semantic } = valid;
  const changed = { ...semantic, coverage, limitations: [] };
  const invalid = {
    ...changed,
    graph_id: `jsrg_${digestCanonicalValue(
      changed,
      "JavaScript semantic graph",
    )}`,
  };
  const diagnostic =
    "Complete family coverage cannot omit or retain unknown facts";
  expect(() => createJavaScriptSemanticGraph(changed)).toThrow(diagnostic);
  const parsed = javaScriptSemanticGraphSchema.safeParse(
    JSON.parse(JSON.stringify(invalid)),
  );
  if (parsed.success) throw new Error("Expected inconsistent graph rejection");
  expect(parsed.error.issues.map(({ message }) => message)).toContain(
    diagnostic,
  );
});

it("validates evidence context ownership and references", () => {
  const graph = semanticFixtureGraph();
  const changedPayload = javaScriptSemanticGraphSchema.safeParse({
    ...graph,
    evidence_contexts: graph.evidence_contexts.map((context, index) =>
      index === 0 ? { ...context, authority: "user-assertion" } : context,
    ),
  });
  if (changedPayload.success)
    throw new Error("Expected changed context payload rejection");
  expect(changedPayload.error.issues.map(({ message }) => message)).toContain(
    "Evidence context identifier is stale",
  );

  const withUnknown = semanticFixtureGraph(true);
  const extraContext = withUnknown.evidence_contexts.find(
    ({ context_id }) =>
      !graph.evidence_contexts.some(
        (existing) => existing.context_id === context_id,
      ),
  );
  if (extraContext === undefined)
    throw new Error("Expected the unknown fact to own a distinct context");
  const orphanIssues = javaScriptSemanticGraphSchema.safeParse({
    ...graph,
    evidence_contexts: [...graph.evidence_contexts, extraContext].toSorted(
      (left, right) => left.context_id.localeCompare(right.context_id),
    ),
  });
  if (orphanIssues.success)
    throw new Error("Expected orphan context rejection");
  expect(orphanIssues.error.issues.map(({ message }) => message)).toContain(
    "Evidence context is not referenced by a graph fact",
  );

  for (const fact of [
    "nodes",
    "relations",
    "unknowns",
    "fingerprints",
  ] as const) {
    const facts = withUnknown[fact];
    const first = facts[0];
    if (first === undefined) throw new Error(`Expected a ${fact} fact`);
    const dangling = javaScriptSemanticGraphSchema.safeParse({
      ...withUnknown,
      [fact]: [
        {
          ...first,
          evidence: {
            ...first.evidence,
            context_id: `jsrg_evidence_${"e".repeat(64)}`,
          },
        },
        ...facts.slice(1),
      ],
    });
    if (dangling.success)
      throw new Error(`Expected dangling ${fact} reference`);
    expect(
      dangling.error.issues.map(({ message }) => message),
      fact,
    ).toContain("Evidence reference names an absent context");
  }

  const observedNode = graph.nodes[0];
  if (observedNode === undefined) throw new Error("Expected observed node");
  const impossibleEvidence = javaScriptSemanticGraphSchema.safeParse({
    ...graph,
    nodes: [
      {
        ...observedNode,
        evidence: {
          ...observedNode.evidence,
          location: {
            available: false,
            reason: "not-observed",
            detail: "Location removed from an observed fact.",
          },
        },
      },
      ...graph.nodes.slice(1),
    ],
  });
  if (impossibleEvidence.success)
    throw new Error("Expected incompatible evidence context and location");
  expect(
    impossibleEvidence.error.issues.map(({ message }) => message),
  ).toContain("Evidence context is incompatible with its fact location");
});

it("shares provenance contexts while preserving fact-specific locations and unknown IDs", () => {
  const graph = semanticFixtureGraph(true);
  const first = graph.unknowns[0];
  if (first === undefined) throw new Error("Expected an unknown frontier");
  const evidenceContexts = registryForGraph(graph);
  const { unknown_id: _unknownId, ...unknown } = first;
  const second = createJavaScriptSemanticGraphUnknown(
    {
      ...unknown,
      evidence: {
        ...resolveJavaScriptSemanticEvidence(graph, first.evidence),
        location: {
          available: false,
          reason: "unresolved",
          detail: "Another source location remains unresolved.",
        },
      },
    },
    evidenceContexts,
  );
  const { graph_id: _graphId, ...semantic } = graph;
  const combined = createJavaScriptSemanticGraph({
    ...semantic,
    unknowns: [...graph.unknowns, second],
    evidence_contexts: evidenceContexts.contexts,
    coverage: {
      ...graph.coverage,
      families: graph.coverage.families.map((family) =>
        family.unknown_ids.includes(first.unknown_id)
          ? {
              ...family,
              unknown_ids: [...family.unknown_ids, second.unknown_id],
            }
          : family,
      ),
    },
  });
  const stored = javaScriptSemanticGraphSchema.parse(
    JSON.parse(JSON.stringify(combined)),
  );
  expect(stored.evidence_contexts).toEqual(graph.evidence_contexts);
  expect(second.unknown_id).not.toBe(first.unknown_id);
  expect(stored.unknowns).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        unknown_id: first.unknown_id,
        evidence: first.evidence,
      }),
      expect.objectContaining({
        unknown_id: second.unknown_id,
        evidence: {
          context_id: first.evidence.context_id,
          location: {
            available: false,
            reason: "unresolved",
            detail: "Another source location remains unresolved.",
          },
        },
      }),
    ]),
  );
});

const complete = <Value>(steps: Iterator<void, Value>): Value => {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
};

it("preserves a transferred graph independent of the caller retained copy", () => {
  const input = semanticFixtureInput(true);
  const node = input.nodes[0];
  if (node === undefined) throw new Error("Expected fixture node");
  const nested = { text: 'Unicode: \u{1f600} \ud800 " \\ ', rows: [1, 2, 3] };
  node.properties = { nested, padding: "x".repeat(64_000) };
  input.nodes.reverse();
  input.relations.reverse();
  input.coverage.families.reverse();
  const expected = createJavaScriptSemanticGraph(input);
  const steps = sealTransferredJavaScriptSemanticGraphSteps(
    structuredClone(input),
  );
  expect(steps.next().done).toBe(false);
  nested.text = "Changed while the owned graph is being hashed.";
  nested.rows.push(4);
  input.relations.length = 0;
  input.coverage.families.length = 0;
  const graph = complete(steps);
  expect(graph).toEqual(expected);
  const nodeIds = graph.nodes.map(({ node_id }) => node_id);
  expect(nodeIds).toEqual(nodeIds.toSorted());
  expect(
    javaScriptSemanticGraphSchema.parse(JSON.parse(JSON.stringify(graph))),
  ).toEqual(expected);
  expect(isValidatedImmutableJavaScriptSemanticGraph(graph)).toBe(true);
  expect(isValidatedImmutableJavaScriptSemanticGraph(expected)).toBe(false);
});

const invalidGraphCases: {
  readonly label: string;
  readonly change: (input: JavaScriptSemanticGraphInput) => void;
  readonly issuePath: readonly string[];
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
    issuePath: ["nodes", "node_id"],
  },
  {
    label: "relation endpoints and authority",
    change: (input) => {
      input.relations = input.relations.map((relation) => ({
        ...relation,
        source_node_id: `jsrg_node_${"f".repeat(64)}`,
        target_node_id: `jsrg_node_${"e".repeat(64)}`,
        resolution: "candidate",
      }));
    },
    issuePath: ["relations"],
  },
  {
    label: "unknown identity and candidates",
    change: (input) => {
      input.unknowns = input.unknowns.map((unknown) => ({
        ...unknown,
        candidate_node_ids: [`jsrg_node_${"f".repeat(64)}`],
      }));
    },
    issuePath: ["unknowns", "candidate_node_ids"],
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
    issuePath: ["fingerprints", "fingerprint_sha256"],
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
    issuePath: ["coverage", "families", "retained_relations"],
  },
];

it.each(invalidGraphCases)(
  "retains full validation diagnostics for $label in owned steps",
  ({ change, issuePath }) => {
    const input = semanticFixtureInput(true);
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
    expect(
      expected.some(({ path }) => {
        const keys = path.filter((part) => typeof part === "string");
        return (
          keys.length === issuePath.length &&
          keys.every((key, index) => key === issuePath[index])
        );
      }),
    ).toBe(true);
    const steps = sealTransferredJavaScriptSemanticGraphSteps(
      structuredClone(input),
    );
    expect(steps.next().done).toBe(false);
    expect(issues(() => complete(steps))).toEqual(expected);
  },
);

it("interns valid normalized evidence after rejecting malformed provenance", () => {
  const registry = new JavaScriptSemanticEvidenceContextRegistry();
  const observed = semanticGraphTestEvidence();
  expect(() =>
    registry.intern({
      ...observed,
      extractor: { ...observed.extractor, name: "" },
    }),
  ).toThrow(z.ZodError);

  const first = registry.intern(observed);
  const reordered = registry.intern({
    ...semanticGraphTestEvidence("inferred"),
    limitations: [
      "Static reachability does not prove runtime execution.",
      "Static reachability does not prove runtime execution.",
    ],
  });
  const inferred = registry.intern(semanticGraphTestEvidence("inferred"));
  const { location: _location, ...context } = observed;

  expect(reordered.context_id).toBe(inferred.context_id);
  expect(inferred.context_id).not.toBe(first.context_id);
  expect(first.context_id).toBe(
    `jsrg_evidence_${digestCanonicalValue(context, "test")}`,
  );
  expect(registry.contexts.map(({ context_id }) => context_id)).toEqual(
    [first.context_id, inferred.context_id].toSorted(),
  );
  expect(registry.resolve(first)).toEqual(observed);
});

it("seals owned builder records while still rejecting tampered spread copies", () => {
  const registry = new JavaScriptSemanticEvidenceContextRegistry();
  const ownedModule = createOwnedJavaScriptSemanticGraphNode(
    {
      kind: "module",
      identity: {
        artifact_sha256: SHA,
        module_path: "bundle.js",
        source_range: {
          start: { line: 1, column: 0 },
          end: { line: 1, column: 20 },
        },
        role_key: "module",
      },
      function_node_id: null,
      application_node_ids: [],
      label: "bundle.js",
      properties: {},
      evidence: semanticGraphTestEvidence(),
    },
    registry,
  );
  const ownedCallable = withJavaScriptSemanticNodeApplicationIds(
    createOwnedJavaScriptSemanticGraphNode(
      {
        kind: "function",
        identity: {
          artifact_sha256: SHA,
          module_path: "bundle.js",
          source_range: {
            start: { line: 1, column: 2 },
            end: { line: 1, column: 18 },
          },
          role_key: "fn",
        },
        function_node_id: null,
        application_node_ids: [],
        label: "fn",
        properties: {},
        evidence: semanticGraphTestEvidence(),
      },
      registry,
    ),
    [`jag_node_${"c".repeat(64)}`],
  );
  const ownedFingerprint = createOwnedJavaScriptSemanticFingerprint(
    {
      function_node_id: ownedCallable.node_id,
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
      evidence: semanticGraphTestEvidence("inferred"),
    },
    registry,
  );
  expect(Object.isFrozen(ownedModule)).toBe(true);
  expect(Object.isFrozen(ownedCallable)).toBe(true);
  expect(Object.isFrozen(ownedCallable.application_node_ids)).toBe(true);
  expect(Object.isFrozen(ownedFingerprint)).toBe(true);
  expect(Object.isFrozen(registry.ownedContexts[0])).toBe(true);

  const ownedInput: JavaScriptSemanticGraphInput = {
    schema: "JavaScriptSemanticRelationGraph",
    root_artifact_sha256: SHA,
    application_graph_id: `jag_${"b".repeat(64)}`,
    root_node_ids: [ownedModule.node_id],
    evidence_contexts: registry.ownedContexts,
    nodes: [ownedModule, ownedCallable],
    relations: [],
    unknowns: [],
    fingerprints: [ownedFingerprint],
    coverage: {
      status: "complete",
      truncated: false,
      omitted_nodes: 0,
      omitted_relations: 0,
      limits: [],
      families: JAVASCRIPT_SEMANTIC_RELATION_FAMILIES.map((family) => ({
        family,
        status: "complete",
        retained_relations: 0,
        omitted_relations: 0,
        unknown_ids: [],
      })),
    },
    limitations: [],
  };
  const direct = createJavaScriptSemanticGraph(ownedInput);
  const transferred = complete(
    sealTransferredJavaScriptSemanticGraphSteps(ownedInput),
  );
  const unsealed = createJavaScriptSemanticGraph(
    JSON.parse(JSON.stringify(ownedInput)) as JavaScriptSemanticGraphInput,
  );
  expect(direct.graph_id).toBe(unsealed.graph_id);
  expect(transferred).toEqual(direct);

  for (const tampered of [
    {
      ...ownedInput,
      nodes: [
        ownedModule,
        { ...ownedCallable, node_id: `jsrg_node_${"f".repeat(64)}` },
      ],
    },
    {
      ...ownedInput,
      fingerprints: [
        {
          ...ownedFingerprint,
          fingerprint_id: `jsrg_fp_${"f".repeat(64)}`,
        },
      ],
    },
    {
      ...ownedInput,
      nodes: [
        {
          ...ownedModule,
          evidence: {
            context_id: ownedModule.evidence.context_id,
            location: {
              available: false as const,
              reason: "unresolved" as const,
              detail: "Contradicts observed context.",
            },
          },
        },
        ownedCallable,
      ],
    },
  ] satisfies JavaScriptSemanticGraphInput[]) {
    expect(() => createJavaScriptSemanticGraph(tampered)).toThrow(z.ZodError);
    expect(() =>
      complete(sealTransferredJavaScriptSemanticGraphSteps(tampered)),
    ).toThrow(z.ZodError);
  }
});
