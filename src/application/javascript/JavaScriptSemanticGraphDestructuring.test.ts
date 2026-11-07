import { expect, it } from "vitest";
import { javaScriptSemanticQueryInputSchema } from "../../domain/javascript/javascriptSemanticQuerySchemas.js";
import { queryJavaScriptSemanticGraph } from "../../domain/javascript/javascriptSemanticQuery.js";
import { graphForJavaScript } from "../../../tests/fixtures/javascriptSemanticGraph.js";

it.each(
  [
    { pattern: "{ a: selected }", source: "{ a: 1 }", path: ["a"] },
    { pattern: "[selected]", source: "[1]", path: ["0"] },
    {
      pattern: "{ a: [selected] = [] }",
      source: "{ a: [1] }",
      path: ["a", "0"],
    },
    {
      pattern: "{ a: { b: selected } = {} }",
      source: "{ a: { b: 1 } }",
      path: ["a", "b"],
    },
    { pattern: "[[selected] = []]", source: "[[1]]", path: ["0", "0"] },
  ].flatMap((pattern) =>
    [false, true].map((assignment) => ({ ...pattern, assignment })),
  ),
)(
  "retains source-property flow for $pattern, assignment=$assignment",
  ({ pattern, source, path, assignment }) => {
    const graph = graphForJavaScript(`
      const source = ${source};
      ${assignment ? `let selected; (${pattern} = source);` : `const ${pattern} = source;`}
    `);
    const target = graph.nodes.find(
      (node) => node.kind === "binding" && node.label === "selected",
    );
    expect(target).toBeDefined();
    const relations = graph.relations.filter(
      (relation) =>
        relation.relation === "destructures" &&
        relation.target_node_id === target?.node_id,
    );
    expect(relations).toHaveLength(1);
    expect(relations[0]?.resolution).toBe("resolved");
    const slot = graph.nodes.find(
      (node) => node.node_id === relations[0]?.source_node_id,
    );
    expect(slot?.properties.property_path).toEqual(path);
  },
);

it.each(["{}", "unknownSource"])(
  "keeps nested default source flow conservative for %s",
  (source) => {
    const graph = graphForJavaScript(
      `const source = ${source}; const { a: [selected] = [1] } = source;`,
    );
    const target = graph.nodes.find(
      (node) => node.kind === "binding" && node.label === "selected",
    );
    const relation = graph.relations.find(
      (item) =>
        item.relation === "destructures" &&
        item.target_node_id === target?.node_id,
    );
    expect(relation).toMatchObject({ resolution: "candidate" });
    expect(graph.unknowns).toContainEqual(
      expect.objectContaining({
        family: "object-flow",
        relation_kinds: ["destructures"],
      }),
    );
  },
);

it.each([
  [
    "object",
    'const config = { mode: "strict" }; const { mode: selected } = config; config.mode = "loose";',
    false,
  ],
  [
    "array",
    'const config = ["strict"]; const [selected] = config; config[0] = "loose";',
    false,
  ],
  [
    "nested",
    'const config = { nested: { mode: "strict" } }; const { nested: { mode: selected } } = config; config.nested.mode = "loose";',
    false,
  ],
  [
    "object assignment",
    'const config = { mode: "strict" }; let selected; ({ mode: selected } = config); config.mode = "loose";',
    true,
  ],
  [
    "array assignment",
    'const config = ["strict"]; let selected; [selected] = config; config[0] = "loose";',
    true,
  ],
  [
    "nested assignment",
    'const config = { nested: { mode: "strict" } }; let selected; ({ nested: { mode: selected } } = config); config.nested.mode = "loose";',
    true,
  ],
] as const)(
  "retains the captured property dependency before a later %s write",
  (_name, source, retainsUninitializedDefinition) => {
    const graph = graphForJavaScript(source);
    const selected = graph.nodes.find(
      (node) => node.kind === "binding" && node.label === "selected",
    );
    expect(selected).toBeDefined();
    const edge = graph.relations.find(
      (relation) =>
        relation.relation === "destructures" &&
        relation.target_node_id === selected?.node_id,
    );
    expect(edge).toMatchObject({ resolution: "resolved" });
    const trace = queryJavaScriptSemanticGraph(
      graph,
      javaScriptSemanticQueryInputSchema.parse({
        seed: { kind: "semantic-node", node_id: selected?.node_id },
        direction: "backward-provenance",
      }),
    );
    expect(trace.relations).toContainEqual(edge);
    if (retainsUninitializedDefinition)
      expect(trace.unknowns).toContainEqual(
        expect.objectContaining({
          family: "data-flow",
          reason: "unknown-value",
          node_id: selected?.node_id,
          relation_kinds: ["defines"],
        }),
      );
    else expect(trace.unknowns).toEqual([]);
  },
);

