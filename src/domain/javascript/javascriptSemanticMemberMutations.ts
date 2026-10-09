import * as t from "@babel/types";

import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { evaluateSemanticBinding } from "./javascriptSemanticValues.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

type PropertyPath = readonly (string | number | null)[];

/** Keep explicit property mutations outside the initializer-only value lattice. */
export const collectSemanticMemberMutations = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): void => {
  const parents = new WeakMap<t.Node, t.Node>();
  traverseJavaScriptAst(program, {
    enter: (node, parent) => {
      if (parent !== null) parents.set(node, parent);
    },
  });
  const markValue = (
    node: t.Node,
    path: PropertyPath,
    bindings: ReadonlySet<string>,
    mutation: t.Node,
  ): void => {
    const unwrapped = unwrapJavaScriptExpression(node).node;
    if (unwrapped !== node) {
      markValue(unwrapped, path, bindings, mutation);
      return;
    }
    if (t.isIdentifier(node)) {
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (binding === undefined || bindings.has(binding.bindingId)) return;
      const value = evaluateSemanticBinding(binding, state);
      if (value.status === "literal" || value.status === "union") return;
      binding.mutatedPaths.push(path);
      const nested = new Set([...bindings, binding.bindingId]);
      for (const initializer of mutationInitializers(
        binding,
        mutation,
        parents,
      ))
        markValue(
          initializer.node,
          [...initializer.projection, ...path],
          nested,
          mutation,
        );
      return;
    }
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      const members: (string | null)[] = [];
      let current: t.Node = node;
      while (
        t.isMemberExpression(current) ||
        t.isOptionalMemberExpression(current)
      ) {
        members.push(
          semanticStaticPropertyKey(current.property, current.computed),
        );
        current = current.object;
      }
      markValue(current, [...members.reverse(), ...path], bindings, mutation);
      return;
    }
    for (const value of referencedValues(node, path))
      markValue(value.node, value.path, bindings, mutation);
  };
  const markTarget = (node: t.Node, mutation: t.Node): void => {
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
      markValue(
        node.object,
        [semanticStaticPropertyKey(node.property, node.computed)],
        new Set(),
        mutation,
      );
    else if (t.isRestElement(node)) markTarget(node.argument, mutation);
    else if (t.isAssignmentPattern(node)) markTarget(node.left, mutation);
    else if (t.isArrayPattern(node)) {
      for (const element of node.elements)
        if (element !== null) markTarget(element, mutation);
    } else if (t.isObjectPattern(node)) {
      for (const property of node.properties)
        markTarget(
          t.isRestElement(property) ? property.argument : property.value,
          mutation,
        );
    }
  };
  traverseJavaScriptAst(program, {
    enter: (node) => {
      if (t.isAssignmentExpression(node)) markTarget(node.left, node);
      else if (t.isUpdateExpression(node)) markTarget(node.argument, node);
      else if (t.isUnaryExpression(node, { operator: "delete" }))
        markTarget(node.argument, node);
      else if (t.isForOfStatement(node) || t.isForInStatement(node))
        markTarget(node.left, node);
    },
  });
};

interface StatementPosition {
  readonly body: readonly t.Statement[];
  readonly index: number;
}

const statementPosition = (
  statement: t.Statement,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  const parent = parents.get(statement);
  if (!t.isProgram(parent) && !t.isBlockStatement(parent)) return null;
  const index = parent.body.indexOf(statement);
  return index < 0 ? null : { body: parent.body, index };
};

const directInitializerPosition = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  const parent = parents.get(node);
  if (t.isVariableDeclarator(parent) && parent.init === node) {
    const declaration = parents.get(parent);
    return t.isVariableDeclaration(declaration)
      ? statementPosition(declaration, parents)
      : null;
  }
  if (
    t.isAssignmentExpression(parent) &&
    parent.operator === "=" &&
    parent.right === node &&
    t.isIdentifier(parent.left)
  ) {
    const statement = parents.get(parent);
    return t.isExpressionStatement(statement) && statement.expression === parent
      ? statementPosition(statement, parents)
      : null;
  }
  return null;
};

const directMutationPosition = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  if (
    !t.isAssignmentExpression(node) &&
    !t.isUpdateExpression(node) &&
    !t.isUnaryExpression(node, { operator: "delete" })
  )
    return null;
  const statement = parents.get(node);
  return t.isExpressionStatement(statement) && statement.expression === node
    ? statementPosition(statement, parents)
    : null;
};

const mutationInitializers = (
  binding: JavaScriptSemanticBindingState,
  mutation: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): JavaScriptSemanticBindingState["initializers"] => {
  if (binding.initializers.length < 2) return binding.initializers;
  const mutationPosition = directMutationPosition(mutation, parents);
  if (mutationPosition === null) return binding.initializers;
  const positions = binding.initializers.map(({ node }) =>
    directInitializerPosition(node, parents),
  );
  if (
    positions.some(
      (position) =>
        position === null ||
        position.body !== mutationPosition.body ||
        position.index >= mutationPosition.index,
    )
  )
    return binding.initializers;
  const latestIndex = positions.reduce(
    (latest, position) => Math.max(latest, position?.index ?? -1),
    -1,
  );
  return binding.initializers.filter(
    (_, index) => positions[index]?.index === latestIndex,
  );
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
          const name = semanticStaticPropertyKey(
            property.key,
            property.computed,
          );
          return key === null || name === null || String(key) === name
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
  if (t.isAssignmentExpression(node, { operator: "&&=" }))
    return [{ node: node.right, path }];
  return [];
};
