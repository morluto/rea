import * as t from "@babel/types";
import { expect, it } from "vitest";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import {
  createSemanticOpaqueReferenceEffectQuery,
  semanticOpaqueBindingEffects,
} from "./javascriptSemanticOpaqueEffects.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

it.each([
  "const label=()=>0;consume(label.name);eval('x');consume(label.name);eval('y');",
  "const label=()=>0;consume(label.name);{eval('x');eval('y')}consume(label.name);",
  "const label=()=>0;consume(label.name);if(flag){eval('x')}else{eval('y')}consume(label.name);",
  "const label=()=>0;function later(){eval('x');consume(label.name)}consume(label.name);eval('y');",
  "function run(){const label=()=>0;consume(label.name);eval('x');consume(label.name);eval('y')}",
  "const label=()=>0;for(const item of []){eval('x')}consume(label.name);eval('y');",
  "const label=()=>0;consume(label.name);for(const item of [1]){eval('x')}consume(label.name);eval('y');",
  "const label=()=>0;{const label=1;eval('x')}consume(label.name);eval('y');",
])("preserves individual effect timing in the opaque query: %s", (source) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("Expected parsed opaque query fixture");
  const { bindings: state } = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  const binding = [...state.bindingsById.values()].find(
    (binding) => binding.name === "label",
  );
  if (binding === undefined) throw new Error("Expected callable binding");
  const query = createSemanticOpaqueReferenceEffectQuery(state);
  const effects = [
    ...semanticOpaqueBindingEffects(binding, state, "reference"),
  ];
  expect(effects.length).toBeGreaterThan(0);
  let reads = 0;
  traverseJavaScriptAst(parsed.program, {
    enter: (node) => {
      if (!t.isMemberExpression(node)) return;
      reads++;
      expect(query(binding, node)).toBe(
        effects.length === 0
          ? undefined
          : effects.some(
              (effect) => semanticEffectTiming(node, effect, state) !== "after",
            ),
      );
    },
  });
  expect(reads).toBeGreaterThan(0);
});
