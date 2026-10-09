import { primitiveByteExpansionSource } from "../../../tests/fixtures/javascriptPrimitiveExpansion.js";
import * as t from "@babel/types";
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
import {
  analyzeJavaScriptSemantics,
  analyzeParsedJavaScriptSemantics,
} from "../../domain/javascript/javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "../../domain/javascript/javascriptSourceParser.js";
import { semanticCoverageResourceLimits } from "../../domain/javascript/javascriptSemanticCoverage.js";

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

it("preserves primitive candidate budget unknowns in semantic graph coverage", () => {
  const term = '(true ? "a" : "b")';
  const source = `const answer = ${Array.from({ length: 20 }, () => term).join(" + ")};`;
  const ir = analyzeJavaScriptSemantics(source);
  const graph = graphFor(source, ir);

  expect(ir.coverage).toMatchObject({
    status: "partial",
    resourceLimits: ["primitive-candidates"],
  });
  expect(graph.unknowns).toContainEqual(
    expect.objectContaining({
      family: "data-flow",
      reason: "resource-limit",
      detail: expect.stringMatching(/primitive candidate budget exceeded/i),
    }),
  );
});

it("preserves derived string-byte limit reasons in semantic graph unknowns", () => {
  const source = primitiveByteExpansionSource();
  const ir = analyzeJavaScriptSemantics(source);
  const graph = graphFor(source, ir);

  expect(semanticCoverageResourceLimits(ir.coverage)).toContain(
    "primitive-bytes",
  );
  expect(graph.unknowns).toContainEqual(
    expect.objectContaining({
      reason: "resource-limit",
      detail: expect.stringMatching(/primitive string-byte budget exceeded/i),
    }),
  );
});

it("retains resource-limit reasons at nested object property slots", () => {
  const term = '(true ? "a" : "b")';
  const source = `const answer = { nested: { value: ${Array.from({ length: 20 }, () => term).join(" + ")} } };`;
  const ir = analyzeJavaScriptSemantics(source);
  const graph = graphFor(source, ir);

  expect(semanticCoverageResourceLimits(ir.coverage)).toEqual([
    "primitive-candidates",
  ]);
  expect(graph.unknowns).toContainEqual(
    expect.objectContaining({
      family: "data-flow",
      relation_kinds: ["defines"],
      reason: "resource-limit",
      detail: expect.stringMatching(
        /Unknown value at property:\/nested\/value/u,
      ),
    }),
  );
});

it("preserves deep expression resource reasons through graph projection", () => {
  const source = "const answer = true;";
  const parsed = parseJavaScriptSource(source);
  const declaration = parsed?.program.body[0];
  const declarator = t.isVariableDeclaration(declaration)
    ? declaration.declarations[0]
    : undefined;
  if (parsed === null || !t.isVariableDeclarator(declarator))
    throw new Error("Expected parsed binding initializer");
  let expression: t.Expression = t.booleanLiteral(true);
  for (let index = 0; index < 5_000; index += 1)
    expression = t.unaryExpression("!", expression, true);
  declarator.init = expression;
  const ir = analyzeParsedJavaScriptSemantics(parsed);
  const graph = graphFor(source, ir);

  expect(semanticCoverageResourceLimits(ir.coverage)).toEqual([
    "expression-depth",
  ]);
  expect(graph.unknowns).toContainEqual(
    expect.objectContaining({
      reason: "resource-limit",
      detail: expect.stringMatching(/expression depth budget exceeded/i),
    }),
  );
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

const graphFor = (source: string, ir = analyzeJavaScriptSemantics(source)) => {
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
        semantic: { ir },
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

it("keeps full static property identities distinct through backward provenance", () => {
  const graph = graphFor(`
    const root = { a: { id: 'left' }, b: { id: 'right' }, 'a.id': 'dotted', '': { 'a/b~c': 'escaped' } };
    const left = root.a.id;
    const right = root['b']['id'];
    const missing = root.id;
    const dotted = root['a.id'];
    const escaped = root['']['a/b~c'];
  `);
  const slots = graph.nodes.filter(({ kind }) => kind === "property-slot");
  for (const [pointer, literal] of [
    ["/a/id", "left"],
    ["/b/id", "right"],
    ["/a.id", "dotted"],
    ["//a~1b~0c", "escaped"],
    ["/id", null],
  ]) {
    const slot = slots.find(
      ({ properties }) => properties.property_pointer === pointer,
    );
    if (slot === undefined) throw new Error(`Missing slot ${pointer}`);
    expect(slot.properties.presence).toBe(
      literal === null ? "absent" : "present",
    );
    const trace = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: slot.node_id },
      direction: "backward-provenance",
      allowed_relations: ["defines"],
    });
    expect(
      trace.nodes
        .filter(({ kind }) => kind === "literal")
        .map(({ properties }) => properties.value),
    ).toEqual(literal === null ? [] : [literal]);
    const reads = graph.relations.filter(
      ({ source_node_id, relation }) =>
        source_node_id === slot.node_id && relation === "reads-property",
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]?.resolution).toBe(
      literal === null ? "candidate" : "resolved",
    );
  }
});

