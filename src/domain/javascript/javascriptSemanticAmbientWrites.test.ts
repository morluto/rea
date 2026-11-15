import * as t from "@babel/types";
import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { indexJavaScriptBindingsSteps } from "../../../tests/fixtures/javascriptSemanticIndex.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";
import {
  createGlobalPathReader,
  createGlobalReferenceReader,
} from "./javascriptSemanticAmbientWrites.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

it.each([
  [
    "await value; Object.prototype.then=null; await value;",
    ["unmodified", "null"],
  ],
  [
    "Object.prototype.then=function(resolve){resolve()}; await value;",
    ["function"],
  ],
  ["if(flag) Object.prototype.then=null; await value;", ["unknown"]],
  ["mutate(Object.prototype); await value;", ["unknown"]],
  ["await value; mutate(Object.prototype);", ["unmodified"]],
  ["Array.prototype.then=null; await value;", ["unmodified"]],
] as const)(
  "reads intrinsic property facts at implicit await sites: %s",
  (source, expected) => {
    const parsed = parseJavaScriptSource(source, "app.mjs");
    if (parsed === null) throw new Error("Expected implicit read fixture");
    const state = completeSemanticSteps(
      indexJavaScriptBindingsSteps(parsed.program),
    );
    const read = createGlobalPathReader(state, ["Object", "prototype", "then"]);
    const statuses: string[] = [];
    traverseJavaScriptAst(parsed.program, {
      enter(node) {
        if (!t.isAwaitExpression(node)) return;
        const fact = read(node);
        statuses.push(
          fact.status === "replacement"
            ? t.isNullLiteral(fact.value)
              ? "null"
              : t.isFunction(fact.value)
                ? "function"
                : "other"
            : fact.status,
        );
      },
    });
    expect(statuses).toEqual(expected);
  },
);

