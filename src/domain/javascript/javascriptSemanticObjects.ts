import * as t from "@babel/types";

import type {
  JavaScriptSemanticCallable,
  JavaScriptSemanticObjectOperation,
} from "./javascriptSemanticIr.js";
import { createSemanticCallableIdStack } from "./javascriptSemanticCallableStack.js";
import { createSemanticExpressionShapeResolver } from "./javascriptSemanticExpressionShapes.js";
import { semanticBindingMayRejectAssignmentAt } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticStaticPropertyKey,
  semanticWriteSiteReadsFirst,
  semanticWriteSiteTarget,
  semanticWriteTargets,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptValueAst } from "./javascriptSemanticTraversal.js";
import {
  clearSemanticValueCaches,
  evaluateSemanticExpression,
} from "./javascriptSemanticValues.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import {
  createSemanticReadPresenceQuery,
  isKnownDefinedSource,
} from "./javascriptSemanticReadPresence.js";
import {
  isLexicalPatternDeclaration,
  semanticArrayPatternCanResumeAfterClose,
} from "./javascriptSemanticReferenceSources.js";

/** Recover bounded static property reads, writes, spreads, and destructuring. */
export const collectJavaScriptSemanticObjects = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): JavaScriptSemanticObjectOperation[] => {
  const output: JavaScriptSemanticObjectOperation[] = [];
  const callableIds = new Set(callables.map(({ callableId }) => callableId));
  const callableStack = createSemanticCallableIdStack(callableIds);
  const context: ObjectCollectionContext = {
    state,
    output,
    writeTargets: new Map(),
    readPresence: createSemanticReadPresenceQuery(state),
    isNullish: createSemanticExpressionShapeResolver(state).isNullish,
    skippedBindings: new Set(),
  };
  traverseJavaScriptValueAst(program, state.erasedSyntaxNodes, {
    enter: (node, parent) => {
      callableStack.enter(node, parent);
      const ownerCallableId = callableStack.callables.at(-1) ?? null;
      const writeTarget = semanticWriteSiteTarget(node);
      if (writeTarget !== null)
        for (const leaf of semanticWriteTargets(writeTarget))
          if (!t.isIdentifier(leaf)) context.writeTargets.set(leaf, node);
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
        collectDestructuring(node.id, node.init, ownerCallableId, context);
      else if (
        t.isAssignmentExpression(node, { operator: "=" }) &&
        (t.isObjectPattern(node.left) || t.isArrayPattern(node.left))
      )
        collectDestructuring(node.left, node.right, ownerCallableId, context);
    },
    exit: (node) => callableStack.exit(node),
  });
  discardSkippedInitializers(state, context.skippedBindings);
  return output;
};

interface ObjectCollectionContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly output: JavaScriptSemanticObjectOperation[];
  readonly writeTargets: Map<t.Node, t.Node>;
  readonly readPresence: ReturnType<typeof createSemanticReadPresenceQuery>;
  readonly isNullish: (node: t.Node) => boolean;
  readonly skippedBindings: Set<t.Identifier>;
}

const discardSkippedInitializers = (
  state: JavaScriptSemanticAnalysisState,
  skipped: ReadonlySet<t.Identifier>,
): void => {
  if (skipped.size === 0) return;
  const discard = (sources: JavaScriptSemanticInitializer[]): void => {
    let retained = 0;
    for (const source of sources) {
      const target = source.patternTarget;
      if (target === undefined || !skipped.has(target))
        sources[retained++] = source;
    }
    sources.length = retained;
  };
  for (const binding of state.bindingsById.values()) {
    discard(binding.initializers);
    discard(binding.referenceInitializers);
  }
  clearSemanticValueCaches(state);
};

const isNestedReceiver = (occurrence: t.Node | null): boolean => {
  if (occurrence === null) return false;
  const { node } = unwrapJavaScriptExpression(occurrence);
  const target = t.isAssignmentPattern(node)
    ? unwrapJavaScriptExpression(node.left).node
    : node;
  return t.isObjectPattern(target) || t.isArrayPattern(target);
};

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
  const writeSite = context.writeTargets.get(node);
  context.writeTargets.delete(node);
  const write = writeSite !== undefined;
  const readsBeforeWrite =
    writeSite !== undefined && semanticWriteSiteReadsFirst(writeSite);
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
      provenOwnSlot:
        !write &&
        identity.path !== null &&
        context.readPresence(identity.bindingId, node)?.read(identity.path) !==
          undefined,
      ownerCallableId,
      objectBindingId: identity.bindingId,
      targetBindingId: null,
      propertyPath: identity.path,
    },
    state,
    output,
  );
};

