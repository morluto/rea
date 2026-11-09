import { expect, it } from "vitest";

import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import {
  semanticBuiltinModuleEffectOrigin,
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
  expect(semanticBuiltinModuleEffectOrigin(expression, state)).toMatchObject({
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