it("keeps wrapper module aliases distinct from global-object module properties", () => {
  const parsed = parseJavaScriptSource(
    `
    const wrapper = module;
    Object.defineProperty(wrapper, "exports", { value: exports });
    Object.defineProperty(globalThis.module, "exports", { value: exports });
  `,
    "app.cjs",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  expect(state.ambientWriteEffects.map(({ path }) => path)).toEqual([
    ["commonjs-module", "exports"],
    ["global", "module", "exports"],
  ]);
});

it.each([
  ["const copy={...module};consume(copy);", false],
  ["const copy={...{child:module}};consume(copy);", true],
  [
    "const original={child:module};const copy={...original};consume(copy);",
    true,
  ],
])(
  "exposes copied children without escaping the source container: %s",
  (body, moduleEscaped) => {
    const parsed = parseJavaScriptSource(`function copy(){${body}}`);
    if (parsed === null) throw new Error("Expected copied escape fixture");
    const state = completeSemanticSteps(
      indexJavaScriptBindingsSteps(parsed.program),
    );
    expect(
      state.ambientEscapeEffects.some(
        ({ path }) =>
          path.length === 2 &&
          path[0] === "commonjs-module" &&
          path[1] === null,
      ),
    ).toBe(moduleEscaped);
  },
);

it.each([
  {
    name: "reconverging projections with different alias-cycle histories",
    setup: `var x; const a = { foo: x, bar: globalThis }; x = a.bar;
const y = flag ? x : a.foo; y.URL = replacement;`,
    specifier: null,
  },
  {
    name: "growing self-reference projections with an ambient initializer",
    setup: `let alias = globalThis; alias = alias.globalThis;
alias.URL = replacement;`,
    specifier: null,
  },
  {
    name: "distinct properties selecting both ambient identities",
    setup: `const box = { left: globalThis, right: import.meta };
const selected = flag ? box.left : box.right; selected.URL = replacement;`,
    specifier: null,
  },
  {
    name: "cyclic containers with a reachable ambient property",
    setup: `var alias; const box = { next: alias, target: import.meta };
alias = box; const selected = flag ? alias.target : alias.next.target;
selected.url = "file:///other/entry.mjs";`,
    specifier: null,
  },
  {
    name: "cycles containing no ambient identity",
    setup: `var box; box = { next: box };
const selected = flag ? box : box.next; selected.URL = replacement;`,
    specifier: "./worker.js",
  },
  {
    name: "unrelated writes through widened self-reference projections",
    setup: `let alias = globalThis; alias = alias.globalThis;
alias.unrelated = replacement;`,
    specifier: "./worker.js",
  },
  {
    name: "an exact empty projection into a shallow copy",
    setup: `const copy = { ...globalThis };
const selected = flag ? copy : copy; selected.URL = replacement;`,
    specifier: "./worker.js",
  },
])("preserves $name", ({ setup, specifier }) => {
  const source = `import { Worker } from "node:worker_threads";
${setup}
new Worker(new URL("./worker.js", import.meta.url));`;
  const worker = analyzeJavaScriptStaticSource(source).references.find(
    (reference) => reference.kind === "worker",
  );
  expect(worker?.specifier).toBe(specifier);
});

it("retains getter-derived ambient escapes once per invoked read site", () => {
  const source = `const box={loader:require,get trigger(){this.loader.resolve=this.loader;return 0}};
box.trigger;
box.trigger;`;
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("Expected getter fixture");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const effects = index.bindings.ambientEscapeEffects.filter(
    ({ path }) =>
      JSON.stringify(path) === JSON.stringify(["global", "require", null]),
  );
  expect(
    effects.map(({ node }) =>
      node === undefined ? null : source.slice(node.start ?? 0, node.end ?? 0),
    ),
  ).toEqual(["box.trigger", "box.trigger"]);
  expect(effects[0]?.node).not.toBe(effects[1]?.node);
});

const globalFetchWriteSites = (body: string): string[] => {
  const source = `var t={},k=[];${body}`;
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("Expected stored-slot fixture");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  return state.ambientWriteEffects
    .filter(
      ({ path }) =>
        JSON.stringify(path) === JSON.stringify(["global", "fetch"]),
    )
    .map(({ node }) =>
      node === undefined ? "" : source.slice(node.start ?? 0, node.end ?? 0),
    );
};

it.each([
  {
    name: "an object read from a replaced slot",
    body: "var g={};t[k[0]]=g;t[k[1]]=window;g.fetch=replacement;",
    sites: [],
  },
  {
    name: "a literal property value whose slot is replaced",
    body: "var o={};var h={p:o};h.p=window;o.fetch=replacement;h.p.fetch=other;",
    sites: ["h.p.fetch=other"],
  },
  {
    name: "a global read back through an unknown slot",
    body: "t[k[0]]=window;t[k[1]].fetch=replacement;",
    sites: ["t[k[1]].fetch=replacement"],
  },
  {
    name: "a global read into an alias of an unknown slot",
    body: "t[k[0]]=window;var r=t[k[1]];r.fetch=replacement;",
    sites: ["r.fetch=replacement"],
  },
  {
    name: "a nested store through an unknown slot",
    body: "t[k[0]]={};t[k[1]].x=window;t[k[2]].x.fetch=replacement;",
    sites: ["t[k[2]].x.fetch=replacement"],
  },
  {
    name: "a store through an instance prototype",
    body: "function F(){}var x=new F();x.__proto__.slot=window;F.prototype.slot.fetch=replacement;",
    sites: ["F.prototype.slot.fetch=replacement"],
  },
  {
    name: "a store through an instance constructor",
    body: "function F(){}var x=new F();x.constructor.slot=window;F.slot.fetch=replacement;",
    sites: ["F.slot.fetch=replacement"],
  },
  {
    name: "a store into a rest copy",
    body: "var src={};var {...copy}=src;copy.slot=window;copy.slot.fetch=replacement;",
    sites: ["copy.slot.fetch=replacement"],
  },
])("resolves stored references for $name", ({ body, sites }) => {
  expect(globalFetchWriteSites(body)).toEqual(sites);
});

it("keeps an object read from a replaced slot as a URL base proof", () => {
  const worker =
    analyzeJavaScriptStaticSource(`import { Worker } from "node:worker_threads";
const t={},k=[];const g={};t[k[0]]=g;t[k[1]]=globalThis;g.URL=replacement;
new Worker(new URL("./worker.js", import.meta.url));`).references.find(
      (reference) => reference.kind === "worker",
    );
  expect(worker?.specifier).toBe("./worker.js");
});

it("indexes unknown-key stores of fresh objects in linear stored-value work", () => {
  // Count reads of the stored values' own syntax during ambient indexing only.
  const work = (count: number): number => {
    const source = `var t={},k=[];${Array.from({ length: count }, (_, i) => `t[k[${String(i)}]]={v:${String(i)}};`).join("")}`;
    const parsed = parseJavaScriptSource(source);
    if (parsed === null) throw new Error("Expected stored-object fixture");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    let counting = false;
    let reads = 0;
    for (const statement of parsed.program.body) {
      if (
        !t.isExpressionStatement(statement) ||
        !t.isAssignmentExpression(statement.expression)
      )
        continue;
      const value = statement.expression.right;
      const type = value.type;
      Object.defineProperty(value, "type", {
        enumerable: true,
        configurable: true,
        get: () => {
          if (counting) reads += 1;
          return type;
        },
      });
    }
    counting = true;
    completeSemanticSteps(index.indexAmbientWritesSteps());
    counting = false;
    expect(index.bindings.ambientWriteEffects).toEqual([]);
    return reads;
  };
  // Each stored value is examined a bounded number of times. Re-reading every
  // earlier value from every later store grows at least quadratically.
  expect(work(64)).toBeLessThan(3 * work(32));
});

it.each([
  [
    "before and after a direct replacement",
    "inspect(Object.defineProperty);Object.defineProperty=()=>{};inspect(Object.defineProperty);",
    ["unmodified", "replacement"],
  ],
  [
    "an unrelated property",
    "Object.assign=()=>{};inspect(Object.defineProperty);",
    ["unmodified"],
  ],
  [
    "a conditional replacement",
    "if(flag)Object.defineProperty=()=>{};inspect(Object.defineProperty);",
    ["unknown"],
  ],
  [
    "a replaced parent",
    "Object=input;inspect(Object.defineProperty);",
    ["unknown"],
  ],
  [
    "a lexical shadow",
    "const Object={defineProperty(){}};inspect(Object.defineProperty);",
    ["unrelated"],
  ],
  [
    "an unproven alias write",
    "const copy=Object;copy.defineProperty=()=>{};inspect(Object.defineProperty);",
    ["unknown"],
  ],
  [
    "a later write in a possibly repeated activation",
    "function run(){inspect(Object.defineProperty);Object.defineProperty=()=>{};}",
    ["unknown"],
  ],
  [
    "competing unconditional replacements before a read",
    "function run(){Object.defineProperty=()=>{};Object.defineProperty=()=>{};inspect(Object.defineProperty);}",
    ["replacement"],
  ],
  [
    "a repeated activation with a later write",
    "function run(){inspect(Object.defineProperty);Object.defineProperty=()=>{};}run();run();",
    ["unknown"],
  ],
  [
    "a replaced global namespace",
    "globalThis={Object:{}};globalThis.Object.defineProperty=()=>{};inspect(Object.defineProperty);",
    ["unknown"],
  ],
  [
    "a namespaced replacement read directly",
    "globalThis.Object.defineProperty=()=>{};inspect(Object.defineProperty);",
    ["replacement"],
  ],
  [
    "a direct replacement read through the namespace",
    "Object.defineProperty=()=>{};inspect(globalThis.Object.defineProperty);",
    ["replacement"],
  ],
  [
    "an escaped global owner",
    "mutate(Object);inspect(Object.defineProperty);",
    ["unknown"],
  ],
  [
    "a namespaced global",
    "inspect(globalThis.Object.defineProperty);globalThis.Object.defineProperty=()=>{};inspect(globalThis.Object.defineProperty);",
    ["unmodified", "replacement"],
  ],
])(
  "retains ordered global-reference facts for %s",
  (_label, source, expected) => {
    const parsed = parseJavaScriptSource(source, "app.cjs");
    if (parsed === null) throw new Error("Expected global-reference fixture");
    const state = completeSemanticSteps(
      indexJavaScriptBindingsSteps(parsed.program),
    );
    const read = createGlobalReferenceReader(state, [
      "Object",
      "defineProperty",
    ]);
    const statuses: string[] = [];
    traverseJavaScriptAst(parsed.program, {
      enter(node) {
        if (
          t.isCallExpression(node) &&
          t.isIdentifier(node.callee, { name: "inspect" }) &&
          t.isNode(node.arguments[0])
        )
          statuses.push(read(node.arguments[0]).status);
      },
    });
    expect(statuses).toEqual(expected);
  },
);

// An argument of a directly invoked source function expression reaches only
// that function's parameter, whose effects are indexed like any other source
// effect. Only arguments the body may reach another way escape.
function expectAmbientEffectPaths({
  source,
  writes,
  escapes,
}: {
  readonly source: string;
  readonly writes: readonly (readonly unknown[])[];
  readonly escapes: readonly (readonly unknown[])[];
}): void {
  const parsed = parseJavaScriptSource(source, "app.js");
  if (parsed === null) throw new Error("Expected ambient effect fixture");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const paths = (effects: readonly { readonly path: unknown }[]) => [
    ...new Set(effects.map(({ path }) => JSON.stringify(path))),
  ];
  expect({
    writes: paths(index.bindings.ambientWriteEffects),
    escapes: paths(index.bindings.ambientEscapeEffects),
  }).toEqual({
    writes: writes.map((path) => JSON.stringify(path)),
    escapes: escapes.map((path) => JSON.stringify(path)),
  });
}

it.each([
  { source: "(function(g){})(this);", writes: [], escapes: [] },
  { source: "(function(){})(this);", writes: [], escapes: [] },
  {
    source: "(function(g){g.x=1})(this);",
    writes: [["global", "x"]],
    escapes: [],
  },
  {
    source: "(function(g){var h=g;h.y=2})(this);",
    writes: [["global", "y"]],
    escapes: [],
  },
  {
    source: "(function(g){later(function(){g.w=1})})(this);",
    writes: [["global", "w"]],
    escapes: [],
  },
  {
    source: "(function(g){return g})(this).z=1;",
    writes: [["global", "z"]],
    escapes: [],
  },
  {
    source: "(function(g,y){y(1)})(this,function(g){});",
    writes: [],
    escapes: [],
  },
  {
    source: "(function(g){patch(g)})(this);",
    writes: [],
    escapes: [["global", null]],
  },
  {
    source: "(function(g){arguments[0].x=1})(this);",
    writes: [],
    escapes: [["global", null]],
  },
  {
    source: "(function(g){})(...[this]);",
    writes: [],
    escapes: [["global", null]],
  },
  {
    source: "(function({x}){})(this);",
    writes: [],
    escapes: [["global", null]],
  },
  {
    source: "(function(g=d){})(this);",
    writes: [],
    escapes: [["global", null]],
  },
  {
    source: "(function(...r){})(this);",
    writes: [],
    escapes: [["global", null]],
  },
  { source: "unknown(this);", writes: [], escapes: [["global", null]] },
  {
    source: "(function(g){g.x=1})(globalThis);",
    writes: [["global", "x"]],
    escapes: [],
  },
  {
    source: "(function(m){m.exports=1})(module);",
    writes: [["commonjs-module", "exports"]],
    escapes: [],
  },
  {
    source: "(function(g){patch(g)})(window);",
    writes: [],
    escapes: [["global", null]],
  },
  {
    source: "(function(g){throw g})(this);",
    writes: [],
    escapes: [["global", null]],
  },
])(
  "tracks arguments of directly invoked functions through parameters: $source",
  expectAmbientEffectPaths,
);

// A value thrown uncaught at the top level reaches the host's
// uncaught-exception handlers, which may change it.
it.each([
  ...[
    "throw this;",
    "{ throw this; }",
    "try { throw this; } finally {}",
    "try {} catch { throw this; }",
  ].map((source) => ({
    source,
    writes: [],
    escapes: [["global", null]],
  })),
  { source: "try { throw this; } catch {}", writes: [], escapes: [] },
])(
  "escapes values thrown uncaught at the top level: $source",
  expectAmbientEffectPaths,
);
