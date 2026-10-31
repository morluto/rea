import * as t from "@babel/types";

import {
  delayedInstanceFieldValue,
  semanticComputedMethodKey,
  semanticBranchMayBeSkipped,
  semanticIterationCardinality,
} from "./javascriptSemanticEvaluationOrder.js";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  semanticScopeId,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticEffectTiming,
} from "./javascriptSemanticState.js";

interface StatementPosition {
  readonly body: readonly t.Statement[];
  readonly index: number;
  readonly declaratorIndex: number;
}

interface EffectAncestry {
  readonly position: StatementPosition | null;
  readonly outer: EffectAncestry | null;
}

interface SharedEffectPosition {
  readonly before: StatementPosition;
  readonly after: StatementPosition;
}

interface BindingReadPosition {
  readonly position: StatementPosition | null;
  readonly repeatingLoop: t.Loop | undefined;
  readonly outer?: BindingReadPosition;
}

interface ExpressionSiblings {
  readonly common: t.Node;
  readonly earlier: t.Node;
  readonly later: t.Node;
}

interface ExpressionAncestry {
  readonly source: t.Node;
  readonly ancestors: ReadonlyMap<t.Node, t.Node | undefined>;
  readonly siblings: WeakMap<t.Node, ExpressionSiblings | null>;
}

/**
 * Initializer positions depend only on a node and its parent map, which one
 * analysis builds once and never changes. Different mutations and initializers
 * re-derive the same positions along shared ancestry, so retain the first
 * result for as long as its parent map is reachable.
 */
interface InitializerPositionCache {
  readonly statementIndices: WeakMap<
    readonly t.Statement[],
    ReadonlyMap<t.Statement, number>
  >;
  readonly timelines: WeakMap<
    JavaScriptSemanticBindingState,
    BindingTimelineCache
  >;
  readonly direct: WeakMap<t.Node, StatementPosition | null>;
  readonly mutation: WeakMap<t.Node, StatementPosition | null>;
  readonly reference: WeakMap<t.Node, StatementPosition | null>;
  initializerProjection:
    | {
        readonly body: readonly t.Statement[];
        readonly positions: WeakMap<t.Node, StatementPosition | null>;
      }
    | undefined;
  readonly effect: WeakMap<t.Node, EffectAncestry | null>;
  effectMatches:
    | {
        readonly later: EffectAncestry;
        readonly byBody: ReadonlyMap<readonly t.Statement[], StatementPosition>;
        readonly earlier: WeakMap<EffectAncestry, SharedEffectPosition | null>;
      }
    | undefined;
  readonly read: WeakMap<t.Node, BindingReadPosition>;
  readonly readMatches: WeakMap<
    readonly t.Statement[],
    WeakMap<BindingReadPosition, StatementPosition | null>
  >;
  readonly evaluationChildren: WeakMap<
    t.Node,
    ReadonlyMap<t.Node, number> | null
  >;
  // One source context bounds retained ancestry facts to O(AST), even when
  // an expression contains many distinct writes. Reuse its descendant paths.
  expressionAncestry: ExpressionAncestry | undefined;
  initializerReads:
    | { readonly initializer: t.Node; readonly reads: WeakMap<t.Node, boolean> }
    | undefined;
}

const initializerPositionCaches = new WeakMap<
  WeakMap<t.Node, t.Node>,
  InitializerPositionCache
>();

const initializerPositionCache = (
  parents: WeakMap<t.Node, t.Node>,
): InitializerPositionCache => {
  const cached = initializerPositionCaches.get(parents);
  if (cached !== undefined) return cached;
  const created: InitializerPositionCache = {
    statementIndices: new WeakMap(),
    timelines: new WeakMap(),
    direct: new WeakMap(),
    mutation: new WeakMap(),
    reference: new WeakMap(),
    initializerProjection: undefined,
    effect: new WeakMap(),
    effectMatches: undefined,
    read: new WeakMap(),
    readMatches: new WeakMap(),
    evaluationChildren: new WeakMap(),
    expressionAncestry: undefined,
    initializerReads: undefined,
  };
  initializerPositionCaches.set(parents, created);
  return created;
};

const statementPosition = (
  statement: t.Statement,
  parents: WeakMap<t.Node, t.Node>,
  declarator?: t.VariableDeclarator,
): StatementPosition | null => {
  const directParent = parents.get(statement);
  const enclosing =
    (t.isExportNamedDeclaration(directParent) ||
      t.isExportDefaultDeclaration(directParent)) &&
    directParent.declaration === statement
      ? directParent
      : statement;
  const parent = parents.get(enclosing);
  if (!t.isProgram(parent) && !t.isBlockStatement(parent)) return null;
  const cache = initializerPositionCache(parents).statementIndices;
  let indices = cache.get(parent.body);
  if (indices === undefined) {
    indices = new Map(parent.body.map((node, index) => [node, index]));
    cache.set(parent.body, indices);
  }
  const index = indices.get(enclosing) ?? -1;
  return index < 0
    ? null
    : {
        body: parent.body,
        index,
        declaratorIndex:
          t.isVariableDeclaration(statement) && declarator !== undefined
            ? statement.declarations.indexOf(declarator)
            : -1,
      };
};

const positionPrecedes = (
  left: StatementPosition,
  right: StatementPosition,
): boolean =>
  left.body === right.body &&
  (left.index < right.index ||
    (left.index === right.index &&
      left.declaratorIndex >= 0 &&
      left.declaratorIndex < right.declaratorIndex));

/** Share ancestor tails instead of retaining a copied array per capture. */
const effectAncestry = (
  start: t.Node | undefined,
  parents: WeakMap<t.Node, t.Node>,
): EffectAncestry | null => {
  if (start === undefined) return null;
  const cache = initializerPositionCache(parents).effect;
  const pending: t.Node[] = [];
  let node: t.Node | undefined = start;
  while (node !== undefined && !cache.has(node)) {
    pending.push(node);
    const parent = parents.get(node);
    node = semanticComputedMethodKey(parent, node)
      ? parents.get(parent!)
      : parent;
  }
  let outer = node === undefined ? null : (cache.get(node) ?? null);
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const current = pending[index]!;
    const parent = pending[index + 1] ?? node;
    if (t.isProgram(current)) outer = { position: null, outer: null };
    else if (
      t.isFunction(current) ||
      t.isLoop(current) ||
      delayedInstanceFieldValue(parent, current)
    )
      outer = null;
    else if (outer !== null) {
      const declarator =
        t.isVariableDeclarator(current) && t.isVariableDeclaration(parent);
      const position = declarator
        ? statementPosition(parent, parents, current)
        : t.isStatement(current)
          ? statementPosition(current, parents)
          : null;
      if (position !== null) {
        // A declarator refines its declaration's position, not another level.
        const tail =
          declarator &&
          outer.position?.body === position.body &&
          outer.position.index === position.index
            ? outer.outer
            : outer;
        outer = { position, outer: tail };
      }
    }
    cache.set(current, outer);
  }
  return cache.get(start) ?? null;
};

