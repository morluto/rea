import * as t from "@babel/types";

import { semanticStaticPropertyKey } from "./javascriptAstValues.js";
import type { JavaScriptSemanticBindingState } from "./javascriptSemanticState.js";

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
  if (t.isForOfStatement(node)) return statementPosition(node, parents);
  if (t.isVariableDeclarator(node)) {
    const declaration = parents.get(node);
    return t.isVariableDeclaration(declaration)
      ? statementPosition(declaration, parents)
      : null;
  }
  if (t.isSpreadElement(node)) {
    const array = parents.get(node);
    return t.isArrayExpression(array)
      ? semanticCapturePosition(array, parents)
      : null;
  }
  if (
    !t.isAssignmentExpression(node) &&
    !t.isUpdateExpression(node) &&
    !t.isUnaryExpression(node, { operator: "delete" }) &&
    !t.isCallExpression(node) &&
    !t.isOptionalCallExpression(node) &&
    !t.isNewExpression(node) &&
    !t.isTaggedTemplateExpression(node)
  )
    return null;
  const statement = parents.get(node);
  return t.isExpressionStatement(statement) && statement.expression === node
    ? statementPosition(statement, parents)
    : null;
};

const referenceInitializerPosition = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  // Defaults live inside the declaration pattern rather than its initializer.
  let current = node;
  while (true) {
    const direct = directInitializerPosition(current, parents);
    if (direct !== null) return direct;
    const parent = parents.get(current);
    if (parent === undefined || t.isStatement(parent) || t.isFunction(parent))
      return null;
    if (t.isVariableDeclarator(parent)) {
      const declaration = parents.get(parent);
      return t.isVariableDeclaration(declaration)
        ? statementPosition(declaration, parents)
        : null;
    }
    current = parent;
  }
};

/** Resolve origins at their use or capture, never at a later transitive effect. */
export const semanticMutationInitializers = (
  binding: JavaScriptSemanticBindingState,
  mutation: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): Pick<
  JavaScriptSemanticBindingState,
  "initializers" | "referenceInitializers"
> => {
  const mutationPosition =
    directMutationPosition(mutation, parents) ??
    referenceInitializerPosition(mutation, parents);
  if (mutationPosition === null) return binding;
  const origins = [
    ...binding.initializers.map((initializer) => ({
      initializer,
      position:
        initializer.entryBody === undefined
          ? directInitializerPosition(initializer.node, parents)
          : { body: initializer.entryBody.body, index: -1 },
    })),
    ...binding.referenceInitializers.map((initializer) => ({
      initializer,
      position: referenceInitializerPosition(initializer.node, parents),
    })),
  ];
  if (
    origins.some(
      ({ position }) =>
        position === null ||
        position.body !== mutationPosition.body ||
        position.index >= mutationPosition.index,
    )
  )
    return binding;
  const latestIndex = origins.reduce(
    (latest, { position }) => Math.max(latest, position?.index ?? -1),
    -1,
  );
  const retained = new Set(
    origins
      .filter(({ position }) => position?.index === latestIndex)
      .map(({ initializer }) => initializer),
  );
  return {
    initializers: binding.initializers.filter((initializer) =>
      retained.has(initializer),
    ),
    referenceInitializers: binding.referenceInitializers.filter((initializer) =>
      retained.has(initializer),
    ),
  };
};

/** Locate a capture only in an unconditional declaration or literal initializer. */
export const semanticCapturePosition = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  let current = node;
  while (true) {
    const direct = directInitializerPosition(current, parents);
    if (direct !== null) return direct;
    const parent = parents.get(current);
    if (
      t.isObjectProperty(parent) &&
      parent.value === current &&
      semanticStaticPropertyKey(parent.key, parent.computed) !== null
    )
      current = parent;
    else if (t.isObjectExpression(parent) || t.isArrayExpression(parent))
      current = parent;
    else return null;
  }
};

/** Intermediate values must themselves have been initialized before capture. */
export const semanticBindingPrecedesCapture = (
  binding: JavaScriptSemanticBindingState,
  capture: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  const initializer = binding.initializers[0];
  if (binding.initializers.length !== 1 || initializer === undefined)
    return false;
  const sourcePosition = directInitializerPosition(initializer.node, parents);
  const capturePosition = semanticCapturePosition(capture, parents);
  return (
    sourcePosition !== null &&
    capturePosition !== null &&
    sourcePosition.body === capturePosition.body &&
    sourcePosition.index < capturePosition.index
  );
};

/** Ignore later escapes only while reading earlier references in one activation. */
export const semanticEscapeFollowsCapture = (
  binding: JavaScriptSemanticBindingState,
  capture: t.Node,
  escape: t.Node | undefined,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  const initializer = binding.initializers[0];
  if (
    escape === undefined ||
    initializer === undefined ||
    !semanticBindingPrecedesCapture(binding, capture, parents)
  )
    return false;
  // A literal allocates here. Aliases are evaluated at the same capture point,
  // so an outer/persistent origin still receives all of its own escape effects.
  if (
    !t.isObjectExpression(initializer.node) &&
    !t.isArrayExpression(initializer.node) &&
    !t.isIdentifier(initializer.node) &&
    !t.isMemberExpression(initializer.node) &&
    !t.isOptionalMemberExpression(initializer.node)
  )
    return false;
  const capturePosition = semanticCapturePosition(capture, parents);
  const escapePosition = directMutationPosition(escape, parents);
  return (
    capturePosition !== null &&
    escapePosition !== null &&
    capturePosition.body === escapePosition.body &&
    capturePosition.index < escapePosition.index
  );
};
