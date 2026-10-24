import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
  javaScriptClassField,
  javaScriptUnaryAlwaysThrows,
} from "./javascriptAstValues.js";

import { childNodes } from "./javascriptSemanticTraversal.js";

const preserveGrouping = { stopAtParentheses: true } as const;

/** One lexical activation and the evaluation point it contributes to a read. */
export interface SemanticExecutionFrame {
  readonly owner: t.Node;
  readonly point: t.Node;
}

/** Compare initialization only in the nearest shared, proven activation. */
export const semanticInitializerPrecedesRead = ({
  initializer,
  read,
  bindingNode,
  parents,
  initializerContexts,
  readContexts,
  readFailureCanRecover,
}: {
  readonly initializer: t.Node;
  readonly read: t.Node;
  readonly bindingNode?: t.Node;
  readonly parents: WeakMap<t.Node, t.Node>;
  readonly initializerContexts: readonly SemanticExecutionFrame[];
  readonly readContexts: readonly SemanticExecutionFrame[];
  /** An invalid earlier activation may throw and recover before a valid one. */
  readonly readFailureCanRecover?: (
    initializer: SemanticExecutionFrame,
    read: SemanticExecutionFrame,
  ) => boolean;
}): boolean | undefined => {
  // No compatible activation is unreachable, not an unknown source order.
  if (readContexts.length === 0) return false;
  let current: t.Node | undefined = initializer;
  while (
    current !== undefined &&
    !t.isFunction(current) &&
    !t.isProgram(current)
  ) {
    if (t.isSwitchCase(current)) {
      let ancestor: t.Node | undefined = read;
      while (ancestor !== undefined && ancestor !== current)
        ancestor = parents.get(ancestor);
      if (ancestor === undefined) return false;
    }
    current = parents.get(current);
  }
  // A lexical iteration head is uninitialized throughout iterable evaluation.
  // Source order alone would incorrectly place its bare declarator before RHS.
  if (t.isVariableDeclarator(initializer)) {
    const declaration = parents.get(initializer);
    const loop =
      declaration === undefined ? undefined : parents.get(declaration);
    if (
      (t.isForOfStatement(loop) || t.isForInStatement(loop)) &&
      loop.left === declaration
    ) {
      let ancestor: t.Node | undefined = read;
      while (ancestor !== undefined && ancestor !== loop) {
        if (ancestor === loop.right) return false;
        ancestor = parents.get(ancestor);
      }
    }
  }
  const shared = readContexts.find(({ owner }) =>
    initializerContexts.some((frame) => frame.owner === owner),
  );
  if (shared === undefined) return undefined;
  const patternOrder =
    bindingNode === undefined
      ? undefined
      : semanticPatternInitializationPrecedesRead(bindingNode, read, parents);
  if (patternOrder !== undefined) return patternOrder;
  const before = initializerContexts.filter(
    (frame) => frame.owner === shared.owner,
  );
  const after = readContexts.filter((frame) => frame.owner === shared.owner);
  const precedes = (
    initialization: SemanticExecutionFrame,
    activation: SemanticExecutionFrame,
  ): boolean =>
    (initialization.point.end ?? Infinity) < (activation.point.start ?? -1);
  if (
    after.every((activation) =>
      before.every((initialization) => precedes(initialization, activation)),
    )
  )
    return true;
  // Initialization validity remains universal by default. A caller that owns
  // failed-read recovery can retain a distinct later successful activation;
  // merely finding one later source position is not sufficient.
  return (
    readFailureCanRecover !== undefined &&
    after.some((activation) =>
      before.every((initialization) => precedes(initialization, activation)),
    ) &&
    after.every((activation) =>
      before.every(
        (initialization) =>
          precedes(initialization, activation) ||
          readFailureCanRecover(initialization, activation),
      ),
    )
  );
};

