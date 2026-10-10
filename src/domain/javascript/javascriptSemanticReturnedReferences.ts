import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  resolveLocalCallables,
  type LocalCallableResolution,
} from "./javascriptSemanticCallResolution.js";
import { semanticCallableResultExpressions } from "./javascriptSemanticCallableResults.js";
import {
  semanticArrayIndex,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

/** A reference potentially handed to a caller or generator consumer. */
export interface SemanticReturnedReference {
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
}

interface Candidate {
  readonly node: t.Node;
  readonly path: readonly (string | number | null)[];
  readonly bindings: ReadonlySet<string>;
}

interface ObjectTargetIndex {
  readonly propertyByName: ReadonlyMap<
    string,
    t.ObjectMethod | t.ObjectProperty
  >;
  readonly trailingUnknownsByProperty: ReadonlyMap<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >;
}

interface ObjectTargetUnknown {
  readonly node: t.ObjectMethod | t.ObjectProperty | t.SpreadElement;
  readonly previous: ObjectTargetUnknown | undefined;
}

/** Resolve local result references conservatively, without claiming call execution. */
export const createSemanticReturnedReferences = (
  state: JavaScriptSemanticAnalysisState,
): ((callee: t.Node) => readonly SemanticReturnedReference[]) => {
  const callableById = new Map(
    state.callables.map((callable) => [callable.callableId, callable]),
  );
  const bindingCache = new Map<string, LocalCallableResolution>();
  const results = new WeakMap<t.Node, readonly SemanticReturnedReference[]>();
  const objectTargets = new WeakMap<t.ObjectExpression, ObjectTargetIndex>();
  return (callee) => {
    const existing = results.get(callee);
    if (existing !== undefined) return existing;
    const functions = new Set<t.Node>();
    const resolution = resolveLocalCallables({
      node: callee,
      state,
      callableById,
      bindingCache,
      seenBindings: new Set(),
    });
    for (const id of resolution.callableIds) {
      const node = state.callableNodesById.get(id);
      if (node !== undefined) functions.add(node);
    }
    const pending: Candidate[] = [
      { node: callee, path: [], bindings: new Set() },
    ];
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const item = pending[cursor];
      if (item === undefined) break;
      const node = unwrapJavaScriptExpression(item.node).node;
      if (t.isIdentifier(node)) {
        const binding = resolveSemanticBindingState(state, node, node.name);
        if (binding === undefined || item.bindings.has(binding.bindingId))
          continue;
        const bindings = new Set([...item.bindings, binding.bindingId]);
        for (const initializer of [
          ...binding.initializers,
          ...binding.referenceInitializers,
        ])
          pending.push({
            node: initializer.node,
            path: [...initializer.projection, ...item.path],
            bindings,
          });
      } else if (
        t.isMemberExpression(node) ||
        t.isOptionalMemberExpression(node)
      ) {
        const path: (string | number | null)[] = [];
        let receiver: t.Node = node;
        while (
          t.isMemberExpression(receiver) ||
          t.isOptionalMemberExpression(receiver)
        ) {
          path.push(
            semanticStaticPropertyKey(receiver.property, receiver.computed),
          );
          receiver = unwrapJavaScriptExpression(receiver.object).node;
        }
        pending.push({
          ...item,
          node: receiver,
          path: [...path.reverse(), ...item.path],
        });
      } else if (
        t.isConditionalExpression(node) ||
        t.isLogicalExpression(node)
      ) {
        pending.push(
          {
            ...item,
            node: t.isConditionalExpression(node) ? node.consequent : node.left,
          },
          {
            ...item,
            node: t.isConditionalExpression(node) ? node.alternate : node.right,
          },
        );
      } else if (t.isSequenceExpression(node)) {
        const last = node.expressions.at(-1);
        if (last !== undefined) pending.push({ ...item, node: last });
      } else if (t.isFunction(node) && item.path.length === 0)
        functions.add(node);
      else if (t.isObjectExpression(node))
        selectObjectTargets(node, item, pending, objectTargets);
      else if (t.isArrayExpression(node)) {
        const [key, ...path] = item.path;
        const index =
          key === undefined || key === null ? null : semanticArrayIndex(key);
        let uncertainOffset = false;
        node.elements.forEach((element, offset) => {
          if (element === null) return;
          if (t.isSpreadElement(element)) {
            uncertainOffset = true;
            pending.push({
              ...item,
              node: element.argument,
              path: [null, ...path],
            });
          } else if (index === null || uncertainOffset || index === offset)
            pending.push({ ...item, node: element, path });
        });
      } else if (t.isNewExpression(node))
        pending.push({ ...item, node: node.callee });
      else if (t.isClass(node)) {
        const [key, ...path] = item.path;
        for (const member of node.body.body) {
          if (t.isClassMethod(member)) {
            if (
              (item.path.length === 0 && member.kind === "constructor") ||
              (key !== undefined &&
                (key === null ||
                  semanticStaticPropertyKey(member.key, member.computed) ===
                    String(key)))
            )
              pending.push({ ...item, node: member, path });
          } else if (
            t.isClassProperty(member) &&
            member.value !== null &&
            member.value !== undefined &&
            key !== undefined &&
            (key === null ||
              semanticStaticPropertyKey(member.key, member.computed) ===
                String(key))
          )
            pending.push({ ...item, node: member.value, path });
        }
        if (node.superClass !== null && node.superClass !== undefined)
          pending.push({ ...item, node: node.superClass });
      }
    }
    const output = [...functions].flatMap((node) => {
      const callables = t.isClass(node)
        ? node.body.body.filter(
            (member) =>
              t.isClassMethod(member) && member.kind === "constructor",
          )
        : [node];
      return callables.flatMap((callable) =>
        semanticCallableResultExpressions(callable).flatMap(
          ({ node, delegated }) =>
            node === null
              ? []
              : [{ node, projection: delegated ? [null] : [] }],
        ),
      );
    });
    results.set(callee, output);
    return output;
  };
};