/** Source order can prove timing only within one top-level activation. */
export const semanticTopLevelEffectIsOrderable = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean => effectAncestry(node, parents) !== null;

/** Order effects only in a non-repeating top-level activation. */
export const semanticTopLevelEffectFollowsCapture = (
  capture: t.Node,
  effect: t.Node | undefined,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  const earlier = effectAncestry(capture, parents);
  const later = effectAncestry(effect, parents);
  if (earlier === null || later === null) return false;
  const cache = initializerPositionCache(parents);
  let matches = cache.effectMatches;
  if (matches?.later !== later) {
    const byBody = new Map<readonly t.Statement[], StatementPosition>();
    for (
      let entry: EffectAncestry | null = later;
      entry !== null;
      entry = entry.outer
    )
      if (entry.position !== null && !byBody.has(entry.position.body))
        byBody.set(entry.position.body, entry.position);
    matches = { later, byBody, earlier: new WeakMap() };
    cache.effectMatches = matches;
  }
  const pending: EffectAncestry[] = [];
  let shared: SharedEffectPosition | null = null;
  for (
    let entry: EffectAncestry | null = earlier;
    entry !== null;
    entry = entry.outer
  ) {
    if (matches.earlier.has(entry)) {
      shared = matches.earlier.get(entry) ?? null;
      break;
    }
    pending.push(entry);
    const before = entry.position;
    const after = before === null ? undefined : matches.byBody.get(before.body);
    if (before !== null && after !== undefined) {
      shared = { before, after };
      break;
    }
  }
  // Retain only the current effect's matching context, bounding pair storage.
  for (const entry of pending) matches.earlier.set(entry, shared);
  if (shared === null) return false;
  const { before, after } = shared;
  if (positionPrecedes(before, after)) return true;
  if (
    before.body !== after.body ||
    before.index !== after.index ||
    before.declaratorIndex !== after.declaratorIndex
  )
    return false;
  return expressionEvaluationOrder(capture, effect, parents) === "before";
};

const scopeExitMarkers = new WeakMap<t.Node, t.EmptyStatement>();
const scopeExitOwners = new WeakMap<t.Node, t.Node>();

/** A derived scope-end effect keeps disposal separate from initializer evaluation. */
export const semanticScopeExitEffect = (scope: t.Node): t.Node => {
  const cached = scopeExitMarkers.get(scope);
  if (cached !== undefined) return cached;
  const marker = t.emptyStatement();
  if (scope.end !== undefined) {
    marker.start = scope.end;
    marker.end = scope.end;
  }
  if (scope.loc != null)
    marker.loc = { ...scope.loc, start: scope.loc.end, end: scope.loc.end };
  scopeExitMarkers.set(scope, marker);
  scopeExitOwners.set(marker, scope);
  return marker;
};

const withinScopeExit = (
  reference: t.Node,
  scope: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  for (
    let node: t.Node | undefined = reference;
    node !== undefined;
    node = parents.get(node)
  ) {
    if (node === scope) {
      for (
        let owner = parents.get(scope);
        owner !== undefined;
        owner = parents.get(owner)
      ) {
        if (t.isLoop(owner)) return false;
        if (t.isFunction(owner)) break;
      }
      return !t.isLoop(scope);
    }
    if (t.isFunction(node) || t.isLoop(node)) return false;
  }
  return false;
};

/** Include expression order when a write operation contains the read site. */
export const semanticEffectFollowsReference = (
  reference: t.Node,
  effect: t.Node | undefined,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  if (reference === effect) return false;
  const exit = effect === undefined ? undefined : scopeExitOwners.get(effect);
  if (exit !== undefined) {
    if (withinScopeExit(reference, exit, parents)) return true;
    effect = exit;
  }
  let current: t.Node | undefined = reference;
  let child: t.Node | undefined;
  while (current !== undefined && current !== effect) {
    if (t.isFunction(current)) break;
    child = current;
    current = parents.get(current);
  }
  const loopInput =
    (t.isForInStatement(effect) || t.isForOfStatement(effect)) &&
    child === effect.right;
  let once = current;
  child = undefined;
  while (once !== undefined) {
    const initialLoopInput =
      (t.isForStatement(once) && child === once.init) ||
      ((t.isForInStatement(once) || t.isForOfStatement(once)) &&
        child === once.right) ||
      (once === effect && loopInput);
    if (
      t.isFunction(once) ||
      (t.isLoop(once) && !initialLoopInput) ||
      delayedInstanceFieldValue(once, child)
    )
      break;
    child = once;
    once = parents.get(once);
  }
  return (
    (current === effect &&
      once === undefined &&
      (t.isAssignmentExpression(effect) ||
        t.isUpdateExpression(effect) ||
        t.isVariableDeclarator(effect) ||
        t.isCallExpression(effect) ||
        t.isOptionalCallExpression(effect) ||
        t.isNewExpression(effect))) ||
    (current === effect && once === undefined && loopInput) ||
    semanticTopLevelEffectFollowsCapture(reference, effect, parents)
  );
};

