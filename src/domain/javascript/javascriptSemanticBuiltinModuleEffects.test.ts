import { expect, it } from "vitest";

import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import {
  semanticModuleAcquisitionEffectOrigin,
  semanticRequireOriginCandidate,
} from "./javascriptSemanticRequireOrigin.js";
import { builtinDataEffectCallablePath } from "./javascriptSemanticDataEffectHelpers.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

const indexed = (source: string, commonJs = false) => {
  const parsed = parseJavaScriptSource(
    source,
    commonJs ? "fixture.cts" : undefined,
  );
  if (parsed === null)
    throw new Error("Expected builtin-module effect fixture");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(
      parsed.program,
      commonJs ? "commonjs-wrapper" : undefined,
    ),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  return index.bindings;
};

it.each([
  "process.getBuiltinModule('events').EventEmitter.prototype.on = replacement;",
  "globalThis.process['getBuiltinModule']('node:events').EventEmitter.prototype.on = replacement;",
  "(process?.getBuiltinModule?.('events')).EventEmitter.prototype.on = replacement;",
  "const events = process.getBuiltinModule('events'); events.EventEmitter.prototype.on = replacement;",
  "const events = process.getBuiltinModule('events'); const alias = events; alias.EventEmitter.prototype.on = replacement;",
  "const { getBuiltinModule: get } = process; get('events').EventEmitter.prototype.on = replacement;",
  "const get = process.getBuiltinModule; get('events').EventEmitter.prototype.on = replacement;",
  "const get = globalThis.process.getBuiltinModule; get('events').EventEmitter.prototype.on = replacement;",
  "const get0 = process.getBuiltinModule; const get = get0; get('events').EventEmitter.prototype.on = replacement;",
  "const host = process; host.getBuiltinModule('events').EventEmitter.prototype.on = replacement;",
  "const holder = { get: process.getBuiltinModule }; holder.get('events').EventEmitter.prototype.on = replacement;",
  "const get = process.getBuiltinModule; process.getBuiltinModule = other; get('events').EventEmitter.prototype.on = replacement;",

  "import process from 'node:process'; process.getBuiltinModule('events').EventEmitter.prototype.on = replacement;",
  "import { getBuiltinModule } from 'node:process'; getBuiltinModule('events').EventEmitter.prototype.on = replacement;",
  "import * as process from 'node:process'; const get = process.getBuiltinModule; get('events').EventEmitter.prototype.on = replacement;",
  "import { getBuiltinModule as get } from 'node:process'; const alias = get; alias('events').EventEmitter.prototype.on = replacement;",
])(
  "retains builtin acquisition writes as candidate module effects: %s",
  (source) => {
    const state = indexed(source);
    expect(state.requiredModuleEffects.get("events")).toContainEqual(
      expect.objectContaining({
        kind: "write",
        path: ["EventEmitter", "prototype", "on"],
        loaderAuthority: "candidate",
      }),
    );
  },
);

it("does not promote the effect-only acquisition into require provenance", () => {
  const state = indexed("const events = process.getBuiltinModule('events');");
  const binding = [...state.bindingsById.values()].find(
    ({ name }) => name === "events",
  );
  const expression = binding?.initializers[0]?.node;
  expect(
    semanticModuleAcquisitionEffectOrigin(expression, state),
  ).toMatchObject({
    specifier: "events",
    importedPath: [],
    loaderAuthority: "candidate",
  });
  expect(semanticRequireOriginCandidate(expression, state)).toBeUndefined();
});

it.each([
  "function run(process) { process.getBuiltinModule('events').EventEmitter.prototype.on = replacement; }",
  "process = other; process.getBuiltinModule('events').EventEmitter.prototype.on = replacement;",
  "const process = other; process.getBuiltinModule('events').EventEmitter.prototype.on = replacement;",
  "other.getBuiltinModule('events').EventEmitter.prototype.on = replacement;",
  "const process = other; const { getBuiltinModule: get } = process; get('events').EventEmitter.prototype.on = replacement;",
  "function run(process) { const get = process.getBuiltinModule; get('events').EventEmitter.prototype.on = replacement; }",
  "let get = process.getBuiltinModule; get = other; get('events').EventEmitter.prototype.on = replacement;",
  "const get = other.getBuiltinModule; get('events').EventEmitter.prototype.on = replacement;",

  "process.getBuiltinModule(specifier).EventEmitter.prototype.on = replacement;",
])(
  "does not invent module identity outside supported acquisition facts: %s",
  (source) => {
    expect(indexed(source).requiredModuleEffects.get("events") ?? []).toEqual(
      [],
    );
  },
);

