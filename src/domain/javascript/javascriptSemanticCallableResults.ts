import * as t from "@babel/types";

import { childNodes } from "./javascriptSemanticTraversal.js";

/** One direct return or yield, excluding every nested callable. */
export interface SemanticCallableResultExpression {
  readonly node: t.Node | null;
  readonly site: t.Node;
  readonly kind: "return" | "yield";
  readonly delegated: boolean;
}

/** Collect direct result syntax without executing or evaluating a callable. */
export const semanticCallableResultExpressions = (
  callable: t.Node,
): readonly SemanticCallableResultExpression[] => {
  if (
    t.isArrowFunctionExpression(callable) &&
    !t.isBlockStatement(callable.body)
  )
    return [
      {
        node: callable.body,
        site: callable.body,
        kind: "return",
        delegated: false,
      },
    ];
  if (!t.isFunction(callable)) return [];
  const output: SemanticCallableResultExpression[] = [];
  const pending = childNodes(callable.body).reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined || t.isFunction(node) || t.isClass(node)) continue;
    if (t.isReturnStatement(node)) {
      output.push({
        node: node.argument ?? null,
        site: node,
        kind: "return",
        delegated: false,
      });
    }
    if (t.isYieldExpression(node))
      output.push({
        node: node.argument ?? null,
        site: node,
        kind: "yield",
        delegated: node.delegate,
      });
    for (const child of childNodes(node).reverse()) pending.push(child);
  }
  return output;
};
