import * as t from "@babel/types";

/**
 * Visit every Babel AST node in deterministic source-tree order.
 *
 * `readAncestors` returns a snapshot during `enter`, outermost-first and
 * ending with the direct parent. Callers
 * need it whenever meaning depends on where a node sits, not just what its
 * immediate parent is — a binding inside `catch ({message})` or `({a} = o)`
 * has an ObjectProperty parent, so the parent alone cannot say whether the
 * identifier declares a binding or is assigned to.
 */
export const traverseJavaScriptAst = (
  root: t.Node,
  visitor: JavaScriptAstVisitor,
): void => completeSemanticSteps(traverseJavaScriptAstSteps(root, visitor));

/** Callbacks for one deterministic AST traversal. */
export interface JavaScriptAstVisitor {
  readonly enter: (
    node: t.Node,
    parent: t.Node | null,
    readAncestors: () => readonly t.Node[],
  ) => void;
  readonly exit?: (node: t.Node, parent: t.Node | null) => void;
}

/**
 * {@link traverseJavaScriptAst} with a yield every 1,024 visited nodes, so a
 * caller can serve control messages during one large traversal. Visit order
 * and callbacks are identical.
 */
export function* traverseJavaScriptAstSteps(
  root: t.Node,
  visitor: JavaScriptAstVisitor,
): Generator<void, void> {
  const ancestors: t.Node[] = [];
  const enter = (node: t.Node, parent: t.Node | null): TraversalFrame => {
    visitor.enter(node, parent, () => [...ancestors]);
    ancestors.push(node);
    return { node, parent, children: childNodes(node), nextIndex: 0 };
  };
  const pending = [enter(root, null)];
  let visited = 1;
  while (pending.length > 0) {
    const current = pending.at(-1);
    if (current === undefined) break;
    const child = current.children[current.nextIndex];
    if (child !== undefined) {
      current.nextIndex += 1;
      if (visited % 1024 === 0) yield;
      visited += 1;
      pending.push(enter(child, current.node));
    } else {
      visitor.exit?.(current.node, current.parent);
      ancestors.pop();
      pending.pop();
    }
  }
}

/** Run cooperative analysis steps to completion without yielding control. */
export const completeSemanticSteps = <Value>(
  steps: Iterator<void, Value>,
): Value => {
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
  }
};

interface TraversalFrame {
  readonly node: t.Node;
  readonly parent: t.Node | null;
  readonly children: readonly t.Node[];
  nextIndex: number;
}

/**
 * Child Babel nodes in `VISITOR_KEYS` order. Single owner for AST child
 * expansion; bespoke `Object.values` / duplicated `childNodes` walkers must
 * not be reintroduced (they diverge on loc/comment fields and ordering).
 */
export const childNodes = (node: t.Node): t.Node[] => {
  const keys = t.VISITOR_KEYS[node.type];
  if (keys === undefined) return [];
  const children: t.Node[] = [];
  for (const key of keys) {
    const value: unknown = Reflect.get(node, key);
    if (t.isNode(value)) {
      children.push(value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (t.isNode(item)) children.push(item);
    }
  }
  return children;
};