/** Order a binding event against evaluation in the same declaration pattern. */
export const semanticPatternInitializationPrecedesRead = (
  binding: t.Node,
  read: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean | undefined => {
  if (!t.isIdentifier(binding) || t.isVariableDeclarator(parents.get(binding)))
    return undefined;
  const path = new Map<t.Node, t.Node>();
  let child: t.Node = binding;
  let declarator: t.VariableDeclarator | undefined;
  for (;;) {
    const parent = parents.get(child);
    if (parent === undefined || t.isFunction(parent) || t.isProgram(parent))
      break;
    path.set(parent, child);
    if (t.isVariableDeclarator(parent)) {
      if (parent.id !== child) return undefined;
      declarator = parent;
      break;
    }
    child = parent;
  }
  if (declarator === undefined) return undefined;
  child = read;
  for (;;) {
    const parent = parents.get(child);
    if (parent === undefined) return undefined;
    const boundChild = path.get(parent);
    if (boundChild !== undefined) {
      const siblings: readonly (t.Node | null)[] | undefined =
        t.isObjectPattern(parent)
          ? parent.properties
          : t.isArrayPattern(parent)
            ? parent.elements
            : undefined;
      if (siblings !== undefined) {
        const before = siblings.indexOf(boundChild);
        const after = siblings.indexOf(child);
        return before >= 0 && after >= 0 ? before < after : undefined;
      }
      // RHS, computed key and a selected default all precede their own binding.
      if (
        t.isVariableDeclarator(parent) ||
        t.isAssignmentPattern(parent) ||
        t.isObjectProperty(parent)
      )
        return false;
      return undefined;
    }
    child = parent;
  }
};

/** Whether call arguments or an optional member key may be short-circuited. */
export const javaScriptOptionalOperandsMayBeSkipped = (
  node:
    | t.CallExpression
    | t.OptionalCallExpression
    | t.OptionalMemberExpression,
): boolean =>
  ((t.isOptionalCallExpression(node) || t.isOptionalMemberExpression(node)) &&
    optionalOperationMaySkip(node)) ||
  optionalChainMayShortCircuit(
    t.isOptionalMemberExpression(node) ? node.object : node.callee,
  );

/** A definitely nullish link skips the rest of its ungrouped optional chain. */
export const javaScriptOptionalOperandsAlwaysSkipped = (
  node:
    | t.CallExpression
    | t.OptionalCallExpression
    | t.OptionalMemberExpression,
): boolean => {
  const skips = (
    link: t.OptionalCallExpression | t.OptionalMemberExpression,
  ) => {
    if (!link.optional) return false;
    const receiver = unwrapJavaScriptExpression(
      t.isOptionalCallExpression(link) ? link.callee : link.object,
    ).node;
    return (
      t.isNullLiteral(receiver) ||
      t.isUnaryExpression(receiver, { operator: "void" })
    );
  };
  return (
    ((t.isOptionalCallExpression(node) || t.isOptionalMemberExpression(node)) &&
      skips(node)) ||
    optionalChainMayShortCircuit(
      t.isOptionalMemberExpression(node) ? node.object : node.callee,
      skips,
    )
  );
};

/** Normal completion of these syntax forms cannot produce a nullish receiver. */
const optionalOperationMaySkip = (
  node: t.OptionalCallExpression | t.OptionalMemberExpression,
): boolean => {
  if (!node.optional) return false;
  const receiver = unwrapJavaScriptExpression(
    t.isOptionalCallExpression(node) ? node.callee : node.object,
  ).node;
  if (javaScriptUnaryAlwaysThrows(receiver)) return true;
  const literal = readExactJavaScriptLiteral(receiver);
  return (
    !(literal.found && literal.value !== null) &&
    !t.isObjectExpression(receiver) &&
    !t.isArrayExpression(receiver) &&
    !t.isFunctionExpression(receiver) &&
    !t.isArrowFunctionExpression(receiver) &&
    !t.isClassExpression(receiver) &&
    !t.isRegExpLiteral(receiver) &&
    !t.isBigIntLiteral(receiver) &&
    !(
      t.isUnaryExpression(receiver) &&
      ["+", "-", "~", "!", "typeof", "delete"].includes(receiver.operator)
    ) &&
    !t.isNewExpression(receiver)
  );
};

export type JavaScriptSemanticIterationCardinality =
  | "empty"
  | "nonempty"
  | "unknown";

/** Whether a method's computed key executes in the enclosing environment. */
export const semanticComputedMethodKey = (
  parent: t.Node | undefined,
  child: t.Node,
): boolean =>
  (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
  parent.computed &&
  parent.key === child;

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
  javaScriptClassField(parent) && !parent.static && parent.value === child;

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
      javaScriptOptionalOperandsMayBeSkipped(parent)
    );
  if (t.isOptionalMemberExpression(parent))
    return (
      parent.computed &&
      child === parent.property &&
      javaScriptOptionalOperandsMayBeSkipped(parent)
    );
  return false;
};

const optionalChainMayShortCircuit = (
  expression: t.Node,
  skips = optionalOperationMaySkip,
): boolean => {
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
      if (skips(current)) return true;
      current = current.object;
    } else if (t.isMemberExpression(current)) current = current.object;
    else if (t.isOptionalCallExpression(current)) {
      if (skips(current)) return true;
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