export const semanticEffectTiming = (
  site: t.Node,
  effect: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticEffectTiming => {
  if (effect === undefined) return "unknown";
  const exit = scopeExitOwners.get(effect);
  if (exit !== undefined) {
    if (withinScopeExit(site, exit, state.parentsByNode)) return "after";
    effect = exit;
  }
  // Invocation receives arguments after their values have been selected.
  if (
    site === effect &&
    (t.isCallExpression(site) ||
      t.isOptionalCallExpression(site) ||
      t.isNewExpression(site))
  )
    return "after";
  const loop = semanticEnclosingIteration(effect, state);
  if (loop !== undefined) {
    const cardinality = semanticIterationCardinality(
      loop,
      state.prototypeEnumerationMayAffect,
    );
    if (cardinality === "empty") return "after";
    if (cardinality === "nonempty") {
      const loopParent = state.parentsByNode.get(loop);
      const crossesFunction = (node: t.Node): boolean => {
        let current: t.Node | undefined = node;
        while (current !== undefined) {
          if (t.isFunction(current)) return true;
          current = state.parentsByNode.get(current);
        }
        return false;
      };
      if (
        loopParent === state.program &&
        !crossesFunction(site) &&
        typeof loop.start === "number" &&
        typeof loop.end === "number" &&
        typeof site.start === "number"
      ) {
        if (site.start > loop.end) return "before";
        if (site.start < loop.start) return "after";
      }
    }
  }
  if (semanticEffectFollowsReference(site, effect, state.parentsByNode))
    return "after";
  if (semanticEffectFollowsReference(effect, site, state.parentsByNode))
    return "before";
  return "unknown";
};

const semanticEnclosingIteration = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.ForInStatement | t.ForOfStatement | undefined => {
  let current: t.Node | undefined = node;
  while (current !== undefined) {
    if (t.isForInStatement(current) || t.isForOfStatement(current))
      return current;
    if (t.isFunction(current)) return undefined;
    current = state.parentsByNode.get(current);
  }
  return undefined;
};

/** Memoize descendant paths toward the currently compared source expression. */
const expressionSiblings = (
  earlier: t.Node,
  later: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): ExpressionSiblings | null => {
  const cache = initializerPositionCache(parents);
  let context = cache.expressionAncestry;
  if (context?.source !== earlier) {
    const ancestors = new Map<t.Node, t.Node | undefined>();
    let child: t.Node | undefined;
    for (
      let node: t.Node | undefined = earlier;
      node !== undefined;
      node = parents.get(node)
    ) {
      ancestors.set(node, child);
      child = node;
    }
    context = { source: earlier, ancestors, siblings: new WeakMap() };
    cache.expressionAncestry = context;
  }
  const path: t.Node[] = [];
  let result: ExpressionSiblings | null = null;
  for (
    let node: t.Node | undefined = later;
    node !== undefined;
    node = parents.get(node)
  ) {
    if (context.ancestors.has(node)) {
      const sourceChild = context.ancestors.get(node);
      const readChild = path.at(-1);
      if (sourceChild !== undefined && readChild !== undefined)
        result = { common: node, earlier: sourceChild, later: readChild };
      break;
    }
    const cached = context.siblings.get(node);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    path.push(node);
  }
  for (const node of path) context.siblings.set(node, result);
  return result;
};

/** Index existing child arrays once; wide literals/calls need no repeated copies. */
const expressionChildIndices = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): ReadonlyMap<t.Node, number> | null => {
  const cache = initializerPositionCache(parents).evaluationChildren;
  const cached = cache.get(node);
  if (cached !== undefined) return cached;
  const children = ((): readonly (t.Node | null)[] | null => {
    if (t.isProgram(node) || t.isBlockStatement(node)) return node.body;
    if (t.isSequenceExpression(node)) return node.expressions;
    if (t.isArrayExpression(node)) return node.elements;
    if (t.isObjectExpression(node)) return node.properties;
    if (t.isObjectProperty(node))
      return node.computed ? [node.key, node.value] : [node.value];
    if (
      t.isCallExpression(node) ||
      t.isOptionalCallExpression(node) ||
      t.isNewExpression(node)
    )
      return node.arguments;
    if (t.isBinaryExpression(node) || t.isLogicalExpression(node))
      return [node.left, node.right];
    if (t.isConditionalExpression(node)) return [node.test];
    return null;
  })();
  if (children === null) {
    cache.set(node, null);
    return null;
  }
  const indices = new Map<t.Node, number>();
  let index = 0;
  if (
    t.isCallExpression(node) ||
    t.isOptionalCallExpression(node) ||
    t.isNewExpression(node)
  )
    indices.set(node.callee, index++);
  for (const child of children) {
    if (child !== null) indices.set(child, index);
    index++;
  }
  cache.set(node, indices);
  return indices;
};

/** Unproved ordering stays distinct from proof that a write follows the read. */
const expressionEvaluationOrder = (
  earlier: t.Node,
  later: t.Node | undefined,
  parents: WeakMap<t.Node, t.Node>,
): "before" | "after" | "unresolved" => {
  if (later === undefined) return "unresolved";
  const siblings = expressionSiblings(earlier, later, parents);
  if (siblings === null) return "unresolved";
  const children = expressionChildIndices(siblings.common, parents);
  const earlierIndex = children?.get(siblings.earlier);
  const laterIndex = children?.get(siblings.later);
  if (
    earlierIndex === undefined ||
    laterIndex === undefined ||
    earlierIndex === laterIndex
  )
    return "unresolved";
  return earlierIndex < laterIndex ? "before" : "after";
};

const computeDirectInitializerPosition = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  if (t.isClassDeclaration(node) && node.id !== null)
    return statementPosition(node, parents);
  if (
    (t.isAssignmentExpression(node) &&
      t.isIdentifier(unwrapJavaScriptExpression(node.left).node)) ||
    t.isUpdateExpression(node)
  )
    return directMutationPosition(node, parents);
  const parent = parents.get(node);
  if (t.isVariableDeclarator(parent) && parent.init === node) {
    const declaration = parents.get(parent);
    return t.isVariableDeclaration(declaration)
      ? statementPosition(declaration, parents, parent)
      : null;
  }
  if (
    t.isAssignmentExpression(parent) &&
    parent.right === node &&
    t.isIdentifier(parent.left)
  ) {
    return directMutationPosition(parent, parents);
  }
  return null;
};

const directInitializerPosition = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  const cache = initializerPositionCache(parents);
  const cached = cache.direct.get(node);
  if (cached !== undefined) return cached;
  const computed = computeDirectInitializerPosition(node, parents);
  cache.direct.set(node, computed);
  return computed;
};

const computeDirectMutationPosition = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  if (t.isForOfStatement(node)) return statementPosition(node, parents);
  if (t.isVariableDeclarator(node)) {
    const declaration = parents.get(node);
    return t.isVariableDeclaration(declaration)
      ? statementPosition(declaration, parents, node)
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
  let current: t.Node = node;
  while (true) {
    const parent = parents.get(current);
    if (
      parent === undefined ||
      t.isFunction(parent) ||
      semanticBranchMayBeSkipped(parent, current)
    )
      return null;
    if (t.isStatement(parent)) return statementPosition(parent, parents);
    if (t.isVariableDeclarator(parent)) {
      const declaration = parents.get(parent);
      return t.isVariableDeclaration(declaration)
        ? statementPosition(declaration, parents, parent)
        : null;
    }
    current = parent;
  }
};

const directMutationPosition = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  const cache = initializerPositionCache(parents);
  const cached = cache.mutation.get(node);
  if (cached !== undefined) return cached;
  const computed = computeDirectMutationPosition(node, parents);
  cache.mutation.set(node, computed);
  return computed;
};

