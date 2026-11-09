import { expect, it } from "vitest";

import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import {
  semanticModuleAcquisitionEffectOrigin,
  semanticRequireOriginCandidate,
} from "./javascriptSemanticRequireOrigin.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";

const indexed = (source: string) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null)
    throw new Error("Expected builtin-module effect fixture");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
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
