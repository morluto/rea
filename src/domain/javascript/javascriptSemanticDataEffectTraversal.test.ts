import * as t from "@babel/types";
import { expect, it } from "vitest";

import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import {
  traverseDataEffects,
  type DataEffectTraversalContext,
} from "./javascriptSemanticDataEffectHelpers.js";
import { semanticCallableIdForNode } from "./javascriptSemanticProjection.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";

const source = `
  import fs from "node:fs";
  export function outer(a) {
    const inner = () => fs.readFileSync(a ?? process.env.FILE);
    class Box { [inner()]() { return fetch("/x"); } static #p = 1; get v() { return 2; } }
    return { method() { return new Box(); }, arrow: async () => await inner() };
  }
`;

const contextFor = (text: string) => {
  const parsed = parseJavaScriptSource(text, "app.js");
  if (parsed === null) throw new Error("Expected the fixture to parse");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  ).bindings;
  const context: DataEffectTraversalContext = {
    state,
    callableIds: new Set(state.callables.map(({ callableId }) => callableId)),
    callableStack: [],
    ancestors: [],
  };
  return { program: parsed.program, context };
};

it("shows merged visitors exactly what separate traversals show", () => {
  const { program, context } = contextFor(source);
  const observe = (label: string, events: string[]) => (node: t.Node) => {
    events.push(
      [
        label,
        node.type,
        String(node.start),
        context.callableStack.join(">"),
        context.ancestors.map(({ type }) => type).join(">"),
      ].join("|"),
    );
  };
  const separateFirst: string[] = [];
  const separateSecond: string[] = [];
  traverseDataEffects(program, context, observe("first", separateFirst));
  traverseDataEffects(program, context, observe("second", separateSecond));

  const merged: string[] = [];
  traverseDataEffects(
    program,
    context,
    observe("first", merged),
    observe("second", merged),
  );

  expect(separateFirst.length).toBeGreaterThan(40);
  // Each visitor's own sequence is unchanged, including both stacks.
  expect(merged.filter((event) => event.startsWith("first|"))).toEqual(
    separateFirst,
  );
  expect(merged.filter((event) => event.startsWith("second|"))).toEqual(
    separateSecond,
  );
  // Visitors run in the order given at every node.
  expect(merged).toEqual(
    separateFirst.flatMap((event, index) => [event, separateSecond[index]]),
  );
  expect(context.callableStack).toEqual([]);
  expect(context.ancestors).toEqual([]);
});

it("classifies every Babel node type as its type guards do", () => {
  const expectedKind = (node: t.Node): string | null => {
    if (
      t.isClassMethod(node) ||
      t.isClassPrivateMethod(node) ||
      t.isObjectMethod(node)
    )
      return "method";
    if (t.isFunction(node)) return "function";
    if (t.isClass(node)) return "class";
    return null;
  };
  const callableTypes: string[] = [];
  for (const type of t.TYPES) {
    // Only the type is read; no other field of a real node is needed.
    const node = { type, start: 3, end: 9 } as t.Node;
    const kind = expectedKind(node);
    if (kind !== null) callableTypes.push(type);
    expect(semanticCallableIdForNode(node), type).toBe(
      kind === null ? null : `callable:${kind}:3:9`,
    );
  }
  expect(callableTypes.sort()).toEqual([
    "ArrowFunctionExpression",
    "ClassDeclaration",
    "ClassExpression",
    "ClassMethod",
    "ClassPrivateMethod",
    "FunctionDeclaration",
    "FunctionExpression",
    "ObjectMethod",
  ]);
});