/** Prove that an unconditional member replacement precedes this read. */
export const semanticDefiniteEffectPrecedesReference = (
  effect: t.Node,
  reference: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  const before = directMutationPosition(effect, parents);
  const after = bindingReadPosition(reference, parents);
  if (before === null || after.position === null || after.repeatingLoop)
    return false;
  if (positionPrecedes(before, after.position)) return true;
  return (
    before.body === after.position.body &&
    before.index === after.position.index &&
    before.declaratorIndex === after.position.declaratorIndex &&
    expressionEvaluationOrder(effect, reference, parents) === "before"
  );
};

/** Order a selected value before a later effect in this non-repeating body. */
export const semanticReadPrecedesEffectWithinActivation = (
  read: t.Node,
  effect: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  const before = bindingReadPosition(read, parents);
  const after = directMutationPosition(effect, parents);
  if (before.position === null || before.repeatingLoop || after === null)
    return false;
  if (positionPrecedes(before.position, after)) return true;
  return (
    before.position.body === after.body &&
    before.position.index === after.index &&
    before.position.declaratorIndex === after.declaratorIndex &&
    expressionEvaluationOrder(read, effect, parents) === "before"
  );
};

/** Order straight-line source effects in one activation, preserving deferred/repeating unknowns. */
export const semanticEffectTimingWithinActivation = (
  site: t.Node,
  effect: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticEffectTiming => {
  if (effect !== undefined) {
    if (
      semanticDefiniteEffectPrecedesReference(site, effect, state.parentsByNode)
    )
      return "after";
    if (
      semanticDefiniteEffectPrecedesReference(effect, site, state.parentsByNode)
    )
      return "before";
  }
  return semanticEffectTiming(site, effect, state);
};

const computeReferenceInitializerPosition = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  // Defaults live inside the declaration pattern rather than its initializer.
  let current = node;
  while (true) {
    const direct = directInitializerPosition(current, parents);
    if (direct !== null) return direct;
    const parent = parents.get(current);
    if (
      t.isAssignmentExpression(parent, { operator: "=" }) &&
      (t.isObjectPattern(parent.left) || t.isArrayPattern(parent.left))
    )
      return directMutationPosition(parent, parents);
    if (t.isFunction(parent))
      return t.isBlockStatement(parent.body)
        ? { body: parent.body.body, index: -1, declaratorIndex: -1 }
        : null;
    if (
      parent === undefined ||
      t.isStatement(parent) ||
      delayedInstanceFieldValue(parent, current)
    )
      return null;
    if (t.isVariableDeclarator(parent)) {
      const declaration = parents.get(parent);
      return t.isVariableDeclaration(declaration)
        ? statementPosition(declaration, parents, parent)
        : null;
    }
    current = parent;
  }
};

const referenceInitializerPosition = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  const cache = initializerPositionCache(parents);
  const cached = cache.reference.get(node);
  if (cached !== undefined) return cached;
  const computed = computeReferenceInitializerPosition(node, parents);
  cache.reference.set(node, computed);
  return computed;
};

/** Parameter-to-body copies and ordinary expressions share one position owner. */
const initializerPosition = (
  initializer: JavaScriptSemanticBindingState["initializers"][number],
  parents: WeakMap<t.Node, t.Node>,
  reference = false,
): StatementPosition | null => {
  if (initializer.entryBody !== undefined)
    return { body: initializer.entryBody.body, index: -1, declaratorIndex: -1 };
  return reference
    ? referenceInitializerPosition(initializer.node, parents)
    : directInitializerPosition(initializer.node, parents);
};

/** Project nested unconditional blocks into the read's shared statement body. */
const initializerInBody = (
  initializer: JavaScriptSemanticBindingState["initializers"][number],
  parents: WeakMap<t.Node, t.Node>,
  body: readonly t.Statement[] | undefined,
  reference = false,
): StatementPosition | null => {
  const direct = initializerPosition(initializer, parents, reference);
  if (direct === null || body === undefined || direct.body === body)
    return direct;
  const owner = initializerPositionCache(parents);
  if (owner.initializerProjection?.body !== body)
    owner.initializerProjection = { body, positions: new WeakMap() };
  const cache = owner.initializerProjection.positions;
  const pending: t.Node[] = [];
  let current: t.Node | undefined = initializer.node;
  let result: StatementPosition | null = null;
  while (current !== undefined) {
    if (cache.has(current)) {
      result = cache.get(current) ?? null;
      break;
    }
    pending.push(current);
    if (t.isStatement(current)) {
      const position = statementPosition(current, parents);
      if (position?.body === body) {
        result = position;
        break;
      }
    }
    const parent = parents.get(current);
    if (
      parent === undefined ||
      t.isFunction(parent) ||
      t.isLoop(parent) ||
      // A labeled break can skip this write while the later read still runs.
      t.isLabeledStatement(parent) ||
      semanticBranchMayBeSkipped(parent, current)
    )
      break;
    current = parent;
  }
  for (const node of pending) cache.set(node, result);
  return result;
};

/** Resolve origins at their use or capture, never at a later transitive effect. */
export const semanticMutationInitializers = (
  binding: JavaScriptSemanticBindingState,
  mutation: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): Pick<
  JavaScriptSemanticBindingState,
  "initializers" | "referenceInitializers" | "directOrigins"
> => {
  const directPosition =
    directMutationPosition(mutation, parents) ??
    referenceInitializerPosition(mutation, parents);
  if (directPosition === null) return binding;
  const firstInitializer = binding.initializers[0];
  const sourcePosition =
    firstInitializer === undefined
      ? null
      : initializerPosition(firstInitializer, parents);
  const mutationPosition =
    matchingReadPosition(
      bindingReadPosition(mutation, parents),
      sourcePosition?.body,
      parents,
    ) ?? directPosition;
  if (
    binding.initializers.length > 1 &&
    binding.referenceInitializers.length === 0
  ) {
    const first = mutationPosition.body[0];
    const indexed =
      first === undefined ||
      !t.isProgram(parents.get(first)) ||
      bindingReadPosition(mutation, parents).repeatingLoop
        ? undefined
        : readFromTimeline(binding, mutationPosition, mutation, parents);
    if (indexed !== undefined)
      return {
        initializers: indexed.binding.initializers,
        referenceInitializers: indexed.binding.referenceInitializers,
        directOrigins: indexed.hasDefiniteInitializer
          ? []
          : binding.directOrigins,
      };
    const timeline = bindingTimeline(
      binding,
      parents,
      mutationPosition.body,
    ).timeline;
    const latest = timeline?.at(-1);
    if (timeline !== null && latest !== undefined)
      return positionPrecedes(latest.position, mutationPosition)
        ? {
            directOrigins: [],
            initializers: [latest.initializer],
            referenceInitializers: [],
          }
        : binding;
  }
  const origins = [
    ...binding.initializers.map((initializer) => ({
      initializer,
      position: initializerPosition(initializer, parents),
    })),
    ...binding.referenceInitializers.map((initializer) => ({
      initializer,
      position: initializerPosition(initializer, parents, true),
    })),
  ];
  if (
    origins.some(
      ({ position }) =>
        position === null || !positionPrecedes(position, mutationPosition),
    )
  )
    return binding;
  const { retained, replacesEntry } = retainedInitializerOrigins(
    origins,
    binding,
    parents,
  );
  return {
    // A proven earlier assignment replaces even an import-equals value. A
    // capture before or inside an uncertain assignment retains the full binding.
    directOrigins: replacesEntry ? [] : binding.directOrigins,
    initializers: binding.initializers.filter((initializer) =>
      retained.has(initializer),
    ),
    referenceInitializers: binding.referenceInitializers.filter((initializer) =>
      retained.has(initializer),
    ),
  };
};

