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
    "packed direct prototype read",
    "Reflect.getPrototypeOf(...[[].values()]);",
    "resolved",
  ],
  [
    "method apply prototype read",
    "Reflect.getPrototypeOf.apply(null, [[].values()]);",
    "resolved",
  ],
  [
    "Reflect.apply prototype read",
    "Reflect.apply(Reflect.getPrototypeOf, null, [[].values()]);",
    "resolved",
  ],
  [
    "packed prototype read with another ignored iterator argument",
    "Reflect.apply(Reflect.getPrototypeOf, null, [[].values(), [].values()]);",
    "resolved",
  ],
  [
    "ignored iterator passed directly to native inspection",
    "Reflect.getPrototypeOf({}, [].values());",
    "resolved",
  ],
  [
    "ignored iterator passed through method apply",
    "Reflect.getPrototypeOf.apply(null, [{}, [].values()]);",
    "resolved",
  ],
  [
    "opaque aliased apply pack",
    "const args = [{}, [].values()]; Reflect.apply(Reflect.getPrototypeOf, null, args);",
    "candidate",
  ],
  [
    "opaque inspector receives extra iterator",
    "Reflect.getPrototypeOf = opaque; Reflect.getPrototypeOf({}, [].values());",
    "candidate",
  ],
  [
    "opaque Reflect.apply receives packed extra iterator",
    "Reflect.apply = opaque; Reflect.apply(Reflect.getPrototypeOf, null, [{}, [].values()]);",
    "candidate",
  ],
  [
    "ignored argument evaluation can still expose the iterator",
    "Reflect.getPrototypeOf({}, consume([].values()));",
    "candidate",
  ],
  [
    "ignored packaged argument evaluation can change the prototype",
    "Reflect.apply(Reflect.getPrototypeOf, null, [{}, (Object.getPrototypeOf([].values()).next = replacement)]);",
    "candidate",
  ],
  [
    "native inspection of the shared prototype",
    "const p = Object.getPrototypeOf([].values()); Object.getPrototypeOf(p);",
    "resolved",
  ],
  [
    "nested direct native inspection of the shared prototype",
    "Object.getPrototypeOf(Object.getPrototypeOf([].values()));",
    "resolved",
  ],
  [
    "actual shared-prototype exposure",
    "const p = Object.getPrototypeOf([].values()); consume(p);",
    "candidate",
  ],
  [
    "overwritten inspector receives the shared prototype",
    "const p = Object.getPrototypeOf([].values()); Object.getPrototypeOf = opaque; Object.getPrototypeOf(p);",
    "candidate",
  ],
  [
    "read-only bound inspector",
    "const inspect = Reflect.getPrototypeOf.bind(null); inspect({}, [].values());",
    "resolved",
  ],
  [
    "opaque replacement of bind before creating the inspector",
    "Function.prototype.bind = opaque; const inspect = Reflect.getPrototypeOf.bind(null); inspect({}, [].values());",
    "candidate",
  ],
  [
    "opaque packed argument exposure precedes an earlier deferred inspection",
    "const iterator = [].values(); function inspect() { Object.getPrototypeOf({}, iterator); } Reflect.apply = opaque; Reflect.apply(Reflect.getPrototypeOf, null, [{}], Object); inspect();",
    "candidate",
  ],
  [
    "two helper exposures can invalidate a deferred inspection",
    "const iterator = [].values(); function inspect() { Reflect.getPrototypeOf({}, iterator); } function expose() { Object.getPrototypeOf({}, Reflect); } Reflect.apply = opaque; Reflect.apply(Reflect.getPrototypeOf, null, [{}], Object); expose(); inspect();",
    "candidate",
  ],
  [
    "opaque replacement of Reflect.apply",
    "Reflect.apply = opaque; Reflect.apply(Reflect.getPrototypeOf, null, [[].values()]);",
    "candidate",
  ],
  [
    "opaque replacement of Function.prototype.apply",
    "Function.prototype.apply = opaque; Reflect.getPrototypeOf.apply(null, [[].values()]);",
    "candidate",
  ],
  [
    "native inspector captured before replacement",
    "const inspect = Reflect.getPrototypeOf; Reflect.getPrototypeOf = opaque; inspect([].values());",
    "resolved",
  ],
  [
    "inspector captured after replacement",
    "Reflect.getPrototypeOf = opaque; const inspect = Reflect.getPrototypeOf; inspect([].values());",
    "candidate",
  ],
  [
    "property captured before an array store",
    "const box = { items: new Map() }; const captured = box.items; box.items = []; Object.getPrototypeOf(captured.values()).next = replacement;",
    "resolved",
  ],
  [
    "destructured property captured before an array store",
    "const box = { items: new Map() }; const { items: captured } = box; box.items = []; Object.getPrototypeOf(captured.values()).next = replacement;",
    "resolved",
  ],
  [
    "property captured after an array store",
    "const box = { items: new Map() }; box.items = []; const captured = box.items; Object.getPrototypeOf(captured.values()).next = replacement;",
    "candidate",
  ],
  [
    "captured parent still observes a later child store",
    "const box = { parent: { items: new Map() } }; const captured = box.parent; box.parent.items = []; Object.getPrototypeOf(captured.items.values()).next = replacement;",
    "candidate",
  ],
  [
    "separately captured parent and child before a later store",
    "const box = { parent: { items: new Map() } }; const parent = box.parent; const captured = parent.items; box.parent.items = []; Object.getPrototypeOf(captured.values()).next = replacement;",
    "resolved",
  ],
  [
    "Reflect.apply is distinct from Function.prototype.apply",
    "Function.prototype.apply = opaque; Reflect.apply(Reflect.getPrototypeOf, null, [[].values()]);",
    "resolved",
  ],
  [
    "projected argument captured before an array store",
    "const box = { items: new Map() }; ((captured) => { Object.getPrototypeOf(captured.values()).next = replacement; })(box.items); box.items = [];",
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

it.each([
  ["declaration", "const [selected] = config;", "resolved"],
  ["assignment", "let selected; [selected] = config;", "resolved"],
  ["unrelated write", "config[1] = 2; const [selected] = config;", "resolved"],
  ["later default", "const [selected, missing = 0] = config;", "resolved"],
  [
    "earlier delete",
    "delete config[0]; const [selected] = config;",
    "candidate",
  ],
  [
    "earlier truncation",
    "config.length = 0; const [selected] = config;",
    "candidate",
  ],
  [
    "own custom iterator",
    "config[Symbol.iterator] = function* () { yield 2; }; const [selected] = config;",
    "candidate",
  ],
  [
    "prototype iterator",
    "Array.prototype[Symbol.iterator] = function* () { yield 2; }; const [selected] = config;",
    "candidate",
  ],
  [
    "earlier shared next replacement",
    'Object.getPrototypeOf([].values()).next = () => ({ value: "other", done: false }); const [selected] = config;',
    "candidate",
  ],
  [
    "later shared next replacement",
    'const [selected] = config; Object.getPrototypeOf([].values()).next = () => ({ value: "other", done: false });',
    "resolved",
  ],
  [
    "custom prototype",
    "Object.setPrototypeOf(config, { *[Symbol.iterator]() { yield 2; } }); const [selected] = config;",
    "candidate",
  ],
  ["earlier default", "const [value = 0, selected] = config;", "candidate"],
  [
    "earlier setter",
    "let selected; const target = { set value(_) { config[1] = 2; } }; [target.value, selected] = config;",
    "candidate",
  ],
  ["nested binding", "let selected; [[selected]] = config;", "candidate"],
] as const)(
  "preserves array iteration dependencies for %s",
  (_name, read, resolution) => {
    const graph = graphForJavaScript(`
    const config = [[1], 1];
    ${read}
    config[0] = 2;
    config[1] = 2;
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
    ).toMatchObject({ resolution });
  },
);

const objectAliasRead = "const { mode: selected } = alias;";
const arrayAliasRead = "let selected; [selected] = alias;";

it.each([
  [
    "object write through the original after the read",
    false,
    objectAliasRead + "base.mode = 2;",
    "resolved",
  ],
  [
    "object write through the alias after the read",
    false,
    objectAliasRead + "alias.mode = 2;",
    "resolved",
  ],
  [
    "object write through the original before the read",
    false,
    "base.mode = 2;" + objectAliasRead,
    "candidate",
  ],
  [
    "object write through the alias before the read",
    false,
    "alias.mode = 2;" + objectAliasRead,
    "candidate",
  ],
  [
    "object delete through the original before the read",
    false,
    "delete base.mode;" + objectAliasRead,
    "candidate",
  ],
  [
    "object delete through the alias before the read",
    false,
    "delete alias.mode;" + objectAliasRead,
    "candidate",
  ],
  [
    "object write to an unrelated slot",
    false,
    "alias.other = 2;" + objectAliasRead + "base.mode = 2;",
    "resolved",
  ],
  [
    "object multi-hop aliases",
    false,
    "const lifted = alias; const final = lifted; const {mode: selected} = final; base.mode = 2;",
    "resolved",
  ],
  [
    "object alias passed to opaque code",
    false,
    "mutate(alias);" + objectAliasRead + "base.mode = 2;",
    "candidate",
  ],
  [
    "array write through the original after the read",
    true,
    arrayAliasRead + "base[0] = 2;",
    "resolved",
  ],
  [
    "array write through the alias after the read",
    true,
    arrayAliasRead + "alias[0] = 2;",
    "resolved",
  ],
  [
    "array write through the original before the read",
    true,
    "base[0] = 2;" + arrayAliasRead,
    "candidate",
  ],
  [
    "array write through the alias before the read",
    true,
    "alias[0] = 2;" + arrayAliasRead,
    "candidate",
  ],
  [
    "array shortened through the original before the read",
    true,
    "base.length = 0;" + arrayAliasRead + "alias[0] = 2;",
    "candidate",
  ],
  [
    "array shortened through the alias before the read",
    true,
    "alias.length = 0;" + arrayAliasRead + "base[0] = 2;",
    "candidate",
  ],
  [
    "array multi-hop aliases",
    true,
    "const lifted = alias; let selected; [selected] = lifted; alias[0] = 2;",
    "resolved",
  ],
  [
    "array instance iterator replaced through the original",
    true,
    "base[Symbol.iterator] = replacement;" + arrayAliasRead + "alias[0] = 2;",
    "candidate",
  ],
  [
    "array instance iterator replaced through the alias",
    true,
    "alias[Symbol.iterator] = replacement;" + arrayAliasRead + "base[0] = 2;",
    "candidate",
  ],
  [
    "array prototype iterator replaced before the read",
    true,
    "Array.prototype[Symbol.iterator] = replacement;" +
      arrayAliasRead +
      "base[0] = 2;",
    "candidate",
  ],
  [
    "shared iterator next replaced before the read",
    true,
    "Object.getPrototypeOf([].values()).next = replacement;" +
      arrayAliasRead +
      "base[0] = 2;",
    "candidate",
  ],
  [
    "shared iterator next replaced after the read",
    true,
    arrayAliasRead +
      "Object.getPrototypeOf([].values()).next = replacement; base[0] = 2;",
    "resolved",
  ],
] as const)(
  "keeps read-time dependencies for %s",
  (_name, array, reads, resolution) => {
    const graph = graphForJavaScript(`
      const replacement = () => ({ value: 3, done: false });
      const base = ${array ? "[1, 0]" : "{ mode: 1, other: 0 }"};
      const alias = base;
      ${reads}
    `);
    const selected = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "selected",
    );
    const relation = graph.relations.find(
      (edge) =>
        edge.relation === "destructures" &&
        edge.target_node_id === selected?.node_id,
    );
    expect(relation).toMatchObject({ resolution });
  },
);

it.each([
  [
    "getter",
    "const base = { get mode() { return 1; } }; const alias = base; " +
      objectAliasRead +
      "alias.mode = 2;",
  ],
  [
    "rebound source",
    "let base = { mode: 1 }; const alias = base; base = { mode: 2 }; " +
      objectAliasRead +
      "alias.mode = 3;",
  ],
  [
    "rebound alias",
    "const base = { mode: 1 }; let alias = base; alias = { mode: 2 }; " +
      objectAliasRead +
      "alias.mode = 3;",
  ],
  [
    "read before source initializer",
    "const alias = base; const base = { mode: 1 }; " +
      objectAliasRead +
      "base.mode = 2;",
  ],
] as const)("leaves %s uncertain in the const alias proof", (_name, source) => {
  const graph = graphForJavaScript(source);
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
});

it.each([
  ["", "base.mode = 2;", "resolved"],
  ["base.mode = 2;", "", "candidate"],
] as const)(
  "uses the allocation's effect ordering for a direct alias property read (%s)",
  (before, after, resolution) => {
    const graph = graphForJavaScript(`
      const base = { mode: 1 };
      const alias = base;
      ${before}
      const selected = alias.mode;
      ${after}
    `);
    expect(
      graph.relations.find(({ relation }) => relation === "reads-property"),
    ).toMatchObject({ resolution });
  },
);

it.each([
  [
    "declaration",
    "[0, 1]",
    "const [,selected] = config; config[1] = 2;",
    "/1",
    "resolved",
  ],
  [
    "assignment",
    "[0, 1]",
    "let selected; [,selected] = config; config[1] = 2;",
    "/1",
    "resolved",
  ],
  [
    "const alias",
    "[0, 1]",
    "const alias = config; const [,selected] = alias; config[1] = 2;",
    "/1",
    "resolved",
  ],
  [
    "two elisions",
    "[0, 1, 2]",
    "const [,,selected] = config; config[2] = 3;",
    "/2",
    "resolved",
  ],
  [
    "array hole",
    "[, 1]",
    "const [,selected] = config; config[1] = 2;",
    "/1",
    "candidate",
  ],
  [
    "previous deletion",
    "[0, 1]",
    "delete config[0]; const [,selected] = config; config[1] = 2;",
    "/1",
    "candidate",
  ],
  [
    "skipped getter",
    "[0, 1]",
    'Object.defineProperty(config, "0", {get(){delete this[1]; return 0;}}); const [,selected] = config;',
    "/1",
    "candidate",
  ],
  [
    "replaced iterator",
    "[0, 1]",
    "Object.getPrototypeOf([].values()).next = () => ({value: 3, done: false}); const [,selected] = config; config[1] = 2;",
    "/1",
    "candidate",
  ],
] as const)(
  "preserves exactly the proved array elision dependencies for %s",
  (_name, initial, source, pointer, resolution) => {
    const graph = graphForJavaScript(`const config = ${initial}; ${source}`);
    const selected = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "selected",
    );
    const edges = graph.relations.filter(
      ({ relation }) => relation === "destructures",
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      target_node_id: selected?.node_id,
      resolution,
    });
    expect(
      graph.nodes.find(({ node_id }) => node_id === edges[0]?.source_node_id)
        ?.properties.property_pointer,
    ).toBe(pointer);
  },
);

it.each([
  [
    "later write",
    "const box = { items: [1] };",
    "const [selected] = box.items; box.items[0] = 2;",
    ["items", "0"],
    "resolved",
  ],
  [
    "later replacement",
    "const box = { items: [1] };",
    "const [selected] = box.items; box.items = [2];",
    ["items", "0"],
    "resolved",
  ],
  [
    "later replacement after assignment",
    "const box = { items: [1] };",
    "let selected; [selected] = box.items; box.items = [2];",
    ["items", "0"],
    "resolved",
  ],
  [
    "later write through the original",
    "const box = { items: [1] }; const alias = box;",
    "const [selected] = alias.items; box.items[0] = 2;",
    ["items", "0"],
    "resolved",
  ],
  [
    "later write through the alias",
    "const box = { items: [1] }; const alias = box;",
    "const [selected] = box.items; alias.items[0] = 2;",
    ["items", "0"],
    "resolved",
  ],
  [
    "nested own-data receiver",
    "const box = { nested: { items: [1] } }; const alias = box;",
    'const [selected] = alias.nested["items"]; box.nested.items[0] = 2;',
    ["nested", "items", "0"],
    "resolved",
  ],
  [
    "skipping an own slot of the projected array",
    "const box = { items: [0, 1] }; const alias = box;",
    "const [,selected] = alias.items; box.items[1] = 2;",
    ["items", "1"],
    "resolved",
  ],
  [
    "earlier write",
    "const box = { items: [1] };",
    "box.items[0] = 2; const [selected] = box.items;",
    ["items", "0"],
    "candidate",
  ],
  [
    "earlier write through the original",
    "const box = { items: [1] }; const alias = box;",
    "box.items[0] = 2; const [selected] = alias.items;",
    ["items", "0"],
    "candidate",
  ],
  [
    "earlier write through the alias",
    "const box = { items: [1] }; const alias = box;",
    "alias.items[0] = 2; const [selected] = box.items;",
    ["items", "0"],
    "candidate",
  ],
  [
    "earlier shortening",
    "const box = { items: [1] }; const alias = box;",
    "alias.items.length = 0; const [selected] = box.items;",
    ["items", "0"],
    "candidate",
  ],
  [
    "earlier receiver replacement",
    "const box = { items: [1] }; const alias = box;",
    "box.items = unknown; const [selected] = alias.items;",
    ["items", "0"],
    "candidate",
  ],
  [
    "rebound source",
    "let box = { items: [1] }; const alias = box; box = { items: [2] };",
    "const [selected] = alias.items; alias.items[0] = 2;",
    ["items", "0"],
    "candidate",
  ],
  [
    "getter",
    "const box = { get items() { return [1]; } };",
    "const [selected] = box.items;",
    ["items", "0"],
    "candidate",
  ],
  [
    "inherited data",
    "const box = { __proto__: { items: [1] } };",
    "const [selected] = box.items;",
    ["items", "0"],
    "candidate",
  ],
  [
    "earlier getter replacement",
    "const box = { items: [1] };",
    'Object.defineProperty(box, "items", { get() { return [2]; } }); const [selected] = box.items;',
    ["items", "0"],
    "candidate",
  ],
  [
    "earlier own iterator replacement",
    "const box = { items: [1] }; const alias = box;",
    "alias.items[Symbol.iterator] = function* () { yield 2; }; const [selected] = box.items;",
    ["items", "0"],
    "candidate",
  ],
  [
    "earlier custom array prototype",
    "const box = { items: [1] };",
    "Object.setPrototypeOf(box.items, { *[Symbol.iterator]() { yield 2; } }); const [selected] = box.items;",
    ["items", "0"],
    "candidate",
  ],
  [
    "earlier shared next replacement",
    "const box = { items: [1] };",
    "Object.getPrototypeOf([].values()).next = () => ({ done: true }); const [selected] = box.items;",
    ["items", "0"],
    "candidate",
  ],
  [
    "opaque receiver escape",
    "const box = { items: [1] };",
    "consume(box.items); const [selected] = box.items;",
    ["items", "0"],
    "candidate",
  ],
  [
    "earlier target setter",
    "const box = { items: [1, 2] }; const target = { set value(_) { box.items[1] = 3; } };",
    "let selected; [target.value, selected] = box.items;",
    ["items", "1"],
    "candidate",
  ],
  [
    "effectful key",
    "const box = { undefined: [1] };",
    "const [selected] = box[void (box.undefined.length = 0)];",
    ["undefined", "0"],
    "candidate",
  ],
] as const)(
  "uses the projected array's own data and iteration for %s",
  (_name, setup, read, propertyPath, resolution) => {
    const graph = graphForJavaScript(`${setup} ${read}`);
    const selected = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "selected",
    );
    const edge = graph.relations.find(
      ({ relation, target_node_id }) =>
        relation === "destructures" && target_node_id === selected?.node_id,
    );
    expect(edge).toMatchObject({ resolution });
    expect(
      graph.nodes.find(({ node_id }) => node_id === edge?.source_node_id)
        ?.properties.property_path,
    ).toEqual(propertyPath);
  },
);
