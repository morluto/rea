import { expect, it } from "vitest";
import { graphForJavaScript } from "../../../tests/fixtures/javascriptSemanticGraph.js";

it.each([
  [
    "reflected prototype",
    "const protos=[...[Object.getPrototypeOf([])]];protos[0][Symbol.iterator]=function*(){};",
    "candidate",
  ],
  [
    "reflected iterator next",
    "const protos=[...[Reflect.getPrototypeOf([].values())]];Reflect.set(protos[0], 'next', ()=>({done:true}));",
    "candidate",
  ],
  [
    "reflective receiver in an earlier call",
    "configure();function configure(){const protos=[...[Reflect.getPrototypeOf([])]];protos[0][Symbol.iterator]=function*(){}}",
    "candidate",
  ],
  [
    "a stored prototype passed to an earlier call",
    "const protos=[...[Object.getPrototypeOf([])]];disable(protos[0]);function disable(p){p[Symbol.iterator]=function*(){}}",
    "candidate",
  ],
  [
    "an unknown projected index",
    "const protos=[...[Object.getPrototypeOf([])]];protos[index][Symbol.iterator]=function*(){};",
    "candidate",
  ],
  [
    "an array operand borrowed through an alias",
    "const source=[Object.getPrototypeOf([])];const protos=[...source];protos[0][Symbol.iterator]=function*(){};",
    "candidate",
  ],
  [
    "a prototype selected by destructuring",
    "const protos=[...[Object.getPrototypeOf([])]];const [p]=protos;p[Symbol.iterator]=function*(){};",
    "candidate",
  ],
  [
    "a prototype selected by nested destructuring",
    "const [[p]]=[...[[Object.getPrototypeOf([])]]];p[Symbol.iterator]=function*(){};",
    "candidate",
  ],
  [
    "a quoted index",
    'const protos=[...[Object.getPrototypeOf([])]];protos["0"][Symbol.iterator]=function*(){};',
    "candidate",
  ],
  [
    "a folded index",
    "const protos=[...[Object.getPrototypeOf([])]];protos[0+0][Symbol.iterator]=function*(){};",
    "candidate",
  ],
  [
    "an earlier disjoint slot",
    "const protos=[{},...[Object.getPrototypeOf([])]];protos[0][Symbol.iterator]=function*(){};",
    "resolved",
  ],
  [
    "a shadowed prototype reader",
    "const Object={getPrototypeOf(){return {}}};const protos=[...[Object.getPrototypeOf([])]];protos[0][Symbol.iterator]=function*(){};",
    "resolved",
  ],
] as const)(
  "keeps iterator evidence sound through %s stored in an array with spread",
  (_name, edit, resolution) => {
    const graph = graphForJavaScript(
      `${edit} const pairs=[["before"]];const [[selected]]=pairs;pairs[0][0]="later";`,
    );
    const target = graph.nodes.find(
      (node) => node.kind === "binding" && node.label === "selected",
    );
    const relation = graph.relations.find(
      (edge) =>
        edge.relation === "destructures" &&
        edge.target_node_id === target?.node_id,
    );
    expect(relation).toMatchObject({ resolution });
  },
);

it.each([
  [
    "a copied slot",
    'const items=[...["old"]];const [selected]=items;items[0]="late";',
    ["0"],
    "resolved",
  ],
  [
    "indices after a dense spread",
    'const items=[...["prefix"],"old"];const [,selected]=items;items[1]="late";',
    ["1"],
    "resolved",
  ],
  [
    "nested inline spread",
    'const items=[...[...["prefix","old"]]];const [,selected]=items;items[1]="late";',
    ["1"],
    "resolved",
  ],
  [
    "an empty spread",
    'const items=[...[],"old"];const [selected]=items;items[0]="late";',
    ["0"],
    "resolved",
  ],
  [
    "an object reached after a spread",
    'const items=[...[{mode:"a"}],{mode:"b"}];const [,{mode:selected}]=items;items[1].mode="late";',
    ["1", "mode"],
    "resolved",
  ],
  [
    "an opaque operand",
    'const items=[...other,"old"];const [selected]=items;items[0]="late";',
    ["0"],
    "candidate",
  ],
  [
    "a sparse operand",
    'const items=[...[,],"old"];const [,selected]=items;items[1]="late";',
    ["1"],
    "candidate",
  ],
  [
    "iterator replaced during operand evaluation",
    'const items=[...[(Object.getPrototypeOf([].values()).next=()=>({done:true}),"x")],"old"];const [selected]=items;items[0]="late";',
    ["0"],
    "candidate",
  ],
  [
    "iterator replaced between spread and pattern",
    'const items=[...["x"],"old"];Object.getPrototypeOf([].values()).next=()=>({done:true});const [,selected]=items;',
    ["1"],
    "candidate",
  ],
  [
    "iterator replaced after both acquisitions",
    'const items=[...["x"],"old"];const [,selected]=items;Object.getPrototypeOf([].values()).next=()=>({done:true});items[1]="late";',
    ["1"],
    "resolved",
  ],
] as const)(
  "tracks %s in an array literal",
  (_name, source, path, resolution) => {
    const graph = graphForJavaScript(source);
    const target = graph.nodes.find(
      (node) => node.kind === "binding" && node.label === "selected",
    );
    const relation = graph.relations.find(
      (edge) =>
        edge.relation === "destructures" &&
        edge.target_node_id === target?.node_id,
    );
    expect(relation).toMatchObject({ resolution });
    expect(
      graph.nodes.find((node) => node.node_id === relation?.source_node_id)
        ?.properties.property_path,
    ).toEqual(path);
  },
);