/** Reuse immutable ancestry facts across reads nested in the same expression. */
const bindingReadPosition = (
  read: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): BindingReadPosition => {
  const cache = initializerPositionCache(parents).read;
  const path: t.Node[] = [];
  let current = read;
  let result: BindingReadPosition;
  while (true) {
    const cached = cache.get(current);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    path.push(current);
    const parent = parents.get(current);
    if (t.isLoop(parent)) {
      result = { position: null, repeatingLoop: parent };
      break;
    }
    if (
      parent === undefined ||
      (t.isFunction(parent) && !semanticComputedMethodKey(parent, current)) ||
      delayedInstanceFieldValue(parent, current)
    ) {
      result = { position: null, repeatingLoop: undefined };
      break;
    }
    current = parent;
  }
  for (let index = path.length - 1; index >= 0; index--) {
    const node = path[index];
    if (node === undefined) continue;
    const parent = parents.get(node);
    let position: StatementPosition | null = null;
    if (t.isVariableDeclarator(parent)) {
      const declaration = parents.get(parent);
      if (t.isVariableDeclaration(declaration))
        position = statementPosition(declaration, parents, parent);
    } else if (
      t.isStatement(parent) &&
      !t.isLoop(parent) &&
      !t.isFunction(parent)
    )
      position = statementPosition(parent, parents);
    if (position !== null && position !== result.position)
      result = { repeatingLoop: result.repeatingLoop, position, outer: result };
    cache.set(node, result);
  }
  return result;
};

/** Keep the nearest shared statement body without crossing an activation. */
const matchingReadPosition = (
  read: BindingReadPosition,
  body: readonly t.Statement[] | undefined,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  if (body === undefined) return read.position;
  const matches = initializerPositionCache(parents).readMatches;
  let cached = matches.get(body);
  if (cached === undefined) {
    cached = new WeakMap();
    matches.set(body, cached);
  }
  const pending: BindingReadPosition[] = [];
  let result: StatementPosition | null = null;
  for (
    let current: BindingReadPosition | undefined = read;
    current !== undefined;
    current = current.outer
  ) {
    const known = cached.get(current);
    if (known !== undefined) {
      result = known;
      break;
    }
    pending.push(current);
    if (current.position?.body === body) {
      result = current.position;
      break;
    }
  }
  // Compress the shared chain for this requested body, including misses.
  // Distinct reads reuse their common outer nodes instead of walking depth N.
  for (const position of pending) cached.set(position, result);
  return result ?? read.position;
};

/** Repeated member reads share unknown ordering, while retaining their source sites. */
export const semanticCaptureOrderingIdentity = (
  capture: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): t.Node => {
  // Calls can have a distinct invocation effect at their own selection site.
  if (!t.isMemberExpression(capture) && !t.isOptionalMemberExpression(capture))
    return capture;
  const loop = bindingReadPosition(capture, parents).repeatingLoop;
  if (loop === undefined) return capture;
  let child: t.Node = capture;
  for (
    let parent = parents.get(child);
    parent !== undefined && parent !== loop;
    parent = parents.get(child)
  )
    child = parent;
  // These inputs run once, before the repeating portion of the loop.
  if (
    (t.isForStatement(loop) && child === loop.init) ||
    ((t.isForInStatement(loop) || t.isForOfStatement(loop)) &&
      child === loop.right)
  )
    return capture;
  return loop;
};

/** Select a local alias at its read, before any later straight-line reassignment. */
type SemanticBindingRead = {
  readonly status: "ordered" | "unresolved";
  /** A retained initializer executes on paths reaching this particular read. */
  readonly hasDefiniteInitializer: boolean;
  /** Unresolved reads retain all possible origins for conservative alias effects. */
  readonly binding: JavaScriptSemanticBindingState;
};

interface BindingTimelineCache {
  readonly body: readonly t.Statement[] | undefined;
  readonly initializers: JavaScriptSemanticBindingState["initializers"];
  readonly length: number;
  readonly references: number;
  readonly definitions: number;
  readonly first:
    | JavaScriptSemanticBindingState["initializers"][number]
    | undefined;
  readonly last:
    | JavaScriptSemanticBindingState["initializers"][number]
    | undefined;
  readonly timeline:
    | readonly {
        readonly position: StatementPosition;
        readonly initializer: JavaScriptSemanticBindingState["initializers"][number];
      }[]
    | null;
  readonly entryDefinitions: JavaScriptSemanticBindingState["definitions"];
}

/** Index definite straight-line writes once; other control flow uses the shared
 * conservative selector below. Collection appends/copies initializer facts, so
 * invalidate the index when that owner changes the binding's fact lists.
 */