/** Distinguish null from undefined because only undefined selects a default. */
const destructuringNullishKind = (
  expression: t.Node,
  state: JavaScriptSemanticAnalysisState,
  isNullish: ObjectCollectionContext["isNullish"],
): "null" | "undefined" | null => {
  const { node } = unwrapJavaScriptExpression(expression);
  if (t.isNullLiteral(node)) return "null";
  if (isNullish(node)) return "undefined";
  if (isKnownDefinedSource(node)) return null;
  const value = evaluateSemanticExpression(node, state);
  return value.status === "literal" && value.value === null ? "null" : null;
};

const collectDestructuring = (
  root: t.Node,
  initializer: t.Node | null | undefined,
  ownerCallableId: string | null,
  {
    state,
    output,
    readPresence,
    isNullish,
    skippedBindings,
  }: ObjectCollectionContext,
): void => {
  const source = expressionObjectIdentity(initializer, state);
  const rootArray = t.isArrayPattern(root);
  const owner = state.parentsByNode.get(root);
  const assignment = t.isAssignmentExpression(owner);
  const hasNestedReceiver = rootArray
    ? root.elements.some(isNestedReceiver)
    : t.isObjectPattern(root) &&
      root.properties.some(
        (property) =>
          t.isObjectProperty(property) && isNestedReceiver(property.value),
      );
  const sourcePresence =
    initializer != null && source.path !== null
      ? readPresence(source.bindingId, initializer, {
          path: source.path,
          selection: rootArray ? "array-iterator" : "own-data",
          proveNestedCompletion: hasNestedReceiver,
        })
      : undefined;
  let ownSlot = sourcePresence?.read;
  let assignmentBlocked = false;
  let abrupt = false;
  // A null path keeps a target in evaluation order without emitting an
  // operation for a source slot we cannot identify.
  const pending: (
    | {
        readonly pattern: t.Node | undefined;
        readonly path: readonly string[] | null;
        readonly plainObjectPath?: boolean;
        readonly lookup?: "own" | "unproven";
      }
    | { readonly resume: NonNullable<typeof ownSlot> }
    | null
  )[] = [{ pattern: root, path: [], plainObjectPath: !rootArray }];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    if (next === null) {
      ownSlot = undefined;
      continue;
    }
    if ("resume" in next) {
      if (ownSlot !== undefined) ownSlot = next.resume;
      continue;
    }
    const { path } = next;
    const propertyPath =
      source.path === null || path === null ? null : [...source.path, ...path];
    const selected =
      next.lookup === "own" && propertyPath !== null
        ? ownSlot?.(propertyPath)
        : undefined;
    if (
      next.lookup === "unproven" ||
      (next.lookup === "own" && selected === undefined)
    )
      ownSlot = undefined;
    // Elision still advances the iterator and can read a property. It
    // contributes no binding once the shared slot check has run.
    if (next.pattern === undefined) continue;
    const occurrence = unwrapJavaScriptExpression(next.pattern).node;
    const hasDefault = t.isAssignmentPattern(occurrence);
    const pattern = hasDefault
      ? unwrapJavaScriptExpression(occurrence.left).node
      : occurrence;
    const plainObjectPath = next.plainObjectPath === true && !hasDefault;
    // A bounded evaluation can prove the original data slot nullish.
    const nullish =
      selected !== undefined &&
      (t.isObjectPattern(pattern) || t.isArrayPattern(pattern))
        ? destructuringNullishKind(selected, state, isNullish)
        : null;
    if (
      nullish !== null &&
      (nullish === "null" ||
        !hasDefault ||
        destructuringNullishKind(occurrence.right, state, isNullish) !== null)
    ) {
      abrupt = true;
      ownSlot = undefined;
    }
    if (abrupt && path === null) {
      for (const target of semanticWriteTargets(pattern))
        if (t.isIdentifier(target)) skippedBindings.add(target);
      continue;
    }
    if (
      hasDefault &&
      (!isKnownDefinedSource(selected) ||
        !isLexicalPatternDeclaration(owner, state))
    )
      ownSlot = undefined;
    if (t.isRestElement(pattern)) {
      ownSlot = undefined;
      if (assignment) pending.push({ pattern: pattern.argument, path: null });
      continue;
    }
    if (t.isObjectPattern(pattern)) {
      // Later siblings require the nested receiver check to complete.
      if (
        ownSlot !== sourcePresence?.read ||
        (pattern !== root &&
          !t.isObjectExpression(selected) &&
          (rootArray ||
            pattern.properties.length !== 0 ||
            t.isNullLiteral(selected) ||
            !isKnownDefinedSource(selected)))
      )
        ownSlot = undefined;
      for (const property of pattern.properties.toReversed()) {
        const prop = t.isObjectProperty(property) ? property : undefined;
        const name =
          prop === undefined
            ? null
            : semanticStaticPropertyKey(prop.key, prop.computed);
        if (path === null || prop === undefined || name === null) {
          pending.push({
            pattern: prop?.value ?? property,
            path: null,
            lookup: "unproven",
          });
          continue;
        }
        // Computing a known key with effects (for example, void call())
        // can still invalidate the source slots before the property lookup.
        const ownLookup =
          !prop.computed ||
          t.isPureish(unwrapJavaScriptExpression(prop.key).node);
        pending.push({
          pattern: prop.value,
          path: [...path, name],
          plainObjectPath: plainObjectPath && ownLookup,
          lookup: ownLookup ? "own" : "unproven",
        });
      }
      continue;
    }
    if (t.isArrayPattern(pattern)) {
      if (pattern !== root) {
        const parentRead = ownSlot;
        ownSlot =
          parentRead !== undefined &&
          parentRead === sourcePresence?.read &&
          (!rootArray || path?.length === 1) &&
          t.isArrayExpression(selected) &&
          path !== null &&
          propertyPath !== null
            ? sourcePresence?.readNestedArray(
                selected,
                propertyPath,
                path,
                pattern,
              )
            : undefined;
        // Resume only after all inner bindings retained their proof and the
        // native close cannot run a hook. Assignment targets can still throw.
        if (ownSlot !== undefined)
          pending.push(
            parentRead !== undefined &&
              semanticArrayPatternCanResumeAfterClose(pattern, owner, state)
              ? { resume: parentRead }
              : null,
          );
      }
      for (let index = pattern.elements.length - 1; index >= 0; index -= 1) {
        const element = pattern.elements[index];
        if (element === undefined) pending.push(null);
        else if (!assignment && t.isRestElement(element))
          pending.push({ pattern: element, path: null, lookup: "unproven" });
        else
          pending.push({
            pattern: element ?? undefined,
            path: path === null ? null : [...path, String(index)],
            lookup: "own",
          });
      }
      continue;
    }
    if (!t.isIdentifier(pattern)) {
      ownSlot = undefined;
      continue;
    }
    const targetBinding = resolveSemanticBindingState(
      state,
      pattern,
      pattern.name,
    );
    if (abrupt) skippedBindings.add(pattern);
    assignmentBlocked ||=
      assignment &&
      targetBinding !== undefined &&
      semanticBindingMayRejectAssignmentAt(targetBinding, owner, state);
    if (targetBinding === undefined || assignmentBlocked) ownSlot = undefined;
    if (path === null) continue;
    addObjectOperation(
      {
        node: occurrence,
        kind: "destructure",
        ownerCallableId,
        objectBindingId: source.bindingId,
        targetBindingId: targetBinding?.bindingId ?? null,
        propertyPath,
        partial: abrupt || assignmentBlocked,
        provenOwnSlot:
          !abrupt &&
          !assignmentBlocked &&
          (ownSlot !== undefined ||
            (plainObjectPath &&
              targetBinding !== undefined &&
              propertyPath !== null &&
              sourcePresence?.read(propertyPath, occurrence) !== undefined)),
      },
      state,
      output,
    );
  }
};

interface AddObjectOperationInput {
  readonly node: t.Node;
  readonly kind: JavaScriptSemanticObjectOperation["kind"];
  readonly ownerCallableId: string | null;
  readonly objectBindingId: string | null;
  readonly targetBindingId: string | null;
  readonly propertyPath: readonly string[] | null;
  readonly provenOwnSlot?: boolean;
  readonly partial?: boolean;
}

const addObjectOperation = (
  input: AddObjectOperationInput,
  state: JavaScriptSemanticAnalysisState,
  output: JavaScriptSemanticObjectOperation[],
): void => {
  output.push({
    // These high-volume IDs must not retain intermediate concatenations.
    objectOperationId: [
      "object",
      input.kind,
      String(input.node.start ?? -1),
      String(input.node.end ?? -1),
    ].join(":"),
    kind: input.kind,
    ...(input.provenOwnSlot === true
      ? { sourcePresence: "present" as const }
      : {}),
    location: range(input.node),
    ownerCallableId: input.ownerCallableId,
    objectBindingId: input.objectBindingId,
    targetBindingId: input.targetBindingId,
    propertyPath: input.propertyPath,
    resolution:
      input.partial === true ||
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