it.each([
  [
    "an earlier call",
    "configure();",
    "function configure() { Array.prototype[Symbol.iterator] = function* () {}; }",
  ],
  [
    "a reflected prototype alias",
    "const proto = Object.getPrototypeOf([]); proto[Symbol.iterator] = function* () {};",
    "",
  ],
  [
    "an earlier call through a reflected alias",
    "configure();",
    "function configure() { const proto = Reflect.getPrototypeOf([]); proto[Symbol.iterator] = function* () {}; }",
  ],
  [
    "a reflected prototype stored by spread",
    "const protos = [...[Object.getPrototypeOf([])]]; protos[0][Symbol.iterator] = function* () {};",
    "",
  ],
  [
    "a reflected iterator prototype stored by spread",
    "const protos = [...[Reflect.getPrototypeOf([].values())]]; Reflect.set(protos[0], 'next', () => ({ done: true }));",
    "",
  ],
])(
  "keeps the selected reference uncertain when %s replaces the spread iterator",
  (_name, before, after) => {
    const graph = graphForJavaScript(`
    const source = {mode: "source"}, tail = {mode: "tail"};
    ${before}
    const items = [...[source], tail];
    items[0].mode = "changed";
    const {mode: selected} = tail;
    ${after}
  `);
    const target = graph.nodes.find(
      (node) => node.kind === "binding" && node.label === "selected",
    );
    expect(
      graph.relations.find(
        (edge) =>
          edge.relation === "destructures" &&
          edge.target_node_id === target?.node_id,
      ),
    ).toMatchObject({ resolution: "candidate" });
  },
);

it.each([
  [0, "a", "candidate"],
  [0, "b", "resolved"],
  [1, "a", "resolved"],
  [1, "b", "candidate"],
] as const)(
  "retains only actual copies after an array literal write to slot %s, read of %s",
  (index, receiver, resolution) => {
    const graph = graphForJavaScript(
      `const a={mode:"a"},b={mode:"b"};const items=[...[a],b];items[${index}].mode="changed";const {mode:selected}=${receiver};`,
    );
    const target = graph.nodes.find(
      (node) => node.kind === "binding" && node.label === "selected",
    );
    const relation = graph.relations.find(
      (edge) =>
        edge.relation === "destructures" &&
        edge.target_node_id === target?.node_id,
    );
    expect(relation).toMatchObject({ resolution });
  },
);

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
    "custom iterator from an inline spread slot",
    "const items = [...[{ values() { return {}; } }]]; Object.getPrototypeOf(items[0].values()).next = replacement;",
    "resolved",
  ],
  [
    "native array from an inline spread slot",
    "const items = [0, ...[[]]]; Object.getPrototypeOf(items[1].values()).next = replacement;",
    "candidate",
  ],
  [
    "typed array from a borrowed spread slot",
    "const source = [new Uint8Array()]; const items = [...source]; Object.getPrototypeOf(items[0].values()).next = replacement;",
    "candidate",
  ],
  [
    "a Map copied by a fresh spread before a later member store",
    "const source = { value: new Map() }; const items = [0, ...[source.value]]; source.value = []; Object.getPrototypeOf(items[1].values()).next = replacement;",
    "resolved",
  ],
  [
    "native array written to a source slot before the spread",
    "const source = [new Map()]; source[0] = []; const items = [...source]; Object.getPrototypeOf(items[0].values()).next = replacement;",
    "candidate",
  ],
  [
    "source array yielded by its custom iterator",
    "const source = [{ values() { return {}; } }]; source[Symbol.iterator] = function* () { yield source; }; const items = [...source]; Object.getPrototypeOf(items[0].values()).next = replacement;",
    "candidate",
  ],
  [
    "borrowed source whose iterator was installed by a descriptor",
    "const source = [{}]; Object.defineProperty(source, Symbol.iterator, { value: function* () { yield source; } }); const items = [...source]; Object.getPrototypeOf(items[0].values()).next = replacement;",
    "candidate",
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

it.each([
  [
    "inline object",
    'const box=[{mode:"initial"}];const [{mode:selected}]=box;box[0].mode="later";',
    ["0", "mode"],
    "resolved",
  ],
  [
    "assigned object",
    'const box=[{mode:"initial"}];let selected;[{mode:selected}]=box;box[0].mode="later";',
    ["0", "mode"],
    "resolved",
  ],
  [
    "nested object",
    'const box=[{nest:{mode:"initial"}}];const alias=box;const [{nest:{mode:selected}}]=alias;box[0].nest.mode="later";',
    ["0", "nest", "mode"],
    "resolved",
  ],
  [
    "projected object",
    'const box={items:[{mode:"initial"}]};const alias=box;const [{mode:selected}]=alias.items;box.items[0].mode="later";',
    ["items", "0", "mode"],
    "resolved",
  ],
  [
    "an earlier inline object",
    'const box=[{}, "initial"];const [{},selected]=box;box[1]="later";',
    ["1"],
    "resolved",
  ],
  [
    "an earlier null object pattern input",
    'const box=[null, "initial"];const [{},selected]=box;box[1]="later";',
    ["1"],
    "candidate",
  ],
  [
    "referenced object",
    'const item={mode:"initial"};const box=[item];const [{mode:selected}]=box;item.mode="later";',
    ["0", "mode"],
    "candidate",
  ],
  [
    "earlier slot write",
    'const box=[{mode:"initial"}];box[0].mode="other";const [{mode:selected}]=box;',
    ["0", "mode"],
    "candidate",
  ],
  [
    "custom iterator",
    'const box=[{mode:"initial"}];box[Symbol.iterator]=function*(){yield {mode:"other"};};const [{mode:selected}]=box;',
    ["0", "mode"],
    "candidate",
  ],
  [
    "custom next",
    'const box=[{mode:"initial"}];Object.getPrototypeOf([].values()).next=function(){return {value:{mode:"other"},done:false}};const [{mode:selected}]=box;',
    ["0", "mode"],
    "candidate",
  ],
  [
    "earlier object getter",
    'const box=[{mode:"initial",get key(){box[0].mode="other";return 0;}}];const [{key:before,mode:selected}]=box;',
    ["0", "mode"],
    "candidate",
  ],
  [
    "earlier nested default",
    'const box=[{mode:"initial"}];const [{key:before=(box[0].mode="other"),mode:selected}]=box;',
    ["0", "mode"],
    "candidate",
  ],
  [
    "earlier computed key",
    'const box=[{key:0,mode:"initial"}];const [{[void(box[0].mode="other")]:before,mode:selected}]=box;',
    ["0", "mode"],
    "candidate",
  ],
  [
    "earlier member assignment target",
    'const box=[{key:0,mode:"initial"}];const target={set key(_){box[0].mode="other";}};let selected;[{key:target.key,mode:selected}]=box;',
    ["0", "mode"],
    "candidate",
  ],
  [
    "earlier computed assignment target",
    'const box=[{key:0,mode:"initial"}];const target={};let selected;[{key:target[(box[0].mode="other","key")],mode:selected}]=box;',
    ["0", "mode"],
    "candidate",
  ],
  [
    "nested array",
    'const box=[{sub:["initial"]}];const [{sub:[selected]}]=box;box[0].sub[0]="later";',
    ["0", "sub", "0"],
    "candidate",
  ],
  [
    "outer close after the selection",
    'const box=[{mode:"initial"}];Object.getPrototypeOf([].values()).return=function(){box[0].mode="closed";return {};};const [{mode:selected}]=box;',
    ["0", "mode"],
    "candidate",
  ],
] as const)(
  "composes the outer iterator with read-time own-data paths for %s",
  (_name, source, path, resolution) => {
    const graph = graphForJavaScript(source);
    const binding = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "selected",
    );
    const relation = graph.relations.find(
      ({ relation, target_node_id }) =>
        relation === "destructures" && target_node_id === binding?.node_id,
    );
    expect(relation).toMatchObject({ resolution });
    expect(
      graph.nodes.find(({ node_id }) => node_id === relation?.source_node_id)
        ?.properties.property_path,
    ).toEqual(path);
  },
);