const bindingTimeline = (
  binding: JavaScriptSemanticBindingState,
  parents: WeakMap<t.Node, t.Node>,
  body?: readonly t.Statement[],
): BindingTimelineCache => {
  const firstInitializer = binding.initializers[0];
  body ??=
    firstInitializer === undefined
      ? undefined
      : initializerPosition(firstInitializer, parents)?.body;
  const cache = initializerPositionCache(parents).timelines;
  const prior = cache.get(binding);
  if (
    prior !== undefined &&
    prior.body === body &&
    prior.initializers === binding.initializers &&
    prior.length === binding.initializers.length &&
    prior.references === binding.referenceInitializers.length &&
    prior.definitions === binding.definitions.length &&
    prior.first === binding.initializers[0] &&
    prior.last === binding.initializers.at(-1)
  )
    return prior;
  let timeline: NonNullable<BindingTimelineCache["timeline"]>[number][] | null =
    [];
  for (const initializer of binding.initializers) {
    const position = initializerInBody(initializer, parents, body);
    if (
      position === null ||
      initializerMayRetainEntry(initializer, binding, parents) ||
      (timeline.length > 0 && timeline[0]!.position.body !== position.body)
    ) {
      timeline = null;
      break;
    }
    timeline.push({ position, initializer });
  }
  timeline?.sort(
    (a, b) =>
      a.position.index - b.position.index ||
      a.position.declaratorIndex - b.position.declaratorIndex ||
      (a.initializer.node.start ?? 0) - (b.initializer.node.start ?? 0),
  );
  if (
    timeline?.some(
      (entry, index) =>
        index > 0 &&
        !positionPrecedes(timeline![index - 1]!.position, entry.position) &&
        expressionEvaluationOrder(
          timeline![index - 1]!.initializer.node,
          entry.initializer.node,
          parents,
        ) !== "before",
    )
  )
    timeline = null;
  const result: BindingTimelineCache = {
    body,
    initializers: binding.initializers,
    length: binding.initializers.length,
    references: binding.referenceInitializers.length,
    definitions: binding.definitions.length,
    first: binding.initializers[0],
    last: binding.initializers.at(-1),
    timeline,
    entryDefinitions: binding.definitions.filter(
      ({ kind }) => kind !== "assignment",
    ),
  };
  cache.set(binding, result);
  return result;
};

const readFromTimeline = (
  binding: JavaScriptSemanticBindingState,
  position: StatementPosition,
  read: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): SemanticBindingRead | undefined => {
  const index = bindingTimeline(binding, parents, position.body);
  const timeline = index.timeline;
  if (timeline === null || timeline[0]?.position.body !== position.body)
    return undefined;
  let low = 0,
    high = timeline.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const candidate = timeline[middle]!;
    let precedes = positionPrecedes(candidate.position, position);
    if (!precedes && !positionPrecedes(position, candidate.position)) {
      if (readInsideInitializer(read, candidate.initializer.node, parents))
        precedes = false;
      else {
        const order = expressionEvaluationOrder(
          candidate.initializer.node,
          read,
          parents,
        );
        if (order === "unresolved") return undefined;
        precedes = order === "before";
      }
    }
    if (precedes) low = middle + 1;
    else high = middle;
  }
  const entry = timeline[low - 1];
  return {
    status: "ordered",
    hasDefiniteInitializer: entry !== undefined,
    binding: {
      ...binding,
      directOrigins: entry === undefined ? binding.directOrigins : [],
      initializers: entry === undefined ? [] : [entry.initializer],
      referenceInitializers: [],
      definitions: index.entryDefinitions,
    },
  };
};

export const semanticBindingAtRead = (
  binding: JavaScriptSemanticBindingState,
  read: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): SemanticBindingRead => {
  if (
    binding.initializers.length === 0 &&
    binding.referenceInitializers.length === 0
  )
    return { status: "ordered", binding, hasDefiniteInitializer: false };
  const [soleInitializer] = binding.initializers;
  if (
    binding.initializers.length === 1 &&
    binding.referenceInitializers.length === 0 &&
    binding.declarationKinds.size === 0 &&
    binding.definitions.length === 1 &&
    binding.definitions[0]?.kind === "function" &&
    soleInitializer !== undefined &&
    t.isFunctionDeclaration(soleInitializer.node)
  )
    return { status: "ordered", binding, hasDefiniteInitializer: true };
  if (
    soleInitializer !== undefined &&
    t.isClass(soleInitializer.node) &&
    binding.scopeId === semanticScopeId("class", soleInitializer.node) &&
    !binding.mutable &&
    binding.initializers.length === 1 &&
    binding.referenceInitializers.length === 0 &&
    !binding.definitions.some(({ kind }) => kind === "assignment")
  ) {
    // The class self name is initialized before fields/static blocks run and
    // before a body method can be invoked, but not during heritage/key evaluation.
    const owner = soleInitializer.node;
    let child = read;
    let memberPart: t.Node | undefined;
    for (
      let parent = parents.get(child);
      parent !== undefined;
      child = parent, parent = parents.get(parent)
    ) {
      if (parents.get(parent) === owner.body) memberPart = child;
      if (parent === owner.body) {
        if (
          t.isClassMethod(child) || t.isClassPrivateMethod(child)
            ? memberPart === child.body
            : t.isStaticBlock(child) ||
              ((t.isClassProperty(child) ||
                t.isClassPrivateProperty(child) ||
                t.isClassAccessorProperty(child)) &&
                memberPart === child.value)
        )
          return { status: "ordered", binding, hasDefiniteInitializer: true };
        break;
      }
      if (parent === owner) break;
    }
  }
  const initializer = binding.initializers[0];
  const reference = binding.referenceInitializers[0];
  const origin = initializer ?? reference;
  let sourcePosition =
    initializer === undefined
      ? reference === undefined
        ? null
        : initializerPosition(reference, parents, true)
      : initializerPosition(initializer, parents);
  const readPosition = bindingReadPosition(read, parents);
  const { repeatingLoop } = readPosition;
  const position = matchingReadPosition(
    readPosition,
    sourcePosition?.body,
    parents,
  );
  const projectedInitializer =
    origin !== undefined &&
    position !== null &&
    sourcePosition !== null &&
    sourcePosition.body !== position.body;
  if (projectedInitializer)
    sourcePosition = initializerInBody(
      origin,
      parents,
      position.body,
      initializer === undefined,
    );
  if (
    !repeatingLoop &&
    position !== null &&
    (binding.initializers.length > 1 || projectedInitializer) &&
    binding.referenceInitializers.length === 0
  ) {
    const indexed = readFromTimeline(binding, position, read, parents);
    if (indexed !== undefined) return indexed;
  }
  // Coverage and latest-value selection are independent. A preceding write
  // can cover entry even when another write's order remains unknown.
  const hasDefiniteInitializer =
    position !== null &&
    [
      ...binding.initializers,
      ...binding.referenceInitializers.filter(({ assignment }) => assignment),
    ].some((initializer) => {
      const source = initializerInBody(
        initializer,
        parents,
        position?.body,
        binding.referenceInitializers.includes(initializer),
      );
      return (
        source !== null &&
        positionPrecedes(source, position) &&
        !initializerMayRetainEntry(initializer, binding, parents)
      );
    });
  if (
    !repeatingLoop &&
    origin !== undefined &&
    binding.initializers.length + binding.referenceInitializers.length === 1 &&
    sourcePosition !== null &&
    position !== null &&
    positionPrecedes(sourcePosition, position)
  )
    return {
      status: "ordered",
      binding,
      hasDefiniteInitializer,
    };
  const uncertainOrder =
    repeatingLoop ||
    sourcePosition === null ||
    position === null ||
    sourcePosition.body !== position.body;
  if (uncertainOrder)
    return { status: "unresolved", binding, hasDefiniteInitializer };
  const selected = selectInitializers(binding, position, read, parents);
  if (selected === undefined)
    return { status: "unresolved", binding, hasDefiniteInitializer };
  if (selected.binding === binding)
    return {
      status: "ordered",
      binding,
      hasDefiniteInitializer:
        hasDefiniteInitializer || selected.hasDefiniteInitializer,
    };
  return {
    status: "ordered",
    hasDefiniteInitializer:
      hasDefiniteInitializer || selected.hasDefiniteInitializer,
    binding: {
      ...binding,
      ...selected.binding,
      // Later assignment definitions do not describe the value captured here.
      definitions: binding.definitions.filter(
        ({ kind }) => kind !== "assignment",
      ),
    },
  };
};