it("targets nested writes and destructuring without inventing leaf-level root slots", () => {
  const graph = graphFor(`
    const root = { left: { id: 'before' }, right: { id: 'untouched' } };
    root.left.id = produce();
    const { right: { id: selected } } = root;
    const [first, missing] = [1, , 3];
  `);
  const rootSlots = graph.nodes.filter(
    ({ kind, properties }) =>
      kind === "property-slot" && properties.name === "id",
  );
  expect(
    rootSlots.map(({ properties }) => properties.property_pointer).sort(),
  ).toEqual(["/left/id", "/right/id"]);
  const left = rootSlots.find(
    ({ properties }) => properties.property_pointer === "/left/id",
  );
  const right = rootSlots.find(
    ({ properties }) => properties.property_pointer === "/right/id",
  );
  expect(left?.properties.presence).toBe("unknown-coverage");
  const write = graph.nodes.find(
    ({ kind, properties }) =>
      kind === "expression" && properties.operation_kind === "write",
  );
  expect(graph.relations).toContainEqual(
    expect.objectContaining({
      source_node_id: write?.node_id,
      target_node_id: left?.node_id,
      relation: "writes-property",
      resolution: "resolved",
    }),
  );
  const selected = graph.nodes.find(
    ({ kind, label }) => kind === "binding" && label === "selected",
  );
  expect(graph.relations).toContainEqual(
    expect.objectContaining({
      source_node_id: right?.node_id,
      target_node_id: selected?.node_id,
      relation: "destructures",
      resolution: "resolved",
    }),
  );
});

it("keeps dynamic intermediate receivers unresolved instead of selecting a static leaf", () => {
  const graph = graphFor(`
    const root = { id: 'root', a: { id: 'nested' } };
    const selected = root[key].id;
  `);
  expect(
    graph.relations.filter(({ relation }) => relation === "reads-property"),
  ).toEqual([]);
  expect(graph.unknowns).toContainEqual(
    expect.objectContaining({
      family: "object-flow",
      relation_kinds: ["reads-property"],
    }),
  );
  const selected = graph.nodes.find(
    ({ kind, label }) => kind === "binding" && label === "selected",
  );
  if (selected === undefined) throw new Error("Missing selected binding");
  const trace = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "semantic-node", node_id: selected.node_id },
    direction: "backward-provenance",
    allowed_relations: ["defines"],
  });
  expect(trace.nodes.filter(({ kind }) => kind === "literal")).toEqual([]);
});

it.each([
  {
    initializer: "{}",
    path: "missing.id",
    pointer: "/missing/id",
    resolved: false,
  },
  {
    initializer: "{ a: null }",
    path: "a.id",
    pointer: "/a/id",
    resolved: false,
  },
  { initializer: "{ a: 1 }", path: "a.id", pointer: "/a/id", resolved: false },
  { initializer: "{ a: {} }", path: "a.id", pointer: "/a/id", resolved: true },
  { initializer: "{ a: [] }", path: "a[0]", pointer: "/a/0", resolved: true },
])(
  "admits a write only through a retained container receiver: $initializer.$path",
  ({ initializer, path, pointer, resolved }) => {
    const graph = graphFor(
      `const root = ${initializer}; root.${path} = produce();`,
    );
    const write = graph.nodes.find(
      ({ kind, properties }) =>
        kind === "expression" && properties.operation_kind === "write",
    );
    const slot = graph.nodes.find(
      ({ kind, properties }) =>
        kind === "property-slot" && properties.property_pointer === pointer,
    );
    if (write === undefined || slot === undefined)
      throw new Error("Expected write and target slot");
    expect(graph.relations).toContainEqual(
      expect.objectContaining({
        source_node_id: write.node_id,
        target_node_id: slot.node_id,
        relation: "writes-property",
        resolution: resolved ? "resolved" : "candidate",
      }),
    );
    const trace = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: write.node_id },
      direction: "forward-influence",
      allowed_relations: ["writes-property"],
    });
    expect(trace.nodes.some(({ node_id }) => node_id === slot.node_id)).toBe(
      resolved,
    );
    if (!resolved)
      expect(graph.unknowns).toContainEqual(
        expect.objectContaining({
          node_id: slot.node_id,
          relation_kinds: ["writes-property"],
          detail: expect.stringContaining(
            "receiver is unresolved or not a retained container",
          ),
        }),
      );
  },
);

