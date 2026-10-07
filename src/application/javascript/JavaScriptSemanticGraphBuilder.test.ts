import { expect, it } from "vitest";

import {
  buildJavaScriptSemanticGraph,
  SEMANTIC_GRAPH_FILE_NODE_CEILING,
  SEMANTIC_GRAPH_NODE_CEILING,
} from "./JavaScriptSemanticGraphBuilder.js";
import {
  addSemanticGraphNode,
  constructSemanticGraphNode,
  createSemanticGraphProjectionState,
} from "./JavaScriptSemanticGraphConstruction.js";
import type { JavaScriptArtifactAnalysis } from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { queryJavaScriptSemanticGraph } from "../../domain/javascript/javascriptSemanticQuery.js";
import { analyzeJavaScriptSemantics } from "../../domain/javascript/javascriptSemanticAnalysis.js";

const SHA256 = "a".repeat(64);
const GRAPH_ID = `jag_${"b".repeat(64)}`;

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

it("keeps dynamic calls explicit and returns complete deterministic results", () => {
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
  });
  const repeated = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "semantic-node", node_id: seedNodeId },
    direction: "forward-influence",
    include_ambiguous_dynamic_edges: true,
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

it("reports complete graph coverage for deeply nested static values", () => {
  const nesting = 40;
  const nestedValue =
    Array.from({ length: nesting }, () => "{ next: ").join("") +
    '"value"' +
    " }".repeat(nesting);
  const graph = graphFor(`const nested = ${nestedValue};`);
  expect(graph.coverage).toMatchObject({
    truncated: false,
    omitted_nodes: 0,
    omitted_relations: 0,
    limits: [],
  });
});

it("projects bounded Promise ownership and unresolved sources", () => {
  const graph = graphFor(`
      async function run(value) {
        const owned = new Promise((resolve) => resolve(value));
        await Promise.resolve(owned);
        Promise.resolve(value).then(work).finally(cleanup);
        value.then(work);
        return Promise.all([owned, Promise.resolve(value)]);
      }
    `);

  const relations = new Set(graph.relations.map(({ relation }) => relation));
  for (const expected of [
    "aggregates",
    "awaits",
    "chains",
    "creates-promise",
    "detaches-task",
    "owns",
    "returns-task",
  ] as const)
    expect(relations.has(expected)).toBe(true);
  expect(graph.nodes.filter(({ kind }) => kind === "promise")).not.toHaveLength(
    0,
  );
  expect(
    graph.nodes.find(
      ({ kind, properties }) =>
        kind === "promise" &&
        properties.method === "all" &&
        properties.ownership === "returned",
    ),
  ).toBeDefined();
  expect(
    graph.unknowns.some(
      ({ family, reason }) =>
        family === "promise-ownership" && reason === "ambiguous-target",
    ),
  ).toBe(true);
  expect(
    graph.coverage.families.find(
      ({ family }) => family === "promise-ownership",
    ),
  ).toMatchObject({ status: "partial" });
});

it("keeps duplicate function fingerprints ambiguous", () => {
  const graph = graphFor(`
      function first(value) { return value + 1; }
      function second(input) { return input + 1; }
    `);

  expect(graph.fingerprints).toHaveLength(2);
  const digest = graph.fingerprints[0]?.fingerprint_sha256;
  expect(digest).toBeDefined();
  expect(graph.fingerprints[1]?.fingerprint_sha256).toBe(digest);
  if (digest === undefined) throw new Error("Expected fingerprint");
  const query = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "function", fingerprint_sha256: digest },
    direction: "forward-influence",
  });
  expect(query.status).toBe("ambiguous");
  expect(query.summary.total_seed_matches).toBe(2);
});