const closeHandler =
  "function () { delete this.next().value.mode; return {}; }";
it.each([
  ["native close", "", "resolved"],
  [
    "direct Array Iterator prototype",
    "Object.getPrototypeOf([].values()).return = " + closeHandler + ";",
    "candidate",
  ],
  [
    "captured Array Iterator prototype",
    "const iterator=[].values(); const p=Object.getPrototypeOf(iterator); p.return = " +
      closeHandler +
      ";",
    "candidate",
  ],
  [
    "inherited Iterator prototype",
    "Object.getPrototypeOf(Object.getPrototypeOf([].values())).return = " +
      closeHandler +
      ";",
    "candidate",
  ],
  [
    "global Iterator prototype",
    "Iterator.prototype.return = " + closeHandler + ";",
    "candidate",
  ],
  [
    "global Iterator prototype stored in a spread",
    `const protos=[...[Iterator.prototype]];protos[0].return=${closeHandler};`,
    "candidate",
  ],
  [
    "escaped Iterator prototype stored in a spread",
    "const protos=[...[Iterator.prototype]];configure(protos[0]);",
    "candidate",
  ],
  [
    "reflected Iterator prototype stored in a spread",
    `const protos=[...[Object.getPrototypeOf(Object.getPrototypeOf([].values()))]];Reflect.set(protos[0],"return",${closeHandler});`,
    "candidate",
  ],
  [
    "inherited Object prototype",
    "Object.prototype.return = " + closeHandler + ";",
    "candidate",
  ],
  [
    "unrelated Array prototype",
    `const protos=[...[Array.prototype]];protos[0].return=${closeHandler};`,
    "resolved",
  ],
] as const)(
  "tracks a nested array-pattern close through %s",
  (_name, hook, resolution) => {
    const graph = graphForJavaScript(`
      const box={label:"ready",items:[0,{mode:"before"}]};
      ${hook}
      const {label:before,items:[first],items:{0:primitive,1:{mode:selected}}}=box;
    `);
    const edge = (name: string) => {
      const binding = graph.nodes.find(
        (n) => n.kind === "binding" && n.label === name,
      );
      return graph.relations.find(
        (r) =>
          r.relation === "destructures" &&
          r.target_node_id === binding?.node_id,
      );
    };
    expect(edge("before")).toMatchObject({ resolution: "resolved" });
    expect(edge("primitive")).toMatchObject({ resolution: "resolved" });
    expect(edge("selected")).toMatchObject({ resolution });
  },
);

it.each([
  [
    "hook before read",
    `Object.getPrototypeOf([].values()).return = ${closeHandler};`,
    "",
    "candidate",
  ],
  [
    "hook after read",
    "",
    `const protos=[...[Iterator.prototype]];protos[0].return=${closeHandler};`,
    "resolved",
  ],
] as const)(
  "preserves outer iterator close timing for %s",
  (_name, before, after, resolution) => {
    const graph = graphForJavaScript(`
    const box=[0,{mode:"before"}];
    ${before}
    const [first]=box;
    const {1:{mode:selected}}=box;
    ${after}
  `);
    for (const [name, expected] of [
      ["first", "resolved"],
      ["selected", resolution],
    ]) {
      const binding = graph.nodes.find(
        (n) => n.kind === "binding" && n.label === name,
      );
      expect(
        graph.relations.find(
          (r) =>
            r.relation === "destructures" &&
            r.target_node_id === binding?.node_id,
        ),
      ).toMatchObject({ resolution: expected });
    }
  },
);