it.each([
  "(await import('events')).EventEmitter.prototype.on = replacement;",
  "const events = await import('node:events'); events.EventEmitter.prototype.on = replacement;",
  "const { EventEmitter: EE } = await import('events'); EE.prototype.on = replacement;",
  "const events = await import('events'); const alias = events; alias.EventEmitter.prototype.on = replacement;",
])(
  "retains awaited import writes as candidate module effects: %s",
  (source) => {
    expect(indexed(source).requiredModuleEffects.get("events")).toContainEqual(
      expect.objectContaining({
        kind: "write",
        path: ["EventEmitter", "prototype", "on"],
        loaderAuthority: "candidate",
      }),
    );
  },
);

it("retains a dynamic default export without promoting its origin to require", () => {
  const state = indexed(
    "const events = await import('events'); events.default.prototype.on = replacement;",
  );
  expect(state.requiredModuleEffects.get("events")).toContainEqual(
    expect.objectContaining({
      kind: "write",
      path: ["default", "prototype", "on"],
      loaderAuthority: "candidate",
    }),
  );
  const binding = [...state.bindingsById.values()].find(
    ({ name }) => name === "events",
  );
  const expression = binding?.initializers[0]?.node;
  expect(
    semanticModuleAcquisitionEffectOrigin(expression, state),
  ).toMatchObject({
    specifier: "events",
    resolutionMode: "import",
    loaderAuthority: "candidate",
  });
  expect(semanticRequireOriginCandidate(expression, state)).toBeUndefined();
});

it.each([
  "import('events').EventEmitter.prototype.on = replacement;",
  "(await import(specifier)).EventEmitter.prototype.on = replacement;",
  "(await other('events')).EventEmitter.prototype.on = replacement;",
])("does not invent an awaited namespace from %s", (source) => {
  expect(indexed(source).requiredModuleEffects.get("events") ?? []).toEqual([]);
});

it.each([
  "(await (flag ? import('events') : import('node:events'))).EventEmitter.prototype.on = replacement;",
  "(await (sideEffect(), import('events'))).EventEmitter.prototype.on = replacement;",
  "(await (promise = import('events'))).EventEmitter.prototype.on = replacement;",
  "(await (other || import('events'))).EventEmitter.prototype.on = replacement;",
])("retains awaited branch value acquisition effects: %s", (source) => {
  expect(
    indexed(
      `import { EventEmitter } from 'events'; ${source}`,
    ).requiredModuleEffects.get("events"),
  ).toContainEqual(
    expect.objectContaining({
      kind: "write",
      path: ["EventEmitter", "prototype", "on"],
      loaderAuthority: "candidate",
    }),
  );
});

it.each([
  "(flag ? import('events') : import('node:events')).EventEmitter.prototype.on = replacement;",
  "(await (import('events'), other)).EventEmitter.prototype.on = replacement;",
  "(await import('events').selected).EventEmitter.prototype.on = replacement;",
  "(await { pending: import('events') }).pending.EventEmitter.prototype.on = replacement;",
  "(await [import('events')])[0].EventEmitter.prototype.on = replacement;",
  "(await { pending: flag ? import('events') : import('node:events') }).pending.EventEmitter.prototype.on = replacement;",
])(
  "does not apply await to unrelated values or Promise children: %s",
  (source) => {
    expect(
      indexed(
        `import { EventEmitter } from 'events'; ${source}`,
      ).requiredModuleEffects.get("events") ?? [],
    ).toEqual([]);
  },
);