const graphFor = (source: string) => {
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
  const analysis: JavaScriptArtifactAnalysis = {
    files: [
      {
        file,
        javascript: null,
        semantic: {
          ir: analyzeJavaScriptSemantics(source),
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

const semanticNodeFor = (roleKey: string) => {
  const file: JavaScriptArtifactFile = {
    path: "budget.js",
    container_sha256: SHA256,
    sha256: SHA256,
    bytes: 0,
    inventory_artifact_id: `art_${SHA256}`,
    kind: "javascript",
    unpacked: false,
    text: { included: true, value: "" },
  };
  const state = createSemanticGraphProjectionState({ nodes: [] });
  return constructSemanticGraphNode(
    file,
    {
      kind: "expression",
      roleKey,
      location: null,
      label: roleKey,
      functionNodeId: null,
    },
    state,
  );
};

it.each([
  "const value = consume(Promise.resolve(1));",
  "async function run() { await consume(Promise.resolve(1)); }",
  "function run() { return consume(Promise.resolve(1)); }",
  "const value = Promise.all([{ promise: Promise.resolve(1) }]);",
])(
  "does not claim direct Promise ownership through an enclosing expression: %s",
  (source) => {
    const graph = graphFor(source);
    const promise = graph.nodes.find(
      ({ kind, properties }) =>
        kind === "promise" && properties.method === "resolve",
    );
    expect(promise?.properties.ownership).toBe("unknown");
    expect(
      graph.relations.filter(
        ({ target_node_id, relation }) =>
          target_node_id === promise?.node_id &&
          ["owns", "awaits", "returns-task", "aggregates"].includes(relation),
      ),
    ).toEqual([]);
  },
);

it.each([
  "const routes = {'': 'HOME'}; const root = routes[''];",
  "const routes = {'': 'HOME'}; const {'': root} = routes;",
])(
  "preserves empty property identities with valid display labels: %s",
  (source) => {
    const graph = graphFor(source);
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "property-slot",
          label: '""',
          properties: expect.objectContaining({ name: "" }),
        }),
      ]),
    );
    const root = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "root",
    );
    const literal = graph.nodes.find(
      ({ kind, identity, properties }) =>
        kind === "literal" &&
        properties.value === "HOME" &&
        identity.role_key.includes(":binding:root:"),
    );
    expect(literal).toBeDefined();
    expect(graph.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_node_id: literal?.node_id,
          target_node_id: root?.node_id,
          relation: "defines",
          resolution: "resolved",
        }),
      ]),
    );
  },
);
it("keeps exact empty environment keys distinct from dynamic keys", () => {
  const graph = graphFor(`
      const empty = process.env[''];
      const named = process.env.HOME;
      const dynamic = process.env[name];
    `);
  const sources = graph.nodes
    .filter(({ kind }) => kind === "config-source")
    .map(({ label, properties }) => ({ label, key: properties.key }));
  expect(sources).toEqual(
    expect.arrayContaining([
      { label: '""', key: "" },
      { label: "HOME", key: "HOME" },
      { label: "environment", key: null },
    ]),
  );
  expect(sources).toHaveLength(3);
});

it("labels exact empty method names without inventing computed names", () => {
  const graph = graphFor(`
      const target = {
        ['']() { return 42; },
        ['""']() { return 2; },
        [key]() { return 1; },
      };
    `);
  const functions = graph.nodes
    .filter(({ kind }) => kind === "function")
    .map(({ label, properties }) => ({ label, name: properties.name }));
  // Both exact names display as `""`; only `properties.name` tells them apart.
  expect(functions).toEqual(
    expect.arrayContaining([
      { label: '""', name: "" },
      { label: '""', name: '""' },
    ]),
  );
  expect(
    functions.filter(({ label }) => label?.startsWith("[computed@")),
  ).toHaveLength(1);
});