it.each([
  ["empty pattern", "", "candidate"],
  ["rest drains iterator", "...rest", "resolved"],
] as const)("preserves close presence for %s", (_name, pattern, resolution) => {
  const graph = graphForJavaScript(`
    const box={items:[{mode:"before"}]};
    Object.getPrototypeOf([].values()).return = ${closeHandler};
    const {items:[${pattern}],items:{0:{mode:selected}}}=box;
  `);
  const selected = graph.nodes.find(
    (n) => n.kind === "binding" && n.label === "selected",
  );
  expect(
    graph.relations.find(
      (r) =>
        r.relation === "destructures" && r.target_node_id === selected?.node_id,
    ),
  ).toMatchObject({ resolution });
});

const closeNextObject =
  "Object.getPrototypeOf([].values()).return=function(){const next=this.next().value;if(next)delete next.mode;return {}};";
it.each([
  [
    "unconsumed suffix",
    'const items=[{mode:"first"},{mode:"second"}];',
    "const [used]=items;",
    "resolved",
    "candidate",
  ],
  [
    "shared element identity",
    'const value={mode:"shared"};const items=[value,value];',
    "const [used]=items;",
    "candidate",
    "candidate",
  ],
  [
    "all slots consumed",
    'const items=[{mode:"first"},{mode:"second"}];',
    "const [used,alsoUsed]=items;",
    "resolved",
    "resolved",
  ],
  [
    "native exhaustion observed",
    'const items=[{mode:"first"},{mode:"second"}];',
    "const [used,alsoUsed,done]=items;",
    "resolved",
    "resolved",
  ],
  [
    "earlier default",
    'const items=[undefined,{mode:"second"}];',
    'const [used=(items.push({mode:"added"}),0)]=items;',
    "candidate",
    "candidate",
  ],
] as const)(
  "bounds native close exposure for %s",
  (_name, setup, pattern, first, second) => {
    const graph = graphForJavaScript(`
    ${setup}
    ${closeNextObject}
    ${pattern}
    const {0:{mode:first},1:{mode:second}}=items;
  `);
    for (const [name, resolution] of [
      ["first", first],
      ["second", second],
    ]) {
      const binding = graph.nodes.find(
        (n) => n.kind === "binding" && n.label === name,
      );
      expect(
        graph.relations.find(
          (r) =>
            r.relation === "destructures" &&
            r.target_node_id === binding?.node_id,
        ),
      ).toMatchObject({ resolution });
    }
  },
);

it.each([
  [
    "earlier declarator",
    "const {1:{mode:selected}}=items,[used]=items;",
    "resolved",
  ],
  [
    "later declarator",
    "const [used]=items,{1:{mode:selected}}=items;",
    "candidate",
  ],
  [
    "earlier assignment",
    "let selected,used; (({1:{mode:selected}}=items),[used]=items);",
    "resolved",
  ],
  [
    "later assignment",
    "let selected,used; ([used]=items,({1:{mode:selected}}=items));",
    "candidate",
  ],
] as const)(
  "orders a native close relative to an %s",
  (_name, pattern, resolution) => {
    const graph = graphForJavaScript(`
    const items=[0,{mode:"inherited"}]; ${closeNextObject}
    ${pattern}
  `);
    const binding = graph.nodes.find(
      (n) => n.kind === "binding" && n.label === "selected",
    );
    expect(
      graph.relations.find(
        (r) =>
          r.relation === "destructures" &&
          r.target_node_id === binding?.node_id,
      ),
    ).toMatchObject({ resolution });
  },
);

it.each([
  [
    "after close",
    "items:[used], missing=(Object.getPrototypeOf([].values()).return=hook)",
    "resolved",
  ],
  [
    "before close",
    "missing=(Object.getPrototypeOf([].values()).return=hook), items:[used]",
    "candidate",
  ],
] as const)(
  "keeps a hook assigned by a default %s in order",
  (_name, prefix, resolution) => {
    const graph = graphForJavaScript(`
    const box={items:[0,{mode:"initial"}]};
    function hook(){const next=this.next().value;if(next)delete next.mode;return {};}
    const {${prefix}, items:{1:{mode:selected}}}=box;
  `);
    const binding = graph.nodes.find(
      (n) => n.kind === "binding" && n.label === "selected",
    );
    expect(
      graph.relations.find(
        (r) =>
          r.relation === "destructures" &&
          r.target_node_id === binding?.node_id,
      ),
    ).toMatchObject({ resolution });
  },
);

it.each([
  ["before close", "none=(box.items[1]=box.next), items:[used]", "candidate"],
  ["after close", "items:[used], none=(box.items[1]=box.next)", "resolved"],
] as const)(
  "follows an array-pattern close through a slot assigned %s",
  (_name, prefix, resolution) => {
    const graph = graphForJavaScript(`
    const box={items:[0],next:{mode:"second"}};
    ${closeNextObject}
    const {${prefix},next:{mode:selected}}=box;
  `);
    const selected = graph.nodes.find(
      (n) => n.kind === "binding" && n.label === "selected",
    );
    expect(
      graph.relations.find(
        (r) =>
          r.relation === "destructures" &&
          r.target_node_id === selected?.node_id,
      ),
    ).toMatchObject({ resolution });
  },
);

it("keeps consumed objects uncertain when an earlier default also stores them in the suffix", () => {
  const graph = graphForJavaScript(`
    const box={items:[{mode:"first"}]};
    ${closeNextObject}
    const {none=(box.items[1]=box.items[0]),items:[used],items:{0:{mode:selected}}}=box;
  `);
  const selected = graph.nodes.find(
    (n) => n.kind === "binding" && n.label === "selected",
  );
  expect(
    graph.relations.find(
      (r) =>
        r.relation === "destructures" && r.target_node_id === selected?.node_id,
    ),
  ).toMatchObject({ resolution: "candidate" });
});