it("retains array length presence without inventing an exact length", () => {
  const graph = graphFor("const root = [, 1]; const length = root.length;");
  const slot = graph.nodes.find(
    ({ kind, properties }) =>
      kind === "property-slot" && properties.property_pointer === "/length",
  );
  expect(slot?.properties).toMatchObject({
    name: "length",
    presence: "present",
    value_status: "unknown",
  });
  const trace = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "property", name: "length" },
    direction: "forward-influence",
    allowed_relations: ["reads-property"],
  });
  expect(trace.seed_node_ids).toEqual([slot?.node_id]);
  expect(trace.relations).toContainEqual(
    expect.objectContaining({
      source_node_id: slot?.node_id,
      relation: "reads-property",
      resolution: "resolved",
    }),
  );
  expect(
    graph.relations.some(
      ({ target_node_id, relation }) =>
        target_node_id === slot?.node_id && relation === "defines",
    ),
  ).toBe(false);
});

it.each([
  ["object spread", 'const root = { known: "value", ...dynamic };'],
  ["array spread", 'const root = ["value", ...dynamic];'],
])(
  "keeps omitted initializer coverage on the owning binding: %s",
  (_label, source) => {
    const graph = graphFor(source);
    const root = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "root",
    );
    if (root === undefined) throw new Error("Expected root binding");
    const result = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: root.node_id },
      direction: "forward-influence",
    });

    expect(result.coverage.status).toBe("partial");
    expect(result.unknowns).toContainEqual(
      expect.objectContaining({
        node_id: root.node_id,
        family: "object-flow",
        reason: "ambiguous-target",
        detail: expect.stringContaining("Initializer container has unknown"),
      }),
    );
  },
);

it.each([
  ["bare if", 'if (flag) alias = { mode: "other" }; alias.mode = "updated";'],
  [
    "logical expression",
    'flag && (alias = { mode: "other" }); alias.mode = "updated";',
  ],
  [
    "logical assignment",
    'flag ||= (alias = { mode: "other" }); alias.mode = "updated";',
  ],
  ["or assignment", 'alias ||= { mode: "other" }; alias.mode = "updated";'],
  [
    "nullish assignment",
    'alias ??= { mode: "other" }; alias.mode = "updated";',
  ],
  [
    "conditional mutation",
    'alias = { mode: "other" }; if (flag) alias.mode = "updated";',
  ],
  [
    "short-circuit mutation",
    'alias = { mode: "other" }; flag && (alias.mode = "updated");',
  ],
])(
  "preserves possible alias mutation uncertainty in queries: %s",
  (_label, body) => {
    const graph = graphFor(`
    const shared = { mode: "initial" };
    let alias = shared;
    ${body}
  `);
    const sharedMode = graph.nodes.find(
      ({ kind, identity, properties }) =>
        kind === "property-slot" &&
        properties.property_pointer === "/mode" &&
        identity.role_key.includes("binding:shared"),
    );
    if (sharedMode === undefined) throw new Error("Expected shared mode slot");
    const result = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: sharedMode.node_id },
      direction: "backward-provenance",
    });

    expect(sharedMode.properties.presence).toBe("unknown-coverage");
    expect(result.nodes).toContainEqual(
      expect.objectContaining({ node_id: sharedMode.node_id }),
    );
    expect(result.coverage.status).toBe("partial");
  },
);

it.each(["{}", "unknownRoot", "{ a: null }"])(
  "preserves the requested deep leaf name after a blocked prefix: %s",
  (initializer) => {
    const graph = graphFor(
      `const root = ${initializer}; const selected = root.a.b.c;`,
    );
    const slot = graph.nodes.find(
      ({ kind, properties }) =>
        kind === "property-slot" && properties.property_pointer === "/a/b/c",
    );
    expect(slot).toMatchObject({
      label: "c",
      properties: {
        name: "c",
        property_path: ["a", "b", "c"],
        presence: "unknown-coverage",
        value_status: "unknown",
      },
    });
    const trace = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "property", name: "c" },
      direction: "backward-provenance",
      allowed_relations: ["defines"],
    });
    expect(trace.seed_node_ids).toEqual([slot?.node_id]);
    expect(trace.nodes.filter(({ kind }) => kind === "literal")).toEqual([]);
  },
);