it.each([
  "Promise.resolve(1)",
  "(Promise.resolve(1) as Promise<number>)",
  "(Promise.resolve(1) satisfies Promise<number>)",
  "Promise.resolve(1)!",
  "((Promise.resolve(1) as Promise<number>)!)",
  "(new Promise(resolve => resolve(1)) as Promise<number>)",
  "(Promise.all([Promise.resolve(1)]) as Promise<number[]>)",
  "(Promise.resolve(1).then(value => value) as Promise<number>)",
])("projects a traversable returned-task link for %s", (expression) => {
  const graph = graphFor(`const run = () => ${expression};`);
  const promise = graph.nodes.find(
    ({ kind, properties }) =>
      kind === "promise" && properties.ownership === "returned",
  );
  const relation = graph.relations.find(
    ({ relation: kind }) => kind === "returns-task",
  );
  expect(promise).toBeDefined();
  expect(relation).toMatchObject({
    target_node_id: promise?.node_id,
    resolution: "resolved",
  });
  const returnNode = graph.nodes.find(
    ({ node_id }) => node_id === relation?.source_node_id,
  );
  expect(returnNode?.kind).toBe("return-site");
  if (returnNode === undefined)
    throw new Error("Expected the linked return site");
  const query = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "semantic-node", node_id: returnNode.node_id },
    direction: "forward-influence",
    allowed_relations: ["returns-task"],
  });
  expect(query.relations).toContainEqual(relation);
  expect(query.nodes.map(({ node_id }) => node_id)).toContain(promise?.node_id);
});

it("bounds semantic node projection and reports the ceiling in coverage", () => {
  // A bundled vendor library can emit tens of thousands of semantic nodes on its
  // own (measured: 135,286 from one minified editor bundle). Without a ceiling the
  // projection exhausts the heap and the result cannot be serialized. The bound
  // must be reported through coverage rather than dropping data silently.
  const statements = Array.from(
    { length: 4_000 },
    (_, index) =>
      `const value${index} = { a: ${index}, b: [${index}, ${index + 1}] };`,
  ).join("\n");
  const graph = graphFor(statements);

  expect(graph.nodes.length).toBeLessThanOrEqual(SEMANTIC_GRAPH_NODE_CEILING);
  expect(graph.coverage.truncated).toBe(true);
  expect(graph.coverage.status).toBe("partial");
  expect(graph.coverage.omitted_nodes).toBeNull();
  expect(graph.coverage.omitted_relations).toBeNull();
  expect(
    graph.coverage.families.every(
      ({ omitted_relations }) => omitted_relations === null,
    ),
  ).toBe(true);
  expect(
    graph.coverage.limits.some(
      ({ name }) => name === "semantic_graph_node_ceiling",
    ),
  ).toBe(true);
});

it("leaves a small application complete and untruncated", () => {
  const graph = graphFor("const answer = 40 + 2;");
  expect(graph.coverage.truncated).toBe(false);
  expect(graph.coverage.omitted_nodes).toBe(0);
  expect(graph.coverage.omitted_relations).toBe(0);
  expect(graph.coverage.limits).toEqual([]);
});

it("does not mark a file truncated when it exactly fills its budget", () => {
  // Each unbound reference projects one expression, plus the module root.
  const graph = graphFor(
    "external;\n".repeat(SEMANTIC_GRAPH_FILE_NODE_CEILING - 1),
  );
  expect(graph.nodes).toHaveLength(SEMANTIC_GRAPH_FILE_NODE_CEILING);
  expect(graph.coverage).toMatchObject({
    truncated: false,
    omitted_nodes: 0,
    omitted_relations: 0,
    limits: [],
  });
});

it("only records node loss when the budget rejects a new identity", () => {
  // The truncation signal must record blocked node creation, not a zero
  // remaining budget: a file using exactly its share drops nothing.
  const state = createSemanticGraphProjectionState({ nodes: [] });
  state.fileNodeBudget = 2;
  state.fileNodesDropped = false;
  const first = addSemanticGraphNode(state, semanticNodeFor("first"));
  const second = addSemanticGraphNode(state, semanticNodeFor("second"));
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(state.fileNodeBudget).toBe(0);
  expect(state.fileNodesDropped).toBe(false);

  expect(addSemanticGraphNode(state, semanticNodeFor("first"))).toBe(first);
  expect(state.fileNodesDropped).toBe(false);

  const blocked = addSemanticGraphNode(state, semanticNodeFor("third"));
  expect(blocked).toBeNull();
  expect(state.fileNodesDropped).toBe(true);
});