it.each([
  [
    "throwing default",
    "undefined,",
    "const [first = null.value, ...rest] = items;",
    "1",
    "candidate",
  ],
  [
    "plain lexical prefix",
    "undefined,",
    "const [first, ...rest] = items;",
    "1",
    "resolved",
  ],
  [
    "known unused default",
    "0,",
    "const [first = null.value, ...rest] = items;",
    "1",
    "resolved",
  ],
  [
    "nested target that throws",
    "null,",
    "const [{first}, ...rest] = items;",
    "1",
    "candidate",
  ],
  [
    "immutable assignment target",
    "0,",
    "const first = 0; let rest; [first, ...rest] = items;",
    "1",
    "candidate",
  ],
  [
    "computed rest target that throws before draining",
    "",
    "const target = {}; [...target[null.value]] = items;",
    "0",
    "candidate",
  ],
] as const)(
  "models a native close before rest for %s",
  (_name, prefix, pattern, key, resolution) => {
    const graph = graphForJavaScript(`
    const items=[${prefix}{mode:"before"}];
    Object.getPrototypeOf([].values()).return = ${closeHandler};
    try { ${pattern} } catch {}
    const {${key}:{mode:selected}}=items;
  `);
    const selected = graph.nodes.find(
      (n) => n.kind === "binding" && n.label === "selected",
    );
    expect(
      graph.relations.find(
        (r) =>
          r.relation === "destructures" &&
          r.target_node_id === selected?.node_id,
      ),
    ).toMatchObject({ resolution });
  },
);

it.each([
  [
    "native replacement before acquisition",
    closeNextObject,
    "none=(box.items=[0,box.next]),items:[used]",
    "candidate",
  ],
  [
    "native replacement after acquisition",
    closeNextObject,
    "items:[used],none=(box.items=[0,box.next])",
    "resolved",
  ],
  [
    "native replacement with no close hook",
    "",
    "none=(box.items=[0,box.next]),items:[used]",
    "resolved",
  ],
  [
    "custom replacement before acquisition",
    "",
    "none=(box.items={child:box.next,[Symbol.iterator](){delete this.child.mode;return [0].values();}}),items:[used]",
    "candidate",
  ],
  [
    "custom replacement after acquisition",
    "",
    "items:[used],none=(box.items={child:box.next,[Symbol.iterator](){delete this.child.mode;return [0].values();}})",
    "resolved",
  ],
  [
    "replacement's iterator updated before acquisition",
    "",
    "none=(box.items=[0,box.next]), second=(box.items[Symbol.iterator]=function(){delete this[1].mode;return [0].values();}),items:[used]",
    "candidate",
  ],
] as const)(
  "captures the nested iterator receiver for %s",
  (_name, hook, pattern, resolution) => {
    const graph = graphForJavaScript(`
    const box={items:[0],next:{mode:"before"}};
    ${hook}
    const {${pattern},next:{mode:selected}}=box;
  `);
    const selected = graph.nodes.find(
      (n) => n.kind === "binding" && n.label === "selected",
    );
    expect(
      graph.relations.find(
        (r) =>
          r.relation === "destructures" &&
          r.target_node_id === selected?.node_id,
      ),
    ).toMatchObject({ resolution });
  },
);

it.each([
  ["two native arms", "flag ? [0,box.next] : [0]", "resolved"],
  [
    "a possible custom arm",
    "flag ? [0,box.next] : {child:box.next,[Symbol.iterator](){delete this.child.mode;return [0].values();}}",
    "candidate",
  ],
  [
    "an inactive custom arm",
    "false ? {child:box.next,[Symbol.iterator](){delete this.child.mode;return [0].values();}} : [0,box.next]",
    "resolved",
  ],
] as const)(
  "retains conditional stored acquisition for %s",
  (_name, store, resolution) => {
    const graph = graphForJavaScript(`
    const box={items:[0],next:{mode:"before"}};
    const {none=(box.items=${store}),items:[used],next:{mode:selected}}=box;
  `);
    const binding = graph.nodes.find(
      (n) => n.kind === "binding" && n.label === "selected",
    );
    expect(
      graph.relations.find(
        (r) =>
          r.target_node_id === binding?.node_id &&
          r.relation === "destructures",
      ),
    ).toMatchObject({ resolution });
  },
);

it.each([
  ["native close", closeNextObject, "[0,box.next]", "", "resolved"],
  [
    "custom acquisition",
    "",
    "{child:box.next,[Symbol.iterator](){delete this.child.mode;return [0].values();}}",
    "",
    "resolved",
  ],
  [
    "an ordinary prior write",
    closeNextObject,
    "[0,box.next]",
    'write=(box.next.mode="alternate"),',
    "candidate",
  ],
] as const)(
  "orders sibling reads around stored %s",
  (_name, hook, store, earlier, before) => {
    const graph = graphForJavaScript(`
    const box={items:[0],next:{mode:"initial"}};
    ${hook}
    const {none=(box.items=${store}),${earlier}next:{mode:before},items:[used],next:{mode:after}}=box;
  `);
    for (const [name, resolution] of [
      ["before", before],
      ["after", "candidate"],
    ]) {
      const binding = graph.nodes.find(
        (n) => n.kind === "binding" && n.label === name,
      );
      expect(
        graph.relations.find(
          (r) =>
            r.target_node_id === binding?.node_id &&
            r.relation === "destructures",
        ),
      ).toMatchObject({ resolution });
    }
  },
);

