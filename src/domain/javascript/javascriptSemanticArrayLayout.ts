import * as t from "@babel/types";
import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";
import { ambientPathMayObserveAt } from "./javascriptSemanticEffectLog.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";

/** Shared intrinsic reached through a native array iterator's prototype. */
export const semanticArrayIteratorPrototypePath = [
  "array-iterator-prototype",
] as const;
const iteratorNextPath = [
  ...semanticArrayIteratorPrototypePath,
  "next",
] as const;

export const semanticNativeArrayIteratorIntactAt = (
  state: JavaScriptSemanticAnalysisState,
  acquisition: t.Node,
): boolean =>
  !state.arrayIterationUnknown &&
  !ambientPathMayObserveAt(state, acquisition, iteratorNextPath, "contents");

type ArrayLiteralSlot = {
  readonly kind: "slot";
  readonly element: t.Expression | null;
  readonly depth: number;
};

type ArrayLiteralPart =
  | ArrayLiteralSlot
  | {
      readonly kind: "opaque-spread";
      readonly argument: t.Expression;
    };

const denseInlineSlots = (
  spread: t.SpreadElement,
  state: JavaScriptSemanticAnalysisState,
  allowance: { remaining: number },
): readonly ArrayLiteralSlot[] | undefined => {
  if (allowance.remaining === 0) return undefined;
  allowance.remaining--;
  const spreadArray = (part: t.SpreadElement) => {
    const argument = unwrapJavaScriptExpression(part.argument).node;
    return t.isArrayExpression(argument) &&
      semanticNativeArrayIteratorIntactAt(state, part)
      ? argument
      : undefined;
  };
  const root = spreadArray(spread);
  if (root === undefined) return undefined;
  const pending = [{ array: root, index: 0 }];
  const slots: ArrayLiteralSlot[] = [];
  while (pending.length > 0) {
    const frame = pending.at(-1)!;
    if (frame.index === frame.array.elements.length) {
      pending.pop();
      continue;
    }
    if (allowance.remaining === 0) return undefined;
    allowance.remaining--;
    const element = frame.array.elements[frame.index++]!;
    if (element === null) return undefined;
    if (t.isSpreadElement(element)) {
      const array = spreadArray(element);
      if (array === undefined) return undefined;
      pending.push({ array, index: 0 });
    } else slots.push({ kind: "slot", element, depth: pending.length + 1 });
  }
  return slots;
};

/** Source slots in destination order, with unresolved spread positions explicit. */
export function* semanticArrayLiteralLayout(
  root: t.ArrayExpression,
  state?: JavaScriptSemanticAnalysisState,
): IterableIterator<ArrayLiteralPart> {
  const allowance = { remaining: state?.precision.alias_selections ?? 0 };
  let opaque = false;
  for (const element of root.elements) {
    if (!t.isSpreadElement(element)) {
      yield { kind: "slot", element, depth: 1 };
      continue;
    }
    const slots =
      !opaque && state !== undefined
        ? denseInlineSlots(element, state, allowance)
        : undefined;
    if (slots !== undefined) yield* slots;
    else {
      opaque = true;
      yield { kind: "opaque-spread", argument: element.argument };
    }
  }
}

/** A complete index for consumers that need repeated lookups in one query. */
export const semanticArrayLiteralSlots = (
  root: t.ArrayExpression,
  state: JavaScriptSemanticAnalysisState,
): readonly (t.Expression | null)[] | undefined => {
  if (
    root.elements.every(
      (element): element is t.Expression | null => !t.isSpreadElement(element),
    )
  )
    return root.elements;
  const slots: (t.Expression | null)[] = [];
  for (const part of semanticArrayLiteralLayout(root, state)) {
    if (part.kind === "opaque-spread") return undefined;
    slots.push(part.element);
  }
  return slots;
};
