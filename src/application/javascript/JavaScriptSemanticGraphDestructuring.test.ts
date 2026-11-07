import { expect, it } from "vitest";
import { graphForJavaScript } from "../../../tests/fixtures/javascriptSemanticGraph.js";
import { queryJavaScriptSemanticGraph } from "../../domain/javascript/javascriptSemanticQuery.js";
import { javaScriptSemanticQueryInputSchema } from "../../domain/javascript/javascriptSemanticQuerySchemas.js";

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

it("retains resolved destructuring relation when a property is mutated after destructuring", () => {
  const graph = graphForJavaScript(`
    const config = { mode: "strict" };
    const { mode } = config;
    config.mode = "loose";
  `);
  const target = graph.nodes.find(
    (node) => node.kind === "binding" && node.label === "mode",
  );
  expect(target).toBeDefined();
  const relations = graph.relations.filter(
    (relation) =>
      relation.relation === "destructures" &&
      relation.target_node_id === target?.node_id,
  );
  expect(relations).toHaveLength(1);
  expect(relations[0]?.resolution).toBe("resolved");
  expect(
    graph.unknowns.filter((u) => u.relation_kinds.includes("destructures")),
  ).toHaveLength(0);

  const query = queryJavaScriptSemanticGraph(
    graph,
    javaScriptSemanticQueryInputSchema.parse({
      seed: { kind: "semantic-node", node_id: target!.node_id },
      direction: "backward-provenance",
    }),
  );
  expect(
    query.relations.some(
      (r) => r.relation === "destructures" && r.resolution === "resolved",
    ),
  ).toBe(true);
  expect(
    query.nodes.some((n) => n.kind === "property-slot" && n.label === "mode"),
  ).toBe(true);
});

it("keeps destructuring relation candidate when a property is mutated before destructuring", () => {
  const graph = graphForJavaScript(`
    const config = { mode: "strict" };
    config.mode = "loose";
    const { mode } = config;
  `);
  const target = graph.nodes.find(
    (node) => node.kind === "binding" && node.label === "mode",
  );
  expect(target).toBeDefined();
  const relations = graph.relations.filter(
    (relation) =>
      relation.relation === "destructures" &&
      relation.target_node_id === target?.node_id,
  );
  expect(relations).toHaveLength(1);
  expect(relations[0]?.resolution).toBe("candidate");
});

it("retains resolved destructuring relation in a function when property is mutated after destructuring", () => {
  const graph = graphForJavaScript(`
    function run() {
      const config = { mode: "strict" };
      const { mode } = config;
      config.mode = "loose";
    }
  `);
  const target = graph.nodes.find(
    (node) => node.kind === "binding" && node.label === "mode",
  );
  expect(target).toBeDefined();
  const relations = graph.relations.filter(
    (relation) =>
      relation.relation === "destructures" &&
      relation.target_node_id === target?.node_id,
  );
  expect(relations).toHaveLength(1);
  expect(relations[0]?.resolution).toBe("resolved");
  expect(
    graph.unknowns.filter((u) => u.relation_kinds.includes("destructures")),
  ).toHaveLength(0);

  const query = queryJavaScriptSemanticGraph(
    graph,
    javaScriptSemanticQueryInputSchema.parse({
      seed: { kind: "semantic-node", node_id: target!.node_id },
      direction: "backward-provenance",
    }),
  );
  expect(
    query.relations.some(
      (r) => r.relation === "destructures" && r.resolution === "resolved",
    ),
  ).toBe(true);
  expect(
    query.nodes.some((n) => n.kind === "property-slot" && n.label === "mode"),
  ).toBe(true);
});

it("keeps destructuring relation candidate when a property is mutated through an alias before destructuring", () => {
  const graph = graphForJavaScript(`
    const config = { mode: "strict" };
    const alias = config;
    delete alias.mode;
    const { mode } = config;
    config.mode = "loose";
  `);
  const target = graph.nodes.find(
    (node) => node.kind === "binding" && node.label === "mode",
  );
  expect(target).toBeDefined();
  const relations = graph.relations.filter(
    (relation) =>
      relation.relation === "destructures" &&
      relation.target_node_id === target?.node_id,
  );
  expect(relations).toHaveLength(1);
  expect(relations[0]?.resolution).toBe("candidate");
});

it("keeps destructuring relation candidate when a property is mutated inside a loop", () => {
  const graph = graphForJavaScript(`
    const config = { mode: "strict" };
    for (let i = 0; i < 2; i++) {
      const { mode } = config;
      delete config.mode;
    }
  `);
  const target = graph.nodes.find(
    (node) => node.kind === "binding" && node.label === "mode",
  );
  expect(target).toBeDefined();
  const relations = graph.relations.filter(
    (relation) =>
      relation.relation === "destructures" &&
      relation.target_node_id === target?.node_id,
  );
  expect(relations).toHaveLength(1);
  expect(relations[0]?.resolution).toBe("candidate");
});

it("keeps destructuring relation candidate when property was deleted before destructuring even with later variable assignment", () => {
  const graph = graphForJavaScript(`
    const config = { mode: "strict" };
    delete config.mode;
    let { mode } = config;
    mode = "later";
    config.mode = "loose";
  `);
  const target = graph.nodes.find(
    (node) => node.kind === "binding" && node.label === "mode",
  );
  expect(target).toBeDefined();
  const relations = graph.relations.filter(
    (relation) =>
      relation.relation === "destructures" &&
      relation.target_node_id === target?.node_id,
  );
  expect(relations).toHaveLength(1);
  expect(relations[0]?.resolution).toBe("candidate");
});

it("resolves destructuring relation for nested member expression initializer mutated later", () => {
  const graph = graphForJavaScript(`
    const config = { nested: { mode: "strict" } };
    const { mode } = config.nested;
    config.nested.mode = "loose";
  `);
  const target = graph.nodes.find(
    (node) => node.kind === "binding" && node.label === "mode",
  );
  expect(target).toBeDefined();
  const relations = graph.relations.filter(
    (relation) =>
      relation.relation === "destructures" &&
      relation.target_node_id === target?.node_id,
  );
  expect(relations).toHaveLength(1);
  expect(relations[0]?.resolution).toBe("resolved");
});
