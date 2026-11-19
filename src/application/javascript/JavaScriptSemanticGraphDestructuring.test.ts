import { expect, it } from "vitest";
import { graphForJavaScript } from "../../../tests/fixtures/javascriptSemanticGraph.js";

it.each([
  "const { mode: selected, fallback = 0 } = config;",
  'const { mode: selected, ["fallback"]: later } = config;',
  "const { mode: selected, nested: { fallback = 0 } } = config;",
  "const { mode: selected, ...later } = config;",
  "const { mode: selected, accessor: later } = config;",
  "let selected; const target = {}; ({ mode: selected, fallback: target.value } = config);",
])(
  "retains a proved read before a later unproven pattern operation",
  (read) => {
    const graph = graphForJavaScript(`
    const config = { mode: "strict", fallback: 0, nested: { fallback: 0 }, get accessor() { return 0; } };
    ${read}
    config.mode = "loose";
  `);
    const selected = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "selected",
    );
    expect(
      graph.relations.find(
        (edge) =>
          edge.relation === "destructures" &&
          edge.target_node_id === selected?.node_id,
      ),
    ).toMatchObject({ resolution: "resolved" });
  },
);

it("leaves the next read uncertain after a source-mutating assignment target", () => {
  const graph = graphForJavaScript(`
    const config = { first: 1, mode: "strict" };
    let selected;
    const target = { set value(_) { delete config.mode; } };
    ({ first: target.value, mode: selected } = config);
    config.mode = "loose";
  `);
  expect(
    graph.relations.find(({ relation }) => relation === "destructures"),
  ).toMatchObject({ resolution: "candidate" });
});

it.each([
  { read: "const { mode: selected } = config;", relation: "destructures" },
  {
    read: "let selected; ({ mode: selected } = config);",
    relation: "destructures",
  },
  { read: "const selected = config.mode;", relation: "reads-property" },
] as const)(
  "keeps earlier $relation at its read position",
  ({ read, relation }) => {
    const source = 'const config = { mode: "strict", other: 0 };';
    for (const [before, after, resolution] of [
      ["", 'config.mode = "loose";', "resolved"],
      ["", "config.other = 1;", "resolved"],
      ["delete config.mode;", "", "candidate"],
      ["mutate(config);", "", "candidate"],
    ]) {
      const graph = graphForJavaScript(
        [source, before, read, after].join("\n"),
      );
      expect(
        graph.relations.find((edge) => edge.relation === relation),
      ).toMatchObject({ resolution });
    }
  },
);

it("keeps a direct nested data-slot dependency after a later write", () => {
  const graph = graphForJavaScript(`
    const config = { nested: { mode: "strict" } };
    const { mode: selected } = config.nested;
    config.nested.mode = "loose";
  `);
  expect(
    graph.relations.find(({ relation }) => relation === "destructures"),
  ).toMatchObject({ resolution: "resolved" });
});

it.each([
  `const config = { mode: "strict" }; const { first = (delete config.mode), mode: selected } = config;`,
  `const config = { get first() { delete this.mode; return {}; }, mode: "strict" };
   const { first: {}, mode: selected } = config;`,
])(
  "leaves a dependency uncertain after an effectful earlier pattern lookup",
  (source) => {
    const graph = graphForJavaScript(source + 'config.mode = "loose";');
    const selected = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "selected",
    );
    expect(
      graph.relations.find(
        (edge) =>
          edge.relation === "destructures" &&
          edge.target_node_id === selected?.node_id,
      ),
    ).toMatchObject({ resolution: "candidate" });
  },
);

