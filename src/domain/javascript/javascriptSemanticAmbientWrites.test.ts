import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import {
  indexJavaScriptBindingsSteps,
  indexJavaScriptBindingsWithReceiversSteps,
} from "./javascriptSemanticAnalysis.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

it.each([
  ["localStorage", "", 2],
  ["sessionStorage", "", 2],
  ["window.localStorage", "", 2],
  ["localStorage", "localStorage.setItem=custom;", 0],
  ["localStorage", "expose(localStorage);", 0],
  ["localStorage", "localStorage.custom();", 0],
] as const)(
  "keeps native storage receivers distinct from opaque escapes: %s %s",
  (receiver, prefix, count) => {
    const analysis = analyzeJavaScriptStaticSource(`
      ${prefix}
      function first() { ${receiver}.setItem("a", "value"); }
      function second() { ${receiver}.setItem("b", "value"); }
    `);
    expect(analysis.storage).toHaveLength(count);
    if (count !== 0)
      expect(analysis.storage.map(({ name }) => name)).toEqual(["a", "b"]);
  },
);

it("retains opaque escapes in the canonical ordered ambient effect stream", () => {
  const parsed = parseJavaScriptSource(
    "const root=globalThis;mutate(root);",
    "app.cjs",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(
      parsed.program,
      "commonjs-wrapper",
    ),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  expect(
    index.bindings.ambientReferenceEffects.some(
      (effect) => effect.kind === "escape" && effect.path[0] === "global",
    ),
  ).toBe(true);
});

it("keeps promise constructor and then mutations as distinct producer paths", () => {
  const parsed = parseJavaScriptSource(
    'export {};const pending=import("ws");pending.then=()=>{};pending.constructor={};',
    "app.mjs",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const binding = [...index.bindings.bindingsById.values()].find(
    (binding) => binding.name === "pending",
  );
  expect(binding?.memberWrites.map((effect) => effect.path).sort()).toEqual([
    ["constructor"],
    ["then"],
  ]);
});

it("collects stored callback call sites once during definitions", () => {
  const parsed = parseJavaScriptSource(
    "const run=()=>0;run();const alias=run;alias();",
    "app.js",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  expect(state.callSites).toHaveLength(2);
  expect(new Set(state.callSites).size).toBe(2);
});

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
  expect(
    state.ambientReferenceEffects
      .filter(({ kind }) => kind === "write")
      .map(({ path }) => path),
  ).toEqual([
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
      state.ambientReferenceEffects.some(
        ({ path, kind }) =>
          kind === "escape" &&
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
    name: "repeated global self projections before an unrelated write",
    setup: `let alias = globalThis; alias = alias.globalThis.globalThis;
alias.unrelated = replacement;`,
    specifier: "./worker.js",
  },
  {
    name: "a global self alias before an unrelated write",
    setup: `let alias = globalThis; alias = alias.global;
alias.unrelated = replacement;`,
    specifier: "./worker.js",
  },
  {
    name: "a replaced constructor through repeated global self projections",
    setup: `let alias = globalThis; alias = alias.globalThis.globalThis;
alias.URL = replacement;`,
    specifier: null,
  },
  {
    name: "a possible ambient receiver alongside a local allocation",
    setup: `const local = { globalThis: {} };
const selected = flag ? globalThis : local;
selected.globalThis.URL = replacement;`,
    specifier: null,
  },
  {
    name: "a shadowed global self name with only local receivers",
    setup: `const globalThis = { globalThis: {} };
let alias = globalThis; alias = alias.globalThis;
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
  const effects = index.bindings.ambientReferenceEffects.filter(
    ({ path, kind }) =>
      kind === "escape" &&
      JSON.stringify(path) === JSON.stringify(["global", "require", null]),
  );
  expect(
    effects.map(({ node }) =>
      node === undefined ? null : source.slice(node.start ?? 0, node.end ?? 0),
    ),
  ).toEqual(["box.trigger", "box.trigger"]);
  expect(effects[0]?.node).not.toBe(effects[1]?.node);
});

it.each([
  {
    source:
      'Object.defineProperty({}, "x", { value: 1 }); Object.defineProperty({}, "y", { value: 2 });',
    path: ["global", "Object", "defineProperty"],
    escaped: false,
  },
  {
    source: 'const O = Object; O.defineProperty({}, "x", { value: 1 });',
    path: ["global", "Object", "defineProperty"],
    escaped: false,
  },
  {
    source:
      "window.fetch(endpoint); globalThis.fetch(endpoint); self.fetch(endpoint);",
    path: ["global", "URL"],
    escaped: false,
  },
  {
    source:
      'Object.defineProperty = replacement; Object.defineProperty({}, "x", {});',
    path: ["global", "Object", "defineProperty"],
    escaped: true,
  },
  {
    source: 'inspect(Object); Object.defineProperty({}, "x", {});',
    path: ["global", "Object", "defineProperty"],
    escaped: true,
  },
  {
    source: "Object[method]();",
    path: ["global", "Object", "defineProperty"],
    escaped: true,
  },
])(
  "preserves receiver escape proof for $source",
  ({ source, path, escaped }) => {
    const parsed = parseJavaScriptSource(source);
    if (parsed === null) throw new Error("Expected receiver fixture");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    completeSemanticSteps(index.indexAmbientWritesSteps());
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    expect(index.bindings.ambientEscapes.covers(path)).toBe(escaped);
  },
);

it("retains class allocation effects across outer and inner self bindings", () => {
  const parsed = parseJavaScriptSource(
    "class Base{}class Other{}class Derived extends Base{}Object.setPrototypeOf(Derived,Other);",
    "app.mjs",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const aliases = [...index.bindings.bindingsById.values()].filter(
    (binding) => binding.name === "Derived",
  );
  expect(aliases).toHaveLength(2);
  const allocation = aliases[0]?.initializers[0]?.node;
  expect(aliases[1]?.initializers[0]?.node).toBe(allocation);
  if (allocation?.type !== "ClassDeclaration")
    throw new Error("Expected class allocation");
  expect(index.bindings.literalMemberEffects?.get(allocation)).toContainEqual(
    expect.objectContaining({ kind: "escape", path: [] }),
  );
});
