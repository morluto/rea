import * as t from "@babel/types";

import type {
  JavaScriptSemanticCallable,
  JavaScriptSemanticObjectOperation,
} from "./javascriptSemanticIr.js";
import {
  semanticCallableIdForNode,
  semanticReadsBeforeWrite,
} from "./javascriptSemanticProjection.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";

/** Recover bounded static property reads, writes, spreads, and destructuring. */
export const collectJavaScriptSemanticObjects = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): JavaScriptSemanticObjectOperation[] => {
  const output: JavaScriptSemanticObjectOperation[] = [];
  const callableIds = new Set(callables.map(({ callableId }) => callableId));
  const callableStack: string[] = [];
  const context: ObjectCollectionContext = { state, output };
  traverseJavaScriptAst(program, {
    enter: (node, parent) => {
      const callableId = semanticCallableIdForNode(node);
      if (callableId !== null && callableIds.has(callableId))
        callableStack.push(callableId);
      const ownerCallableId = callableStack.at(-1) ?? null;
      if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
        collectMember(node, parent, ownerCallableId, context);
      else if (
        t.isSpreadElement(node) &&
        parent !== null &&
        t.isObjectExpression(parent)
      ) {
        const identity = expressionObjectIdentity(node.argument, state);
        addObjectOperation(
          {
            node,
            kind: "spread",
            ownerCallableId,
            objectBindingId: identity.bindingId,
            targetBindingId: null,
            propertyPath: identity.path,
          },
          state,
          output,
        );
      } else if (
        t.isVariableDeclarator(node) &&
        (t.isObjectPattern(node.id) || t.isArrayPattern(node.id))
      )
        collectDestructuring(node, ownerCallableId, state, output);
    },
    exit: (node) => {
      const callableId = semanticCallableIdForNode(node);
      if (callableId !== null && callableStack.at(-1) === callableId)
        callableStack.pop();
    },
  });
  return output;
};

interface ObjectCollectionContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly output: JavaScriptSemanticObjectOperation[];
}

const collectMember = (
  node: t.MemberExpression | t.OptionalMemberExpression,
  parent: t.Node | null,
  ownerCallableId: string | null,
  context: ObjectCollectionContext,
): void => {
  const { state, output } = context;
  // A chain is one property access; retaining every prefix duplicates work and
  // would make full paths quadratic in deeply nested producer expressions.
  if (
    (t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) &&
    parent.object === node
  )
    return;
  const identity = expressionObjectIdentity(node, state);
  const write =
    (t.isAssignmentExpression(parent) && parent.left === node) ||
    (t.isUpdateExpression(parent) && parent.argument === node);
  const readsBeforeWrite = write && semanticReadsBeforeWrite(node, parent);
  if (readsBeforeWrite)
    addObjectOperation(
      {
        node,
        kind: "read",
        ownerCallableId,
        objectBindingId: identity.bindingId,
        targetBindingId: null,
        propertyPath: identity.path,
      },
      state,
      output,
    );
  addObjectOperation(
    {
      node,
      kind: write ? "write" : "read",
      ownerCallableId,
      objectBindingId: identity.bindingId,
      targetBindingId: null,
      propertyPath: identity.path,
    },
    state,
    output,
  );
};

const collectDestructuring = (
  node: t.VariableDeclarator,
  ownerCallableId: string | null,
  state: JavaScriptSemanticAnalysisState,
  output: JavaScriptSemanticObjectOperation[],
): void => {
  const source = expressionObjectIdentity(node.init, state);
  const visit = (pattern: t.Node, path: readonly string[]): void => {
    if (t.isObjectPattern(pattern)) {
      for (const property of pattern.properties) {
        if (!t.isObjectProperty(property)) continue;
        const name = semanticStaticPropertyKey(property.key, property.computed);
        if (name !== null) visit(property.value, [...path, name]);
      }
      return;
    }
    if (t.isArrayPattern(pattern)) {
      pattern.elements.forEach((element, index) => {
        if (element !== null && !t.isRestElement(element))
          visit(element, [...path, String(index)]);
      });
      return;
    }
    const target = bindingIdentifier(pattern);
    if (target === null) return;
    addObjectOperation(
      {
        node: pattern,
        kind: "destructure",
        ownerCallableId,
        objectBindingId: source.bindingId,
        targetBindingId:
          resolveSemanticBindingState(state, target, target.name)?.bindingId ??
          null,
        propertyPath: source.path === null ? null : [...source.path, ...path],
      },
      state,
      output,
    );
  };
  visit(node.id, []);
};

interface AddObjectOperationInput {
  readonly node: t.Node;
  readonly kind: JavaScriptSemanticObjectOperation["kind"];
  readonly ownerCallableId: string | null;
  readonly objectBindingId: string | null;
  readonly targetBindingId: string | null;
  readonly propertyPath: readonly string[] | null;
}

const addObjectOperation = (
  input: AddObjectOperationInput,
  state: JavaScriptSemanticAnalysisState,
  output: JavaScriptSemanticObjectOperation[],
): void => {
  output.push({
    objectOperationId: `object:${input.kind}:${String(input.node.start ?? -1)}:${String(input.node.end ?? -1)}`,
    kind: input.kind,
    location: range(input.node),
    ownerCallableId: input.ownerCallableId,
    objectBindingId: input.objectBindingId,
    targetBindingId: input.targetBindingId,
    propertyPath: input.propertyPath,
    resolution:
      input.objectBindingId === null ||
      input.propertyPath === null ||
      (input.kind === "destructure" && input.targetBindingId === null)
        ? "partial"
        : "complete",
  });
};

interface ObjectIdentity {
  readonly bindingId: string | null;
  readonly path: readonly string[] | null;
}

const expressionObjectIdentity = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): ObjectIdentity => {
  const path: string[] = [];
  let current = node;
  let staticPath = true;
  while (current !== null && current !== undefined) {
    current = unwrapJavaScriptExpression(current).node;
    if (
      t.isMemberExpression(current) ||
      t.isOptionalMemberExpression(current)
    ) {
      const name = semanticStaticPropertyKey(
        current.property,
        current.computed,
      );
      if (name === null) staticPath = false;
      else path.push(name);
      current = current.object;
    } else break;
  }
  return {
    bindingId: t.isIdentifier(current)
      ? (resolveSemanticBindingState(state, current, current.name)?.bindingId ??
        null)
      : null,
    path: staticPath ? path.reverse() : null,
  };
};

const bindingIdentifier = (node: t.Node): t.Identifier | null => {
  if (t.isIdentifier(node)) return node;
  if (t.isAssignmentPattern(node) && t.isIdentifier(node.left))
    return node.left;
  return null;
};
