import * as t from "@babel/types";

/** Visit every Babel AST node in deterministic source-tree order. */
export const traverseJavaScriptAst = (
  root: t.Node,
  visitor: {
    readonly enter: (node: t.Node, parent: t.Node | null) => void;
    readonly exit?: (node: t.Node, parent: t.Node | null) => void;
  },
): void => {
  const visit = (node: t.Node, parent: t.Node | null): void => {
    visitor.enter(node, parent);
    for (const child of childNodes(node)) visit(child, node);
    visitor.exit?.(node, parent);
  };
  visit(root, null);
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
