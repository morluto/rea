import * as t from "@babel/types";

/**
 * Visit every Babel AST node in deterministic source-tree order.
 *
 * `ancestors` runs outermost-first and ends with the direct parent. Callers
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
      ancestors: readonly t.Node[],
    ) => void;
    readonly exit?: (node: t.Node, parent: t.Node | null) => void;
  },
): void => {
  const visit = (
    node: t.Node,
    parent: t.Node | null,
    ancestors: readonly t.Node[],
  ): void => {
    visitor.enter(node, parent, ancestors);
    for (const child of childNodes(node))
      visit(child, node, [...ancestors, node]);
    visitor.exit?.(node, parent);
  };
  visit(root, null, []);
};

const childNodes = (node: t.Node): t.Node[] => {
  const keys: readonly string[] = t.VISITOR_KEYS[node.type] ?? [];
  return keys.flatMap((key) => {
    const value: unknown = Reflect.get(node, key);
    if (t.isNode(value)) return [value];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is t.Node => t.isNode(item));
  });
};