it.each([
  "flag ? import('events') : import('node:events')",
  "sideEffect(), import('events')",
  "promise = import('events')",
  "other || import('events')",
])("retains escaped awaited branch namespaces: %s", (acquisition) => {
  const state = indexed(
    `import { EventEmitter } from 'events'; configure((await (${acquisition})).EventEmitter.prototype);`,
  );
  expect(state.requiredModuleEffects.get("events")).toContainEqual(
    expect.objectContaining({
      kind: "escape",
      path: ["EventEmitter", "prototype"],
      loaderAuthority: "candidate",
    }),
  );
});

const eventConstructorPaths = (state: ReturnType<typeof indexed>) => {
  const paths: (readonly string[] | null)[] = [];
  traverseJavaScriptAst(state.program, {
    enter(node) {
      if (node.type === "NewExpression")
        paths.push(
          builtinDataEffectCallablePath(node.callee, state, [
            "events",
            "node:events",
          ]),
        );
    },
  });
  return paths;
};

// CommonJS TypeScript fixtures retain inert imports with explicit wrapper authority.

it.each([
  [
    "default events to node:events",
    `import A from "events"; import B from "node:events";`,
  ],
  [
    "default node:events to events",
    `import A from "node:events"; import B from "events";`,
  ],
  [
    "default to require",
    `import A from "events"; const B = require("node:events");`,
  ],
  [
    "require to default",
    `const A = require("node:events"); import B from "events";`,
  ],
  [
    "default node:events to require",
    `import A from "node:events"; const B = require("events");`,
  ],
  [
    "require events to default",
    `const A = require("events"); import B from "node:events";`,
  ],
])("owns shared constructor-slot writes from %s", (_name, header) => {
  const state = indexed(
    `${header}
const before = new B.EventEmitter();
const Ctor = B.EventEmitter;
const object = B;
A.EventEmitter = replacement;
const saved = new Ctor();
const after = new B.EventEmitter();
const throughSavedObject = new object.EventEmitter();`,
    header.includes("require("),
  );
  expect(state.requiredModuleEffects.get("events")).toContainEqual(
    expect.objectContaining({
      kind: "write",
      path: ["EventEmitter"],
    }),
  );
  expect(eventConstructorPaths(state)).toEqual([
    ["EventEmitter"],
    ["EventEmitter"],
    null,
    null,
  ]);
});

it("keeps named and namespace export snapshots separate from mutable default slots", () => {
  const state = indexed(`import A from "events";
import B, { EventEmitter as Ctor } from "node:events";
import * as ns from "node:events";
A.EventEmitter = replacement;
const named = new Ctor();
const namespace = new ns.EventEmitter();
const mutable = new B.EventEmitter();`);
  expect(eventConstructorPaths(state)).toEqual([
    ["EventEmitter"],
    ["EventEmitter"],
    null,
  ]);
});

it("does not share replacement of an immutable namespace export slot", () => {
  const state =
    indexed(`import * as ns from "events"; import B from "node:events";
ns.EventEmitter = replacement;
const e = new B.EventEmitter();`);
  expect(state.requiredModuleEffects.get("events") ?? []).toEqual([]);
  expect(eventConstructorPaths(state)).toEqual([["EventEmitter"]]);
});

it.each([
  ["unrelated property", "A.extra = replacement;", ["EventEmitter"]],
  ["unknown property", "A[key] = replacement;", null],
  ["containing object escape", "configure(A);", null],
  ["class value escape", "configure(A.EventEmitter);", ["EventEmitter"]],
] as const)(
  "uses shared path coverage for an events %s",
  (_name, mutation, path) => {
    const state = indexed(`import A from "events"; import B from "node:events";
${mutation}
const e = new B.EventEmitter();`);
    expect(eventConstructorPaths(state)).toEqual([path]);
  },
);

it.each([
  "process.getBuiltinModule('events')",
  "(await import('events'))",
  "(await import('node:events'))",
])(
  "does not promote %s into a proven constructor after sharing default effects",
  (acquisition) => {
    const state = indexed(`import A from "events";
const acquired = ${acquisition};
const before = new acquired.EventEmitter();
A.EventEmitter = replacement;
const after = new acquired.EventEmitter();`);
    expect(eventConstructorPaths(state)).toEqual([null, null]);
  },
);