const selectObjectTargets = (
  node: t.ObjectExpression,
  item: Candidate,
  pending: Candidate[],
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
): void => {
  const [key, ...path] = item.path;
  if (key !== null && key !== undefined) {
    const index = objectTargetIndex(node, indexes);
    const property = index.propertyByName.get(String(key));
    if (property !== undefined) {
      const unknowns: ObjectTargetUnknown[] = [];
      for (
        let unknown = index.trailingUnknownsByProperty.get(property);
        unknown !== undefined;
        unknown = unknown.previous
      )
        unknowns.push(unknown);
      for (const { node: unknown } of unknowns.reverse())
        pending.push({
          ...item,
          node: t.isSpreadElement(unknown)
            ? unknown.argument
            : t.isObjectProperty(unknown)
              ? unknown.value
              : unknown,
          ...(t.isSpreadElement(unknown) ? {} : { path }),
        });
      pending.push({
        ...item,
        node: t.isObjectProperty(property) ? property.value : property,
        path,
      });
      return;
    }
  }
  let replaced = false;
  for (const property of [...node.properties].reverse()) {
    if (replaced) break;
    if (t.isSpreadElement(property)) {
      pending.push({ ...item, node: property.argument });
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (
      key !== null &&
      key !== undefined &&
      name !== null &&
      name !== String(key)
    )
      continue;
    if (t.isObjectProperty(property))
      pending.push({ ...item, node: property.value, path });
    else pending.push({ ...item, node: property, path });
    if (key !== null && key !== undefined && name === String(key))
      replaced = true;
  }
};

const objectTargetIndex = (
  node: t.ObjectExpression,
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
): ObjectTargetIndex => {
  const existing = indexes.get(node);
  if (existing !== undefined) return existing;
  const propertyByName = new Map<string, t.ObjectMethod | t.ObjectProperty>();
  const trailingUnknownsByProperty = new Map<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >();
  let trailingUnknown: ObjectTargetUnknown | undefined;
  for (const property of [...node.properties].reverse()) {
    if (t.isSpreadElement(property)) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name === null) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    if (propertyByName.has(name)) continue;
    propertyByName.set(name, property);
    if (trailingUnknown !== undefined)
      trailingUnknownsByProperty.set(property, trailingUnknown);
  }
  const created = { propertyByName, trailingUnknownsByProperty };
  indexes.set(node, created);
  return created;
};