it("links declared and assigned destructuring bindings to their exact source slots", () => {
  const cases = [
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
  ];
  const graph = graphForJavaScript(
    cases
      .map(({ pattern, source }, index) =>
        [
          `const source${index} = ${source};`,
          `const ${pattern.replace("selected", `declared${index}`)} = source${index};`,
          `let assigned${index};`,
          `(${pattern.replace("selected", `assigned${index}`)} = source${index});`,
        ].join("\n"),
      )
      .join("\n"),
  );
  const nodes = new Map(graph.nodes.map((node) => [node.node_id, node]));
  expect(
    graph.relations
      .filter(({ relation }) => relation === "destructures")
      .map(({ source_node_id, target_node_id, resolution }) => ({
        target: nodes.get(target_node_id)?.label,
        path: nodes.get(source_node_id)?.properties.property_path,
        resolution,
      }))
      .sort((left, right) =>
        String(left.target).localeCompare(String(right.target)),
      ),
  ).toEqual(
    ["assigned", "declared"].flatMap((form) =>
      cases.map(({ path }, index) => ({
        target: `${form}${index}`,
        path,
        resolution: "resolved",
      })),
    ),
  );
});

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
  ["ordinary array", "", "resolved"],
  ["prototype read alone", "Object.getPrototypeOf([].values());", "resolved"],
  [
    "one iterator's own next",
    "const iterator = [].values(); iterator.next = replacement;",
    "resolved",
  ],
  [
    "unrelated custom iterator",
    "const iterator = Object.create({ next: original }); Object.getPrototypeOf(iterator).next = replacement;",
    "resolved",
  ],
  [
    "direct prototype assignment",
    "Object.getPrototypeOf([][Symbol.iterator]()).next = replacement;",
    "candidate",
  ],
  [
    "aliased iterator and prototype",
    "const array = []; const iterator = array.values(); const p = Reflect.getPrototypeOf(iterator); const alias = p; alias.next = replacement;",
    "candidate",
  ],
  [
    "explicit builtin factory",
    "const iterator = Array.prototype.values.call([]); Object.getPrototypeOf(iterator).next = replacement;",
    "candidate",
  ],
  [
    "descriptor",
    'const prototype = Object.getPrototypeOf([].keys()); Object.defineProperty(prototype, "next", { value: replacement });',
    "candidate",
  ],
  [
    "typed array iterator sharing the prototype",
    "const bytes = new Uint8Array(); Object.getPrototypeOf(bytes.values()).next = replacement;",
    "candidate",
  ],
  [
    "separate Map iterator prototype",
    "Object.getPrototypeOf(new Map().values()).next = replacement;",
    "resolved",
  ],
  ["whole iterator escape", "consume([].values());", "candidate"],
  [
    "iterator nested in an escaping container",
    "const box = { iterator: [].entries() }; consume(box);",
    "candidate",
  ],
  [
    "array receiver in a stored property",
    "const box = { items: [] }; Object.getPrototypeOf(box.items.values()).next = replacement;",
    "candidate",
  ],
  [
    "typed array receiver through aliased properties",
    "const box = { items: new Uint8Array() }; const alias = box; Object.getPrototypeOf(alias.items.values()).next = replacement;",
    "candidate",
  ],
  [
    "array receiver through a member assignment",
    "const box = {}; box.items = []; Object.getPrototypeOf(box.items.values()).next = replacement;",
    "candidate",
  ],
  [
    "member assignment after the iterator was obtained",
    "const box = { items: new Map() }; const iterator = box.items.values(); box.items = []; Object.getPrototypeOf(iterator).next = replacement;",
    "resolved",
  ],
  [
    "replaced prototype inspector receives the iterator",
    "Reflect.getPrototypeOf = opaque; Reflect.getPrototypeOf([].values());",
    "candidate",
  ],
  [
    "object property with unrelated iterator",
    "const box = { items: new Map() }; Object.getPrototypeOf(box.items.values()).next = replacement;",
    "resolved",
  ],
  [
    "read-only alias to getPrototypeOf",
    "const inspect = Reflect.getPrototypeOf; const iterator = [].values(); inspect(iterator);",
    "resolved",
  ],
  [
    "prototype escape",
    "consume(Object.getPrototypeOf([].entries()));",
    "candidate",
  ],
  [
    "non-next property",
    "Object.getPrototypeOf([].values()).other = replacement;",
    "resolved",
  ],
] as const)(
  "attributes array iterator effects for %s",
  (_name, change, resolution) => {
    const graph = graphForJavaScript(`
    const config = ["original"];
    const replacement = () => ({ value: "other", done: false });
    ${change}
    const [selected] = config;
  `);
    const selected = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "selected",
    );
    expect(
      graph.relations.find(
        (relation) =>
          relation.relation === "destructures" &&
          relation.target_node_id === selected?.node_id,
      ),
    ).toMatchObject({ resolution });
  },
);

it("leaves an earlier destructuring dependency intact before an iterator prototype write", () => {
  const graph = graphForJavaScript(`
    const config = ["original"];
    const [selected] = config;
    Object.getPrototypeOf([].values()).next = () => ({ value: "other", done: false });
  `);
  const selected = graph.nodes.find(
    ({ kind, label }) => kind === "binding" && label === "selected",
  );
  expect(
    graph.relations.find(
      (relation) =>
        relation.relation === "destructures" &&
        relation.target_node_id === selected?.node_id,
    ),
  ).toMatchObject({ resolution: "resolved" });
});
