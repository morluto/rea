import * as t from "@babel/types";

import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { evaluateSemanticBinding } from "./javascriptSemanticValues.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { semanticStaticPropertyName } from "./javascriptAstValues.js";

type PropertyPath = readonly (string | number | null)[];

/** Keep explicit property mutations outside the initializer-only value lattice. */
export const collectSemanticMemberMutations = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): void => {
  const markValue = (
    node: t.Node,
    path: PropertyPath,
    bindings: ReadonlySet<string>,
  ): void => {
    if (t.isIdentifier(node)) {
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (binding === undefined || bindings.has(binding.bindingId)) return;
      const value = evaluateSemanticBinding(binding, state);
      if (value.status === "literal" || value.status === "union") return;
      binding.mutatedPaths.push(path);
      const nested = new Set([...bindings, binding.bindingId]);
      for (const initializer of binding.initializers)
        markValue(
          initializer.node,
          [...initializer.projection, ...path],
          nested,
        );
      return;
    }
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      markValue(node.object, [propertyKey(node), ...path], bindings);
      return;
    }
    for (const value of referencedValues(node, path))
      markValue(value.node, value.path, bindings);
  };
  const markTarget = (node: t.Node): void => {
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
      markValue(node.object, [propertyKey(node)], new Set());
    else if (t.isRestElement(node)) markTarget(node.argument);
    else if (t.isAssignmentPattern(node)) markTarget(node.left);
    else if (t.isArrayPattern(node)) {
      for (const element of node.elements)
        if (element !== null) markTarget(element);
    } else if (t.isObjectPattern(node)) {
      for (const property of node.properties)
        markTarget(
          t.isRestElement(property) ? property.argument : property.value,
        );
    }
  };
  traverseJavaScriptAst(program, {
    enter: (node) => {
      if (t.isAssignmentExpression(node)) markTarget(node.left);
      else if (t.isUpdateExpression(node)) markTarget(node.argument);
      else if (t.isUnaryExpression(node, { operator: "delete" }))
        markTarget(node.argument);
      else if (t.isForOfStatement(node) || t.isForInStatement(node))
        markTarget(node.left);
    },
  });
};

interface ReferencedValue {
  readonly node: t.Node;
  readonly path: PropertyPath;
}

const referencedValues = (
  node: t.Node,
  path: PropertyPath,
): readonly ReferencedValue[] => {
  const [key, ...remaining] = path;
  // An initializer owns its slots; only deeper writes can affect shared children.
  if (t.isObjectExpression(node))
    return path.length < 2
      ? []
      : node.properties.flatMap<ReferencedValue>((property) => {
          if (t.isSpreadElement(property))
            return [{ node: property.argument, path }];
          if (!t.isObjectProperty(property)) return [];
          const name = semanticStaticPropertyName(
            property.key,
            property.computed,
          );
          return key === null ||
            (name === "" && !t.isStringLiteral(property.key, { value: "" })) ||
            String(key) === name
            ? [{ node: property.value, path: remaining }]
            : [];
        });
  if (t.isArrayExpression(node)) {
    if (path.length < 2) return [];
    let uncertainIndex = false;
    return node.elements.flatMap<ReferencedValue>((element, index) => {
      if (element === null) return [];
      if (t.isSpreadElement(element)) {
        uncertainIndex = true;
        return [{ node: element.argument, path: [null, ...remaining] }];
      }
      return uncertainIndex || key === null || String(key) === String(index)
        ? [{ node: element, path: remaining }]
        : [];
    });
  }
  if (
    t.isTSAsExpression(node) ||
    t.isTSTypeAssertion(node) ||
    t.isTSNonNullExpression(node)
  )
    return [{ node: node.expression, path }];
  if (t.isConditionalExpression(node))
    return [
      { node: node.consequent, path },
      { node: node.alternate, path },
    ];
  if (t.isLogicalExpression(node))
    return [
      { node: node.left, path },
      { node: node.right, path },
    ];
  return [];
};

const propertyKey = (
  node: t.MemberExpression | t.OptionalMemberExpression,
): string | null => {
  const name = semanticStaticPropertyName(node.property, node.computed);
  return name !== "" || t.isStringLiteral(node.property, { value: "" })
    ? name
    : null;
};