it.each([
  [
    "later deletion",
    'const config = { mode: "strict" }; const { mode: selected } = config; delete config.mode;',
    "resolved",
  ],
  [
    "different later key",
    'const config = { mode: "strict" }; const { mode: selected } = config; config.other = 1;',
    "resolved",
  ],
  [
    "earlier deletion",
    'const config = { mode: "strict" }; delete config.mode; const { mode: selected } = config;',
    "candidate",
  ],
  [
    "unknown source",
    "const config = unknownSource; const { mode: selected } = config;",
    "candidate",
  ],
  [
    "unknown mutation",
    'const config = { mode: "strict" }; mutate(config); const { mode: selected } = config;',
    "candidate",
  ],
  [
    "deferred read",
    'const config = { mode: "strict" }; function read() { const { mode: selected } = config; } delete config.mode; read();',
    "candidate",
  ],
  [
    "repeated function",
    'const config = { mode: "strict" }; function read() { const { mode: selected } = config; delete config.mode; } read(); read();',
    "candidate",
  ],
  [
    "repeated loop",
    'const config = { mode: "strict" }; for (let i = 0; i < 2; i++) { const { mode: selected } = config; delete config.mode; }',
    "candidate",
  ],
  [
    "earlier pattern default deletes the source",
    'const config = { mode: "strict" }; const { absent = delete config.mode, mode: selected } = config;',
    "candidate",
  ],
  [
    "custom array iterator",
    'const config = ["strict"]; config[Symbol.iterator] = function* () { yield "different"; }; const [selected] = config; config[0] = "loose";',
    "candidate",
  ],
  [
    "missing nested default",
    'const config = {}; const { nested: { mode: selected } = { mode: "strict" } } = config; config.nested = {};',
    "candidate",
  ],
  [
    "later assignment deletion",
    'const config = { mode: "strict" }; let selected; ({ mode: selected } = config); delete config.mode;',
    "resolved",
  ],
  [
    "earlier assignment deletion",
    'const config = { mode: "strict" }; let selected; delete config.mode; ({ mode: selected } = config);',
    "candidate",
  ],
  [
    "unknown assignment source",
    "const config = unknownSource; let selected; ({ mode: selected } = config);",
    "candidate",
  ],
  [
    "assignment default deletes source",
    'const config = { mode: "strict" }; let absent, selected; ({ absent = delete config.mode, mode: selected } = config);',
    "candidate",
  ],
  [
    "deferred assignment read",
    'const config = { mode: "strict" }; let selected; function read() { ({ mode: selected } = config); } delete config.mode; read();',
    "candidate",
  ],
  [
    "repeated assignment function",
    'const config = { mode: "strict" }; let selected; function read() { ({ mode: selected } = config); delete config.mode; } read(); read();',
    "candidate",
  ],
  [
    "repeated assignment loop",
    'const config = { mode: "strict" }; let selected; for (let i = 0; i < 2; i++) { ({ mode: selected } = config); delete config.mode; }',
    "candidate",
  ],
  [
    "custom assignment iterator",
    'const config = ["strict"]; let selected; config[Symbol.iterator] = function* () { yield "different"; }; [selected] = config; config[0] = "loose";',
    "candidate",
  ],
  [
    "missing nested assignment default",
    'const config = {}; let selected; ({ nested: { mode: selected } = { mode: "strict" } } = config); config.nested = {};',
    "candidate",
  ],
])(
  "keeps the %s dependency conservative where necessary",
  (_name, source, resolution) => {
    const graph = graphForJavaScript(source);
    const selected = graph.nodes.find(
      (node) => node.kind === "binding" && node.label === "selected",
    );
    const edge = graph.relations.find(
      (relation) =>
        relation.relation === "destructures" &&
        relation.target_node_id === selected?.node_id,
    );
    expect(edge).toMatchObject({ resolution });
  },
);
