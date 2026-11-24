import * as t from "@babel/types";
import { expect, it } from "vitest";
import { indexJavaScriptBindingsSteps } from "../../../tests/fixtures/javascriptSemanticIndex.js";
import { semanticKnownArrayIterationAt } from "./javascriptSemanticReferenceSources.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

function indexedInitializer(source: string) {
  const parsed = parseJavaScriptSource(source, "array-iteration.js");
  if (parsed === null) throw new Error("Expected parsed source");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const statement = parsed.program.body.find(
    (statement) =>
      t.isVariableDeclaration(statement) &&
      statement.declarations.some(({ id }) =>
        t.isIdentifier(id, { name: "items" }),
      ),
  );
  const array = t.isVariableDeclaration(statement)
    ? statement.declarations[0]?.init
    : undefined;
  if (!t.isArrayExpression(array))
    throw new Error("Expected array initializer");
  return { state, array };
}

it.each([
  ["indirect eval before acquisition", 'const run=eval;run("0");', "", false],
  [
    "Function before acquisition",
    'const prepare=Function;prepare("return 0");',
    "",
    false,
  ],
  ["indirect eval after acquisition", "", 'const run=eval;run("0");', true],
  ["shadowed eval", 'const eval=()=>{};const run=eval;run("0");', "", true],
] as const)(
  "admits native array iteration with %s only when intact",
  (_name, before, after, intact) => {
    const { array, state } = indexedInitializer(
      `${before}const items=[1];${after}`,
    );
    expect(semanticKnownArrayIterationAt(array, state)).toBe(intact);
  },
);

it.each([
  [
    "indirect eval before the spread",
    'const run=eval;run("Array.prototype[Symbol.iterator]=function*(){yield 2}");const items=[...[1]];',
    false,
    0,
  ],
  [
    "Function before the spread",
    'const prepare=Function;prepare("return 0");const items=[...[1]];',
    false,
    0,
  ],
  [
    "indirect eval in the operand",
    'const run=eval;const items=[...[(run("0"),1)]];',
    false,
    0,
  ],
  [
    "indirect eval after the spread",
    'const items=[...[1]];const run=eval;run("0");',
    true,
    1,
  ],
  [
    "shadowed eval",
    'const eval=()=>{};const run=eval;run("0");const items=[...[1]];',
    true,
    1,
  ],
  [
    "earlier sibling opaque call",
    'const run=eval;const items=[run("0"),...[1]];',
    false,
    1,
  ],
  [
    "later sibling opaque call",
    'const run=eval;const items=[...[1],run("0")];',
    true,
    2,
  ],
] as const)(
  "retains spread positions with %s only when intact",
  (_name, source, intact, count) => {
    const { array, state } = indexedInitializer(source);
    const value = evaluateSemanticExpression(array, state, array);
    expect(value).toMatchObject({
      status: "array",
      unknownItems: !intact,
    });
    expect(value.status === "array" && value.items).toHaveLength(count);
  },
);