const selectInitializers = (
  binding: JavaScriptSemanticBindingState,
  position: StatementPosition | null,
  read: t.Node,
  parents: WeakMap<t.Node, t.Node>,
):
  | {
      readonly binding: Pick<
        JavaScriptSemanticBindingState,
        "initializers" | "referenceInitializers"
      >;
      readonly hasDefiniteInitializer: boolean;
    }
  | undefined => {
  if (position === null) return undefined;
  const origins = [
    ...binding.initializers.map((initializer) => ({
      initializer,
      position: initializerInBody(initializer, parents, position.body),
    })),
    ...binding.referenceInitializers.map((initializer) => ({
      initializer,
      position: initializerInBody(initializer, parents, position.body, true),
    })),
  ];
  const preceding: typeof origins = [];
  for (const origin of origins) {
    const source = origin.position;
    if (source === null || source.body !== position.body) {
      if (
        semanticTopLevelEffectFollowsCapture(
          read,
          origin.initializer.node,
          parents,
        )
      )
        continue;
      return undefined;
    }
    if (positionPrecedes(source, position)) preceding.push(origin);
    else if (!positionPrecedes(position, source)) {
      if (
        source.index !== position.index ||
        source.declaratorIndex !== position.declaratorIndex
      )
        return undefined;
      const parent = parents.get(origin.initializer.node);
      if (
        ((t.isAssignmentExpression(parent) &&
          parent.right === origin.initializer.node) ||
          (t.isVariableDeclarator(parent) &&
            parent.init === origin.initializer.node)) &&
        readInsideInitializer(read, origin.initializer.node, parents) &&
        semanticTopLevelEffectIsOrderable(parent, parents)
      )
        continue;
      const order = expressionEvaluationOrder(
        origin.initializer.node,
        read,
        parents,
      );
      // Failure to prove precedence is not proof that the write happens later.
      if (order === "unresolved") return undefined;
      if (order === "before") preceding.push(origin);
    }
  }
  const { retained, replacesEntry } = retainedInitializerOrigins(
    preceding,
    binding,
    parents,
  );
  // Preserve the owner's identity when selection removes no facts. Consumers
  // can then reuse the binding's dependency-aware provenance memo rather than
  // treating every equivalent read as a new temporal snapshot.
  if (
    binding.initializers.every((initializer) => retained.has(initializer)) &&
    binding.referenceInitializers.every((initializer) =>
      retained.has(initializer),
    )
  )
    return { binding, hasDefiniteInitializer: replacesEntry };
  return {
    hasDefiniteInitializer: replacesEntry,
    binding: {
      initializers: binding.initializers.filter((initializer) =>
        retained.has(initializer),
      ),
      referenceInitializers: binding.referenceInitializers.filter(
        (initializer) => retained.has(initializer),
      ),
    },
  };
};

/** An assignment installs its value only after its RHS has evaluated. */
const readInsideInitializer = (
  read: t.Node,
  initializer: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  const owner = initializerPositionCache(parents);
  if (owner.initializerReads?.initializer !== initializer)
    owner.initializerReads = { initializer, reads: new WeakMap() };
  const cache = owner.initializerReads.reads;
  const path: t.Node[] = [];
  let current: t.Node | undefined = read;
  let result = false;
  while (current !== undefined) {
    if (current === initializer) {
      result = true;
      break;
    }
    const cached = cache.get(current);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    path.push(current);
    const parent = parents.get(current);
    if (
      t.isFunction(parent) ||
      (parent !== undefined && delayedInstanceFieldValue(parent, current))
    )
      break;
    current = parent;
  }
  for (const node of path) cache.set(node, result);
  return result;
};

/** Logical writes may keep prior aliases. An RHS fact alone does not prove an
 * empty local: the complete binding must exclude incoming/default/other writes.
 */
const initializerMayRetainEntry = (
  initializer: JavaScriptSemanticBindingState["initializers"][number],
  binding: JavaScriptSemanticBindingState,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  const node = initializer.node,
    parent = parents.get(node);
  const assignment = t.isAssignmentExpression(node)
    ? node
    : t.isAssignmentExpression(parent) && parent.right === node
      ? parent
      : undefined;
  if (
    assignment === undefined ||
    !["&&=", "||=", "??="].includes(assignment.operator)
  )
    return false;
  const emptyLocal =
    node === assignment.right &&
    binding.kind === "variable" &&
    !binding.runtimeImport &&
    binding.initializers.length === 1 &&
    binding.initializers[0] === initializer &&
    binding.referenceInitializers.length === 0 &&
    binding.directOrigins.length === 0 &&
    binding.definitions.some(({ kind }) => kind === "variable") &&
    binding.definitions.every(
      ({ kind }) => kind === "variable" || kind === "assignment",
    );
  return !emptyLocal;
};

/** Certain writes replace prior origins; short-circuit writes retain both. */
const retainedInitializerOrigins = (
  origins: readonly {
    readonly initializer: JavaScriptSemanticBindingState["initializers"][number];
    readonly position: StatementPosition | null;
  }[],
  binding: JavaScriptSemanticBindingState,
  parents: WeakMap<t.Node, t.Node>,
) => {
  const latest = origins.reduce<StatementPosition | null>(
    (latest, { initializer, position }) =>
      position !== null &&
      !initializerMayRetainEntry(initializer, binding, parents) &&
      (latest === null || positionPrecedes(latest, position))
        ? position
        : latest,
    null,
  );
  return {
    replacesEntry: latest !== null,
    retained: new Set(
      origins
        .filter(
          ({ position }) =>
            latest === null ||
            (position?.index === latest.index &&
              position?.declaratorIndex === latest.declaratorIndex) ||
            (position !== null && positionPrecedes(latest, position)),
        )
        .map(({ initializer }) => initializer),
    ),
  };
};