it.each([
  "process.getBuiltinModule.call(null, 'events')",
  "process.getBuiltinModule.apply(null, ['events'])",
  "Reflect.apply(process.getBuiltinModule, null, ['events'])",
  "Function.prototype.call.call(process.getBuiltinModule, null, 'events')",
  "process.getBuiltinModule.call.call(process.getBuiltinModule, null, 'events')",
  "process.getBuiltinModule.bind(null, 'events')()",
  "process.getBuiltinModule.bind(null)('events')",
  "process.getBuiltinModule.bind(null).bind(null, 'events')()",
  "(process.getBuiltinModule?.call(null, 'events'))",
  "globalThis.process.getBuiltinModule.apply(null, ['node:events'])",
])("normalizes effective builtin-getter arguments: %s", (getter) => {
  const source = `${getter}.EventEmitter.prototype.on = replacement;`;
  const state = indexed(source);
  expect(state.requiredModuleEffects.get("events")).toContainEqual(
    expect.objectContaining({
      kind: "write",
      path: ["EventEmitter", "prototype", "on"],
      loaderAuthority: "candidate",
    }),
  );
});

it.each([
  "const get = process.getBuiltinModule; get.call(null, 'events')",
  "const { getBuiltinModule: get } = process; get.apply(null, ['events'])",
  "const host = process; host.getBuiltinModule.call(null, 'events')",
  "const holder = { get: process.getBuiltinModule }; holder.get.call(null, 'events')",
  "const get = process.getBuiltinModule.bind(null, 'events'); const alias = get; alias()",
  "const host = process; const get = host.getBuiltinModule.bind(null); get('events')",
  "import process from 'node:process'; process.getBuiltinModule.call(null, 'events')",
  "import { getBuiltinModule as get } from 'process'; get.call(null, 'events')",
  "import * as process from 'node:process'; process.getBuiltinModule.apply(null, ['events'])",
  "import { getBuiltinModule as get } from 'process'; const alias = get; Reflect.apply(alias, null, ['events'])",
])(
  "uses existing getter provenance without a separate alias walker: %s",
  (getter) => {
    expect(
      indexed(
        `${getter}.EventEmitter.prototype.on = replacement;`,
      ).requiredModuleEffects.get("events"),
    ).toContainEqual(
      expect.objectContaining({
        kind: "write",
        path: ["EventEmitter", "prototype", "on"],
        loaderAuthority: "candidate",
      }),
    );
  },
);

it.each([
  "process.getBuiltinModule.call.call(other, null, 'events')",
  "(0, process.getBuiltinModule.call)(null, 'events')",
  "const call = process.getBuiltinModule.call; call(null, 'events')",
  "process.getBuiltinModule.call(null, specifier)",
  "process.getBuiltinModule.apply(null, args)",
  "process.getBuiltinModule.apply(null, [, 'events'])",
  "process.getBuiltinModule.call(...args)",
  "process.getBuiltinModule.bind(null, specifier)()",
  "process.getBuiltinModule.call = other; process.getBuiltinModule.call(null, 'events')",
  "Function.prototype.apply = other; process.getBuiltinModule.apply(null, ['events'])",
  "Reflect.apply = other; Reflect.apply(process.getBuiltinModule, null, ['events'])",
  "process.getBuiltinModule.bind = other; process.getBuiltinModule.bind(null, 'events')()",
  "import process from 'process'; process.getBuiltinModule.call = other; process.getBuiltinModule.call(null, 'events')",
  "const process = other; process.getBuiltinModule.call(null, 'events')",
  "const Reflect = other; Reflect.apply(process.getBuiltinModule, null, ['events'])",
])(
  "does not guess getter arguments through unknown invocation facts: %s",
  (getter) => {
    expect(
      indexed(
        `${getter}.EventEmitter.prototype.on = replacement;`,
      ).requiredModuleEffects.get("events") ?? [],
    ).toEqual([]);
  },
);

it.each([
  "process.getBuiltinModule.call(null, 'events')",
  "process.getBuiltinModule.bind(null, 'events')()",
])(
  "does not promote normalized getter calls to loader authority: %s",
  (getter) => {
    const state = indexed(`const events = ${getter};`);
    const expression = [...state.bindingsById.values()].find(
      ({ name }) => name === "events",
    )?.initializers[0]?.node;
    expect(
      semanticModuleAcquisitionEffectOrigin(expression, state),
    ).toMatchObject({ specifier: "events", loaderAuthority: "candidate" });
    expect(semanticRequireOriginCandidate(expression, state)).toBeUndefined();
  },
);