it.each([
  ["ordinary property receiver", "box.parent", "candidate"],
  ["parenthesized property receiver", '((box)["parent"])', "candidate"],
  ["unknown receiver key", "box[key]", undefined],
] as const)(
  "recovers a stored nested iterator for %s",
  (_name, source, resolution) => {
    const graph = graphForJavaScript(`
    const box={parent:{items:[0],next:{mode:"before"}}};
    const replacement={child:box.parent.next,[Symbol.iterator](){delete this.child.mode;return [0].values();}};
    const {none=(box.parent.items=replacement),items:[used],next:{mode:selected}}=${source};
  `);
    const binding = graph.nodes.find(
      (n) => n.kind === "binding" && n.label === "selected",
    );
    const relation = graph.relations.find(
      (r) =>
        r.target_node_id === binding?.node_id && r.relation === "destructures",
    );
    expect(relation?.resolution).toBe(resolution);
    if (relation === undefined)
      expect(
        graph.unknowns.some(({ relation_kinds }) =>
          relation_kinds.includes("destructures"),
        ),
      ).toBe(true);
    else
      expect(
        graph.nodes.find(({ node_id }) => node_id === relation.source_node_id)
          ?.properties.property_path,
      ).toEqual(["parent", "next", "mode"]);
  },
);