/** Locate an initializer or completed return-expression capture in its body. */
export const semanticCapturePosition = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  let current = node;
  while (true) {
    const direct = directInitializerPosition(current, parents);
    if (direct !== null) return direct;
    const parent = parents.get(current);
    if (t.isReturnStatement(parent) && parent.argument === current)
      return statementPosition(parent, parents);
    if (
      t.isObjectProperty(parent) &&
      parent.value === current &&
      semanticStaticPropertyKey(parent.key, parent.computed) !== null
    )
      current = parent;
    else if (
      t.isSpreadElement(parent) &&
      parent.argument === current &&
      t.isObjectExpression(parents.get(parent))
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
  const sourcePosition = initializerPosition(initializer, parents);
  const capturePosition = semanticCapturePosition(capture, parents);
  return (
    sourcePosition !== null &&
    capturePosition !== null &&
    positionPrecedes(sourcePosition, capturePosition)
  );
};

/** A preceding initializer and capture in one body precede its later effect. */
export const semanticBindingEffectFollowsCapture = (
  binding: JavaScriptSemanticBindingState,
  capture: t.Node,
  effect: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  if (!semanticBindingPrecedesCapture(binding, capture, parents)) return false;
  const captured = semanticCapturePosition(capture, parents);
  const written = directMutationPosition(effect, parents);
  return (
    captured !== null && written !== null && positionPrecedes(captured, written)
  );
};

/** A local declaration resets its lexical value before an ordinary member read. */
export const semanticBindingEffectFollowsRead = (
  binding: JavaScriptSemanticBindingState,
  read: t.Node,
  effect: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  const initializer = binding.initializers[0];
  if (binding.initializers.length !== 1 || initializer === undefined)
    return false;
  const declaration = parents.get(initializer.node);
  // A logical/compound assignment may preserve a value from a prior call.
  if (
    !t.isVariableDeclarator(declaration) ||
    declaration.init !== initializer.node
  )
    return false;
  const initialized = initializerPosition(initializer, parents);
  const selected = bindingReadPosition(read, parents).position;
  return (
    initialized !== null &&
    selected !== null &&
    positionPrecedes(initialized, selected) &&
    semanticReadPrecedesEffectWithinActivation(read, effect, parents)
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
  const origin = unwrapJavaScriptExpression(initializer.node).node;
  if (
    !t.isObjectExpression(origin) &&
    !t.isArrayExpression(origin) &&
    !t.isIdentifier(origin) &&
    !t.isMemberExpression(origin) &&
    !t.isOptionalMemberExpression(origin)
  )
    return false;
  const capturePosition = semanticCapturePosition(capture, parents);
  const exit = scopeExitOwners.get(escape);
  if (exit !== undefined) {
    // Unlike a source-global ordering proof, this binding was initialized in
    // the captured body. Its later sibling scope exits follow this activation.
    const exitPosition = t.isStatement(exit)
      ? statementPosition(exit, parents)
      : null;
    return (
      withinScopeExit(capture, exit, parents) ||
      (capturePosition !== null &&
        exitPosition !== null &&
        positionPrecedes(capturePosition, exitPosition))
    );
  }
  const escapePosition = directMutationPosition(escape, parents);
  return (
    capturePosition !== null &&
    escapePosition !== null &&
    positionPrecedes(capturePosition, escapePosition)
  );
};

/** Explicit wrapper facts and program `var` redeclarations retain their lexical identity. */
export const commonJsWrapperBindingDeclaration = (
  node: t.Node,
  name: string,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticBindingState | undefined => {
  if (
    !["module", "exports", "require", "__dirname", "__filename"].includes(
      name,
    ) ||
    !t.isIdentifier(node, { name })
  )
    return undefined;
  const binding = resolveSemanticBindingState(state, node, name);
  if (binding === undefined) return undefined;
  const scope = state.scopesById.get(binding.scopeId);
  if (
    scope?.kind !== "program" ||
    ![...binding.declarationKinds].every((kind) => kind === "var")
  )
    return undefined;
  // The index owns explicit wrapper parameters, including ones with no source
  // redeclaration. Babel's module classification does not invalidate that fact.
  if (binding.hostOrigin === "commonjs-wrapper") return binding;
  // Without an explicit host fact, preserve the legacy script-var inference.
  return state.program.sourceType === "script" &&
    binding.declarationKinds.size > 0
    ? binding
    : undefined;
};

/** Retained value and pattern stores share one source-ordered write boundary. */
export const semanticBindingHasPriorValueWrite = (
  site: t.Node,
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (binding.definitions.some(({ kind }) => kind === "function")) return true;
  const writes = state.bindingWrites.get(binding.bindingId) ?? [];
  const read = semanticBindingAtRead(binding, site, state.parentsByNode);
  const retained =
    read.status === "ordered"
      ? new Set([
          ...read.binding.initializers,
          ...read.binding.referenceInitializers,
        ])
      : undefined;
  const representedWrites = new Set<t.Node>();
  const retainedWrites = new Set<t.Node>();
  for (const source of [
    ...binding.initializers,
    ...binding.referenceInitializers,
  ]) {
    let owner: t.Node | undefined = source.node;
    while (owner !== undefined && !writes.includes(owner))
      owner = state.parentsByNode.get(owner);
    if (owner !== undefined) {
      representedWrites.add(owner);
      if (retained === undefined || retained.has(source))
        retainedWrites.add(owner);
    } else if (
      (retained === undefined || retained.has(source)) &&
      semanticEffectTiming(site, source.node, state) !== "after"
    )
      return true;
  }
  return writes.some(
    (write) =>
      (!representedWrites.has(write) || retainedWrites.has(write)) &&
      semanticEffectTiming(site, write, state) !== "after",
  );
};

/** A program-level `var` redeclaration still denotes its untouched CJS wrapper parameter. */
export const isUnmodifiedCommonJsWrapperBinding = (
  node: t.Node,
  name: string,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const binding = commonJsWrapperBindingDeclaration(node, name, state);
  return (
    binding !== undefined &&
    !semanticBindingHasPriorValueWrite(node, binding, state)
  );
};

/** Identify a global name only when no lexical or dynamic environment shadows it. */
export const isUnshadowedGlobal = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  name: string,
): boolean =>
  t.isIdentifier(node, { name }) &&
  (resolveSemanticBindingState(state, node, name) === undefined
    ? !semanticResolutionBlocked(state, node, name)
    : isUnmodifiedCommonJsWrapperBinding(node, name, state));
