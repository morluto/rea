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
  visitor: {
    readonly enter: (
      node: t.Node,
      parent: t.Node | null,
      readAncestors: () => readonly t.Node[],
    ) => void;
    readonly exit?: (node: t.Node, parent: t.Node | null) => void;
  },
): void => {
  const ancestors: t.Node[] = [];
  const enter = (node: t.Node, parent: t.Node | null): TraversalFrame => {
    visitor.enter(node, parent, () => [...ancestors]);
    ancestors.push(node);
    return { node, parent, children: childNodes(node), nextIndex: 0 };
  };
  const pending = [enter(root, null)];
  while (pending.length > 0) {
    const current = pending.at(-1);
    if (current === undefined) break;
    const child = current.children[current.nextIndex];
    if (child !== undefined) {
      current.nextIndex += 1;
      pending.push(enter(child, current.node));
    } else {
      visitor.exit?.(current.node, current.parent);
      ancestors.pop();
      pending.pop();
    }
  }
};

interface TraversalFrame {
  readonly node: t.Node;
  readonly parent: t.Node | null;
  readonly children: readonly t.Node[];
  nextIndex: number;
}

const childNodes = (node: t.Node): t.Node[] => {
  const keys: readonly string[] = t.VISITOR_KEYS[node.type] ?? [];
  return keys.flatMap((key) => {
    const value: unknown = Reflect.get(node, key);
    if (t.isNode(value)) return [value];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is t.Node => t.isNode(item));
  });
};