it.each([
  "import {getBuiltinModule as get} from 'process'; get.bind(null, 'events')()",
  "const holder = { get: process.getBuiltinModule }; holder.get.bind(null, 'events')()",
])(
  "does not invent bound-capture facts for unsupported sources: %s",
  (getter) => {
    expect(
      indexed(
        `${getter}.EventEmitter.prototype.on = replacement;`,
      ).requiredModuleEffects.get("events") ?? [],
    ).toEqual([]);
  },
);

it("preserves candidate-only direct acquisition after a getter replacement", () => {
  expect(
    indexed(
      "process.getBuiltinModule = replacement; process.getBuiltinModule('events').EventEmitter.prototype.on = other;",
    ).requiredModuleEffects.get("events"),
  ).toContainEqual(
    expect.objectContaining({
      path: ["EventEmitter", "prototype", "on"],
      loaderAuthority: "candidate",
    }),
  );
});

it("invalidates the getter helper reader when a shared process effect is indexed later", () => {
  const state = indexed(
    "import process from 'process'; const events = process.getBuiltinModule.call(null, 'events');",
  );
  const expression = [...state.bindingsById.values()].find(
    ({ name }) => name === "events",
  )?.initializers[0]?.node;
  expect(
    semanticModuleAcquisitionEffectOrigin(expression, state),
  ).toBeDefined();
  state.requiredModuleEffects.set("process", [
    ...(state.requiredModuleEffects.get("process") ?? []),
    { kind: "write", path: ["getBuiltinModule", "call"], node: undefined },
  ]);
  expect(
    semanticModuleAcquisitionEffectOrigin(expression, state),
  ).toBeUndefined();
});

it.each([
  "process.getBuiltinModule('fs');",
  "process.getBuiltinModule.call(null, 'fs');",
  "import process from 'process'; process.getBuiltinModule.call(null, 'fs');",
  "const get = process.getBuiltinModule.bind(null); get('fs');",
])(
  "does not treat a prior getter invocation as a helper replacement: %s",
  (prefix) => {
    expect(
      indexed(
        `${prefix} process.getBuiltinModule.call(null, 'events').EventEmitter.prototype.on = replacement;`,
      ).requiredModuleEffects.get("events"),
    ).toContainEqual(
      expect.objectContaining({
        kind: "write",
        path: ["EventEmitter", "prototype", "on"],
        loaderAuthority: "candidate",
      }),
    );
  },
);

it.each([
  "const get = process.getBuiltinModule; process.getBuiltinModule = other; get.call(null, 'events')",
  "process.getBuiltinModule = other; process.getBuiltinModule.call(null, 'events')",
  "const host = process; process = other; host.getBuiltinModule.call(null, 'events')",
])(
  "retains a possible getter without requiring an unchanged parent slot: %s",
  (getter) => {
    expect(
      indexed(
        `${getter}.EventEmitter.prototype.on = replacement;`,
      ).requiredModuleEffects.get("events"),
    ).toContainEqual(
      expect.objectContaining({
        path: ["EventEmitter", "prototype", "on"],
        loaderAuthority: "candidate",
      }),
    );
  },
);

it.each([
  "globalThis.process = other; globalThis.process.getBuiltinModule.call(null, 'events')",
  "globalThis.process = other; globalThis.process.getBuiltinModule.bind(null, 'events')()",
  "globalThis.process.getBuiltinModule.call = other; globalThis.process.getBuiltinModule.call(null, 'events')",
  "process.getBuiltinModule[key] = other; process.getBuiltinModule.call(null, 'events')",
  "globalThis[key].getBuiltinModule.call = other; globalThis.process.getBuiltinModule.call(null, 'events')",
])(
  "does not mistake a fallback intrinsic path for a candidate getter: %s",
  (getter) => {
    expect(
      indexed(
        `${getter}.EventEmitter.prototype.on = replacement;`,
      ).requiredModuleEffects.get("events") ?? [],
    ).toEqual([]);
  },
);