it.each([
  [
    "direct nested array",
    'const box={items:["one"]};const {items:[selected]}=box;box.items[0]="later";',
    ["items", "0"],
    "resolved",
  ],
  [
    "nested array through a const alias",
    'const box={items:["one"]};const alias=box;const {items:[selected]}=alias;box.items[0]="later";',
    ["items", "0"],
    "resolved",
  ],
  [
    "nested array assignment",
    'const box={items:["one"]};let selected;({items:[selected]}=box);box.items[0]="later";',
    ["items", "0"],
    "resolved",
  ],
  [
    "nested object prefix",
    'const box={prefix:{items:["one"]}};const {prefix:{items:[selected]}}=box;box.prefix.items[0]="later";',
    ["prefix", "items", "0"],
    "resolved",
  ],
  [
    "projected object RHS",
    'const box={prefix:{items:["one"]}};const {items:[selected]}=box.prefix;box.prefix.items[0]="later";',
    ["prefix", "items", "0"],
    "resolved",
  ],
  [
    "earlier own read",
    'const box={label:0,items:["one"]};const {label,items:[selected]}=box;box.items[0]="later";',
    ["items", "0"],
    "resolved",
  ],
  [
    "native nested elision",
    'const box={items:[0,"one"]};const {items:[,selected]}=box;box.items[1]="later";',
    ["items", "1"],
    "resolved",
  ],
  [
    "earlier write through alias",
    'const box={items:["one"]};const alias=box;alias.items[0]="earlier";const {items:[selected]}=box;',
    ["items", "0"],
    "candidate",
  ],
  [
    "earlier default",
    'const box={items:["one"]};const {missing=(box.items[0]="earlier"),items:[selected]}=box;',
    ["items", "0"],
    "candidate",
  ],
  [
    "earlier getter",
    'const box={items:["one"],get label(){box.items[0]="earlier";return 0;}};const {label,items:[selected]}=box;',
    ["items", "0"],
    "candidate",
  ],
  [
    "inherited array receiver",
    'const box={__proto__:{items:["one"]}};const {items:[selected]}=box;',
    ["items", "0"],
    "candidate",
  ],
  [
    "aliased array receiver",
    'const items=["one"];const box={items};const {items:[selected]}=box;items[0]="later";',
    ["items", "0"],
    "candidate",
  ],
  [
    "custom own iterator",
    'const box={items:["one"]};box.items[Symbol.iterator]=function*(){yield "other";};const {items:[selected]}=box;',
    ["items", "0"],
    "candidate",
  ],
  [
    "shared next changed before capture",
    'const box={items:["one"]};Object.getPrototypeOf([].values()).next=()=>({value:"other",done:false});const {items:[selected]}=box;box.items[0]="later";',
    ["items", "0"],
    "candidate",
  ],
  [
    "shared next changed after capture",
    'const box={items:["one"]};const {items:[selected]}=box;Object.getPrototypeOf([].values()).next=()=>({value:"other",done:false});box.items[0]="later";',
    ["items", "0"],
    "resolved",
  ],
  [
    "earlier iterator close reaching this array",
    'const box={first:[0],items:["one"]};box.first[1]=box.items;Object.getPrototypeOf([].values()).return=function(){const value=this.next().value;if(value)delete value[0];return {};};const {first:[used],items:[selected]}=box;',
    ["items", "0"],
    "candidate",
  ],
  [
    "earlier member target in the iterator",
    'const box={items:["one","two"]};const target={set value(_){box.items[1]="earlier";}};let selected;({items:[target.value,selected]}=box);',
    ["items", "1"],
    "candidate",
  ],
  [
    "second nested iterator after a harmless close",
    'const box={first:[0],items:["one"]};const {first:[used],items:[selected]}=box;box.items[0]="later";',
    ["items", "0"],
    "resolved",
  ],
  [
    "second nested iterator below a different own-data object path",
    'const box={left:{first:[0]},right:{items:["one"]}};const {left:{first:[used]},right:{items:[selected]}}=box;box.right.items[0]="later";',
    ["right", "items", "0"],
    "resolved",
  ],
  [
    "second nested iterator before a later return hook",
    'const box={first:[0],items:["one"]};const {first:[used],items:[selected]}=box;Object.getPrototypeOf([].values()).return=()=>({});box.items[0]="later";',
    ["items", "0"],
    "resolved",
  ],
  [
    "second nested iterator after an inherited return hook",
    'const box={first:[0],items:["one"]};Object.prototype.return=()=>({});const {first:[used],items:[selected]}=box;box.items[0]="later";',
    ["items", "0"],
    "candidate",
  ],
  [
    "second nested iterator after an effectful first default",
    'const box={first:[undefined],items:["one"]};const {first:[used=(box.items[0]="default")],items:[selected]}=box;box.items[0]="later";',
    ["items", "0"],
    "candidate",
  ],
  [
    "second nested iterator after an intervening getter",
    'const box={first:[0],get between(){this.items[0]="getter";},items:["one"]};const {first:[used],between,items:[selected]}=box;box.items[0]="later";',
    ["items", "0"],
    "candidate",
  ],
  ...[
    ["null", "null", "candidate"],
    ["void", "void 0", "candidate"],
    ["unproved", "unknown()", "candidate"],
    ["object", "{}", "resolved"],
    ["array", "[]", "resolved"],
    ["zero", "0", "resolved"],
    ["false", "false", "resolved"],
    ["empty string", '""', "resolved"],
  ].map(
    ([label, receiver, resolution]) =>
      [
        `second nested iterator after an empty pattern with receiver ${label}`,
        `const box={first:[0],middle:${receiver},items:["one"]};const {first:[used],middle:{},items:[selected]}=box;box.items[0]="later";`,
        ["items", "0"],
        resolution,
      ] as const,
  ),
  [
    "a numeric own slot on an array RHS",
    'const pairs=[["one"]];const {0:[selected]}=pairs;pairs[0][0]="later";',
    ["0", "0"],
    "resolved",
  ],
  [
    "a numeric own slot on a projected array RHS",
    'const box={pairs:[["one"]]};const {0:[selected]}=box.pairs;box.pairs[0][0]="later";',
    ["pairs", "0", "0"],
    "resolved",
  ],
  [
    "a quoted own slot on a projected const alias",
    'const box={pairs:[["one"]]};const alias=box;let selected;({"0":[selected]}=alias.pairs);box.pairs[0][0]="later";',
    ["pairs", "0", "0"],
    "resolved",
  ],
  [
    "a numeric own slot under an own object path",
    'const box={nested:{pairs:[["one"]]}};const {0:[selected]}=box.nested.pairs;box.nested.pairs[0][0]="later";',
    ["nested", "pairs", "0", "0"],
    "resolved",
  ],
  [
    "a numeric slot selected through an accessor",
    'const box={get pairs(){return [["one"]];}};const {0:[selected]}=box.pairs;box.pairs[0][0]="later";',
    ["pairs", "0", "0"],
    "candidate",
  ],
  [
    "an earlier replacement of the projected array receiver",
    'const box={pairs:[["one"]]};box.pairs=[["earlier"]];const {0:[selected]}=box.pairs;box.pairs[0][0]="later";',
    ["pairs", "0", "0"],
    "candidate",
  ],
  [
    "a hole in a projected array",
    'const box={pairs:[,["one"]]};const {0:[selected]}=box.pairs;box.pairs[0]=["later"];',
    ["pairs", "0", "0"],
    "candidate",
  ],
  [
    "an early inner iterator overwrite at a projected array slot",
    'const box={pairs:[["one"]]};Object.getPrototypeOf([].values()).next=()=>({done:true});const {0:[selected]}=box.pairs;box.pairs[0][0]="later";',
    ["pairs", "0", "0"],
    "candidate",
  ],
  [
    "a quoted own array slot captured through a const alias",
    'const pairs=[["one"]];const alias=pairs;let selected;({"0":[selected]}=alias);pairs[0][0]="later";',
    ["0", "0"],
    "resolved",
  ],
  [
    "the second numeric own slot without acquiring the outer iterator",
    'const pairs=[[0],["one"]];const {0:[used],1:[selected]}=pairs;pairs[1][0]="later";',
    ["1", "0"],
    "resolved",
  ],
  [
    "an unresolved computed write on the outer array",
    'const pairs=[["one"]];pairs[Symbol.iterator]=function*(){};const {0:[selected]}=pairs;pairs[0][0]="later";',
    ["0", "0"],
    "candidate",
  ],
  [
    "an absent numeric own array slot",
    'const pairs=[,["one"]];const {0:[selected]}=pairs;pairs[0]=["later"];',
    ["0", "0"],
    "candidate",
  ],
  [
    "an earlier replacement of the numeric array slot",
    'const pairs=[["one"]];pairs[0]=["earlier"];const {0:[selected]}=pairs;pairs[0][0]="later";',
    ["0", "0"],
    "candidate",
  ],
  [
    "an overridden inner iterator selected from a numeric property",
    'const pairs=[["one"]];pairs[0][Symbol.iterator]=function*(){};const {0:[selected]}=pairs;pairs[0][0]="later";',
    ["0", "0"],
    "candidate",
  ],
  [
    "an earlier return hook before selecting the second numeric property",
    'const pairs=[[0],["one"]];Object.prototype.return=()=>({});const {0:[used],1:[selected]}=pairs;pairs[1][0]="later";',
    ["1", "0"],
    "candidate",
  ],
  [
    "second nested iterator after a prior assignment target",
    'const box={first:[0],items:["one"]};let used,selected;({first:[used],items:[selected]}=box);box.items[0]="later";',
    ["items", "0"],
    "candidate",
  ],
] as const)(
  "owns nested native arrays through an object pattern for %s",
  (_name, code, path, resolution) => {
    const graph = graphForJavaScript(code);
    const selected = graph.nodes.find(
      (n) => n.kind === "binding" && n.label === "selected",
    );
    const relation = graph.relations.find(
      (r) =>
        r.relation === "destructures" && r.target_node_id === selected?.node_id,
    );
    expect(relation).toMatchObject({ resolution });
    expect(
      graph.nodes.find((n) => n.node_id === relation?.source_node_id)
        ?.properties.property_path,
    ).toEqual(path);
  },
);

