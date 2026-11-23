import * as t from "@babel/types";

import {
  isPrimitiveJavaScriptExpression,
  javaScriptDefinitionExpression,
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

import { javaScriptExecutions } from "./javascriptSemanticExecutionPoints.js";
import { childNodes } from "./javascriptSemanticTraversal.js";

/** A synchronous local body with no writes, escaping throws, or observable
 * execution can only expose its inputs through its separately resolved result. */
export const createSemanticInertCallQuery = (
  localRead: (identifier: t.Identifier) => boolean,
  primitive: (node: t.Node) => boolean,
) => {
  const cache = new WeakMap<t.Function, boolean>();
  return (fn: t.Node | undefined): boolean => {
    if (
      !t.isFunction(fn) ||
      fn.async ||
      fn.generator ||
      !fn.params.every((p) => t.isIdentifier(p))
    )
      return false;
    const cached = cache.get(fn);
    if (cached !== undefined) return cached;
    const pending: { node: t.Node; parent: t.Node }[] = [
      { node: fn.body, parent: fn },
    ];
    while (pending.length > 0) {
      const { node, parent } = pending.pop()!;
      if (
        t.isAssignmentExpression(node) ||
        t.isUpdateExpression(node) ||
        t.isThrowStatement(node) ||
        (t.isIdentifier(node) &&
          t.isReferenced(node, parent) &&
          !localRead(node)) ||
        (t.isBinaryExpression(node) &&
          (node.operator === "in" || node.operator === "instanceof")) ||
        javaScriptExecutions(node, parent).some(
          (effect) =>
            effect.kind !== "coercion" || !effect.operands.every(primitive),
        )
      ) {
        cache.set(fn, false);
        return false;
      }
      for (const child of childNodes(node))
        if (
          !t.isFunction(node) ||
          semanticMethodDefinitionExpression(node, child)
        )
          pending.push({ node: child, parent: node });
    }
    cache.set(fn, true);
    return true;
  };
};

/** Effectful inputs still evaluated when an expression returns a scalar. */
export const javaScriptScalarEvaluationSources = (
  expression: t.Node,
  bodiesAt: (
    node:
      | t.MemberExpression
      | t.OptionalMemberExpression
      | t.CallExpression
      | t.OptionalCallExpression,
  ) => readonly t.Node[] | undefined,
  ordinaryReceiver: (node: t.Node) => boolean,
): readonly t.Node[] => {
  const sources: t.Node[] = [];
  const pending = [expression];
  const seen = new WeakSet<t.Node>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (t.isUnaryExpression(node, { operator: "delete" })) {
      const target = unwrapJavaScriptExpression(node.argument).node;
      if (
        t.isMemberExpression(target) ||
        t.isOptionalMemberExpression(target)
      ) {
        pending.push(target.object);
        if (!ordinaryReceiver(target.object)) sources.push(target.object);
        if (target.computed) sources.push(target.property);
        continue;
      }
    }
    if (node === expression) {
      pending.push(...childNodes(node));
      continue;
    }
    if (t.isObjectMethod(node)) {
      if (node.computed) sources.push(node.key);
      continue;
    }
    if (t.isFunction(node)) continue;
    if (t.isObjectProperty(node) && node.computed) sources.push(node.key);
    if (
      t.isMemberExpression(node) ||
      t.isOptionalMemberExpression(node) ||
      t.isCallExpression(node) ||
      t.isOptionalCallExpression(node)
    ) {
      const bodies = bodiesAt(node);
      if (bodies !== undefined) {
        // A selected value is discarded. Evaluate the authored inputs and
        // any known local getter or call body, including recursive calls once.
        pending.push(...childNodes(node), ...bodies);
        continue;
      }
      sources.push(node);
      if (
        (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
        node.computed
      )
        sources.push(node.property);
      continue;
    }
    if (t.isAssignmentExpression(node) && t.isMemberExpression(node.left)) {
      sources.push(node.left.object, node.right);
      if (node.left.computed) sources.push(node.left.property);
    }
    if (
      t.isNewExpression(node) ||
      t.isAwaitExpression(node) ||
      t.isYieldExpression(node) ||
      t.isClass(node) ||
      t.isTaggedTemplateExpression(node) ||
      t.isSpreadElement(node) ||
      t.isUpdateExpression(node) ||
      (t.isAssignmentExpression(node) &&
        !["=", "||=", "&&=", "??="].includes(node.operator)) ||
      ((t.isBinaryExpression(node) ||
        t.isUnaryExpression(node) ||
        t.isTemplateLiteral(node)) &&
        !isPrimitiveJavaScriptExpression(node))
    ) {
      sources.push(node);
      continue;
    }
    pending.push(...childNodes(node));
  }
  return sources;
};

const preserveGrouping = { stopAtParentheses: true } as const;

export type JavaScriptSemanticIterationCardinality =
  | "empty"
  | "nonempty"
  | "unknown";

/** Whether a method child executes in the enclosing environment. */
export const semanticMethodDefinitionExpression = (
  parent: t.Node | undefined,
  child: t.Node,
): boolean =>
  (t.isObjectMethod(parent) ||
    t.isClassMethod(parent) ||
    t.isClassPrivateMethod(parent)) &&
  javaScriptDefinitionExpression(parent, child);

/** Exact source-only cardinality for literal loop heads. */
export const semanticIterationCardinality = (
  loop: t.ForInStatement | t.ForOfStatement,
  prototypeMayAffectEnumeration: boolean | undefined,
): JavaScriptSemanticIterationCardinality => {
  const iterable = unwrapJavaScriptExpression(loop.right).node;
  const literal = readExactJavaScriptLiteral(iterable);
  if (t.isForOfStatement(loop)) {
    if (prototypeMayAffectEnumeration !== false) return "unknown";
    if (t.isArrayExpression(iterable)) {
      if (iterable.elements.length === 0) return "empty";
      if (
        iterable.elements.some(
          (element) => element === null || !t.isSpreadElement(element),
        )
      )
        return "nonempty";
      return "unknown";
    }
    if (literal.found && typeof literal.value === "string")
      return literal.value.length === 0 ? "empty" : "nonempty";
    return "unknown";
  }
  if (t.isObjectExpression(iterable)) {
    let prototype: t.Node | undefined;
    for (const property of iterable.properties) {
      if (t.isSpreadElement(property)) return "unknown";
      const key = semanticStaticPropertyKey(property.key, property.computed);
      if (
        t.isObjectProperty(property) &&
        !property.computed &&
        !property.shorthand &&
        key === "__proto__"
      ) {
        prototype = unwrapJavaScriptExpression(property.value).node;
        continue;
      }
      if (key === null) return "unknown";
      return "nonempty";
    }
    if (t.isNullLiteral(prototype)) return "empty";
    if (prototype !== undefined && !readExactJavaScriptLiteral(prototype).found)
      return "unknown";
    return prototypeMayAffectEnumeration === false ? "empty" : "unknown";
  }
  if (literal.found && literal.value === null) return "empty";
  if (
    literal.found &&
    typeof literal.value === "string" &&
    literal.value.length > 0
  )
    return "nonempty";
  if (literal.found)
    return prototypeMayAffectEnumeration === false ? "empty" : "unknown";
  return "unknown";
};

/** Instance values run on construction; their computed keys run at definition. */
export const delayedInstanceFieldValue = (
  parent: t.Node | undefined,
  child: t.Node | undefined,
): boolean =>
  (t.isClassProperty(parent) ||
    t.isClassPrivateProperty(parent) ||
    t.isClassAccessorProperty(parent)) &&
  !parent.static &&
  parent.value === child;

/** Shared branch facts for binding writes and their possible execution positions. */
export const semanticBranchMayBeSkipped = (
  parent: t.Node,
  child: t.Node,
): boolean => {
  if (delayedInstanceFieldValue(parent, child)) return true;
  if (t.isIfStatement(parent))
    return child === parent.consequent || child === parent.alternate;
  if (t.isSwitchCase(parent)) return true;
  if (t.isTryStatement(parent))
    return child === parent.block || child === parent.handler;
  if (t.isForStatement(parent))
    return child === parent.body || child === parent.update;
  if (t.isWhileStatement(parent)) return child === parent.body;
  if (t.isDoWhileStatement(parent)) return child === parent.test;
  if (t.isForInStatement(parent) || t.isForOfStatement(parent))
    return child === parent.left || child === parent.body;
  if (t.isLogicalExpression(parent)) return child === parent.right;
  if (t.isAssignmentPattern(parent)) return child === parent.right;
  if (t.isAssignmentExpression(parent))
    return (
      ["&&=", "||=", "??="].includes(parent.operator) && child === parent.right
    );
  if (t.isConditionalExpression(parent))
    return child === parent.consequent || child === parent.alternate;
  if (t.isOptionalCallExpression(parent) || t.isCallExpression(parent))
    return (
      parent.arguments.includes(child as t.Expression) &&
      ((t.isOptionalCallExpression(parent) && parent.optional) ||
        optionalChainMayShortCircuit(parent.callee))
    );
  if (t.isOptionalMemberExpression(parent))
    return (
      parent.computed &&
      child === parent.property &&
      (parent.optional || optionalChainMayShortCircuit(parent.object))
    );
  return false;
};

const optionalChainMayShortCircuit = (expression: t.Node): boolean => {
  let current = expression;
  while (true) {
    // Parentheses terminate optional-chain short-circuiting. In particular,
    // `(foo?.bar)(arg)` evaluates arg before attempting the call.
    if (current.extra?.parenthesized === true) return false;
    const unwrapped = unwrapJavaScriptExpression(
      current,
      preserveGrouping,
    ).node;
    if (unwrapped !== current) {
      current = unwrapped;
      continue;
    }
    if (t.isOptionalMemberExpression(current)) {
      if (current.optional) return true;
      current = current.object;
    } else if (t.isMemberExpression(current)) current = current.object;
    else if (t.isOptionalCallExpression(current)) {
      if (current.optional) return true;
      current = current.callee;
    } else if (t.isCallExpression(current)) current = current.callee;
    else return false;
  }
};

interface AbruptCompletionSummary {
  readonly breaks: ReadonlySet<string | null>;
  readonly continues: ReadonlySet<string | null>;
}
const emptyAbruptLabels: ReadonlySet<string | null> = new Set();
const emptyAbruptSummary: AbruptCompletionSummary = {
  breaks: emptyAbruptLabels,
  continues: emptyAbruptLabels,
};
const abruptSummaries = new WeakMap<t.Node, AbruptCompletionSummary>();
const abruptPrefixes = new WeakMap<
  t.BlockStatement | t.Program,
  ReadonlySet<t.Node>
>();

/** Loop and label exits crossing a statement boundary, excluding nested callables. */
const abruptSummary = (root: t.Node): AbruptCompletionSummary => {
  const pending: { node: t.Node; visited: boolean }[] = [
    { node: root, visited: false },
  ];
  while (pending.length > 0) {
    const { node, visited } = pending.pop()!;
    if (abruptSummaries.has(node)) continue;
    const children =
      t.isFunction(node) || t.isClass(node)
        ? []
        : childNodes(node).filter(
            (child) =>
              t.isStatement(child) ||
              t.isSwitchCase(child) ||
              t.isCatchClause(child),
          );
    if (!visited) {
      pending.push({ node, visited: true });
      for (const child of children)
        if (!abruptSummaries.has(child))
          pending.push({ node: child, visited: false });
      continue;
    }
    let breaks: Set<string | null> | undefined,
      continues: Set<string | null> | undefined;
    if (t.isBreakStatement(node))
      (breaks ??= new Set()).add(node.label?.name ?? null);
    if (t.isContinueStatement(node))
      (continues ??= new Set()).add(node.label?.name ?? null);
    for (const child of children) {
      const summary = abruptSummaries.get(child)!;
      for (const label of summary.breaks) (breaks ??= new Set()).add(label);
      for (const label of summary.continues)
        (continues ??= new Set()).add(label);
    }
    if (t.isLoop(node) || t.isSwitchStatement(node)) breaks?.delete(null);
    if (t.isLoop(node)) continues?.delete(null);
    if (t.isLabeledStatement(node)) {
      breaks?.delete(node.label.name);
      continues?.delete(node.label.name);
    }
    abruptSummaries.set(
      node,
      (breaks?.size ?? 0) > 0 || (continues?.size ?? 0) > 0
        ? {
            breaks: breaks ?? emptyAbruptLabels,
            continues: continues ?? emptyAbruptLabels,
          }
        : emptyAbruptSummary,
    );
  }
  return abruptSummaries.get(root)!;
};

/** An earlier sibling may leave this body before reaching the selected statement. */
export const semanticPriorStatementMayExit = (
  parent: t.Node,
  child: t.Node,
): boolean => {
  if (!t.isBlockStatement(parent) && !t.isProgram(parent)) return false;
  let skipped = abruptPrefixes.get(parent);
  if (skipped === undefined) {
    const prefixes = new Set<t.Node>();
    let exits = false;
    for (const statement of parent.body) {
      if (exits) prefixes.add(statement);
      const summary = abruptSummary(statement);
      exits ||= summary.breaks.size > 0 || summary.continues.size > 0;
    }
    skipped = prefixes;
    abruptPrefixes.set(parent, skipped);
  }
  return skipped.has(child);
};