it.each([
  [
    "inline array",
    'const pairs=[["first"]];const [[selected]]=pairs;pairs[0][0]="later";',
    ["0", "0"],
    "resolved",
  ],
  [
    "const alias",
    'const pairs=[["first"]];const alias=pairs;const [[selected]]=alias;pairs[0][0]="later";',
    ["0", "0"],
    "resolved",
  ],
  [
    "assignment",
    'const pairs=[["first"]];let selected;[[selected]]=pairs;pairs[0][0]="later";',
    ["0", "0"],
    "resolved",
  ],
  [
    "projected array RHS",
    'const values={pairs:[["first"]]};const [[selected]]=values.pairs;values.pairs[0][0]="later";',
    ["pairs", "0", "0"],
    "resolved",
  ],
  [
    "outer elision",
    'const pairs=[0,["first"]];const [,[selected]]=pairs;pairs[1][0]="later";',
    ["1", "0"],
    "resolved",
  ],
  [
    "outer hole before the selected inner array",
    'const pairs=[,["first"]];const [,[selected]]=pairs;pairs[1][0]="later";',
    ["1", "0"],
    "candidate",
  ],
  [
    "prior write through alias",
    'const pairs=[["first"]];const alias=pairs;alias[0][0]="earlier";const [[selected]]=pairs;',
    ["0", "0"],
    "candidate",
  ],
  [
    "prior ordinary default",
    'const pairs=[undefined,["first"]];const [unused=(pairs[1][0]="earlier"),[selected]]=pairs;',
    ["1", "0"],
    "candidate",
  ],
  [
    "inner custom iterator",
    'const pairs=[["first"]];pairs[0][Symbol.iterator]=function*(){yield "other";};const [[selected]]=pairs;',
    ["0", "0"],
    "candidate",
  ],
  [
    "Object.getPrototypeOf aliases the shared array prototype",
    'const proto=Object.getPrototypeOf([]);proto[Symbol.iterator]=function*(){};const pairs=[["first"]];const [[selected]]=pairs;pairs[0][0]="later";',
    ["0", "0"],
    "candidate",
  ],
  [
    "an earlier call writes through Reflect.getPrototypeOf",
    'change();function change(){const proto=Reflect.getPrototypeOf([]);proto[Symbol.iterator]=function*(){};}const pairs=[["first"]];const [[selected]]=pairs;pairs[0][0]="later";',
    ["0", "0"],
    "candidate",
  ],
  [
    "an unrelated property on the shared array prototype",
    'const proto=Reflect.getPrototypeOf([]);proto.note=1;const pairs=[["first"]];const [[selected]]=pairs;pairs[0][0]="later";',
    ["0", "0"],
    "resolved",
  ],
  [
    "a lexical Object replacement returns a fresh receiver",
    'const Object={getPrototypeOf:()=>({})};const proto=Object.getPrototypeOf([]);proto[Symbol.iterator]=function*(){};const pairs=[["first"]];const [[selected]]=pairs;pairs[0][0]="later";',
    ["0", "0"],
    "resolved",
  ],
  [
    "shared next changed before acquisition",
    'const pairs=[["first"]];Object.getPrototypeOf([].values()).next=()=>({value:"other",done:false});const [[selected]]=pairs;pairs[0][0]="later";',
    ["0", "0"],
    "candidate",
  ],
  [
    "shared next changed after acquisition",
    'const pairs=[["first"]];const [[selected]]=pairs;Object.getPrototypeOf([].values()).next=()=>({value:"other",done:false});pairs[0][0]="later";',
    ["0", "0"],
    "resolved",
  ],
  [
    "prior inner close can change this array",
    'const pairs=[[0],["second"]];pairs[0][1]=pairs[1];Object.getPrototypeOf([].values()).return=function(){const value=this.next().value;if(value)delete value[0];return {};};const [[used],[selected]]=pairs;',
    ["1", "0"],
    "candidate",
  ],
  [
    "next outer slot after a native inner close",
    'const pairs=[[0],"next"];const [[used],selected]=pairs;pairs[1]="later";',
    ["1"],
    "resolved",
  ],
  [
    "second nested array after a native inner close",
    'const pairs=[[0],["next"]];const [[used],[selected]]=pairs;pairs[1][0]="later";',
    ["1", "0"],
    "resolved",
  ],
  [
    "second nested array after an empty inner pattern",
    'const pairs=[[0],["next"]];const [[],[selected]]=pairs;pairs[1][0]="later";',
    ["1", "0"],
    "resolved",
  ],
  [
    "second nested array after a later-installed close hook",
    'const pairs=[[0],["next"]];const [[used],[selected]]=pairs;Object.getPrototypeOf([].values()).return=()=>({});pairs[1][0]="later";',
    ["1", "0"],
    "resolved",
  ],
  [
    "second nested array after a possible inherited close hook",
    'const pairs=[[0],["next"]];Object.prototype.return=()=>({});const [[used],[selected]]=pairs;pairs[1][0]="later";',
    ["1", "0"],
    "candidate",
  ],
  [
    "second nested array after an effectful default",
    'const pairs=[[undefined],["next"]];const [[used=(pairs[1][0]="default")],[selected]]=pairs;pairs[1][0]="later";',
    ["1", "0"],
    "candidate",
  ],
  [
    "second nested array after an unproved hole",
    'const pairs=[[,0],["next"]];const [[,used],[selected]]=pairs;pairs[1][0]="later";',
    ["1", "0"],
    "candidate",
  ],
  [
    "second nested array after an assignment target",
    'const pairs=[[0],["next"]];let used,selected;[[used],[selected]]=pairs;pairs[1][0]="later";',
    ["1", "0"],
    "candidate",
  ],
  [
    "third iterator",
    'const pairs=[[["first"]]];const [[[selected]]]=pairs;pairs[0][0][0]="later";',
    ["0", "0", "0"],
    "candidate",
  ],
] as const)(
  "composes one native array inside another for %s",
  (_name, code, path, resolution) => {
    const graph = graphForJavaScript(code);
    const selected = graph.nodes.find(
      (n) => n.kind === "binding" && n.label === "selected",
    );
    const relation = graph.relations.find(
      (r) =>
        r.relation === "destructures" && r.target_node_id === selected?.node_id,
    );
    expect(relation).toMatchObject({ resolution });
    expect(
      graph.nodes.find((n) => n.node_id === relation?.source_node_id)
        ?.properties.property_path,
    ).toEqual(path);
  },
);
