import * as t from "@babel/types";

import type {
  JavaScriptSemanticCallable,
  JavaScriptSemanticObjectOperation,
} from "./javascriptSemanticIr.js";
import { createSemanticCallableIdStack } from "./javascriptSemanticCallableStack.js";
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
} from "./javascriptSemanticState.js";
import { traverseJavaScriptValueAst } from "./javascriptSemanticTraversal.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import {
  createSemanticReadPresenceQuery,
  isKnownDefinedSource,
} from "./javascriptSemanticReadPresence.js";
import {
  isLexicalPatternDeclaration,
  semanticArrayPatternCanResumeAfterClose,
} from "./javascriptSemanticReferenceSources.js";

const isDefinitelyUndefinedReceiver = (
  node: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (node === undefined) return false;
  const value = unwrapJavaScriptExpression(node).node;
  return (
    t.isUnaryExpression(value, { operator: "void" }) ||
    (t.isIdentifier(value, { name: "undefined" }) &&
      resolveSemanticBindingState(state, value, value.name) === undefined)
  );
};

const isDefinitelyNullishReceiver = (
  node: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  node !== undefined &&
  (t.isNullLiteral(unwrapJavaScriptExpression(node).node) ||
    isDefinitelyUndefinedReceiver(node, state));

interface PatternCompletionContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly read: ((path: readonly string[]) => t.Node | undefined) | undefined;
}

const markIncompletePatternTargets = (
  pattern: t.Node | undefined | null,
  path: readonly string[] | null,
  receiver: t.Node | undefined,
  blocked: boolean,
  nested: boolean,
  context: PatternCompletionContext,
): boolean => {
  if (pattern == null) return false;
  const node = unwrapJavaScriptExpression(pattern).node;
  if (t.isAssignmentPattern(node)) {
    const defaultReceiver = isDefinitelyUndefinedReceiver(
      receiver,
      context.state,
    )
      ? unwrapJavaScriptExpression(node.right).node
      : receiver;
    return markIncompletePatternTargets(
      node.left,
      path,
      defaultReceiver,
      blocked,
      nested,
      context,
    );
  }
  if (t.isRestElement(node))
    return markIncompletePatternTargets(
      node.argument,
      path,
      undefined,
      blocked,
      nested,
      context,
    );
  if (t.isIdentifier(node)) {
    if (blocked) {
      const binding = resolveSemanticBindingState(
        context.state,
        node,
        node.name,
      );
      if (binding !== undefined)
        context.state.destructuringIncompleteBindings.add(binding.bindingId);
    }
    return false;
  }
  if (t.isObjectPattern(node)) {
    let blockedAfter =
      blocked ||
      (nested && isDefinitelyNullishReceiver(receiver, context.state));
    for (const property of node.properties) {
      const prop = t.isObjectProperty(property) ? property : undefined;
      const name =
        prop === undefined
          ? null
          : semanticStaticPropertyKey(prop.key, prop.computed);
      if (prop === undefined || name === null || prop.computed) {
        blockedAfter =
          markIncompletePatternTargets(
            prop?.value ?? property,
            null,
            undefined,
            blockedAfter,
            true,
            context,
          ) || blockedAfter;
        continue;
      }
      const childPath = path === null ? null : [...path, name];
      blockedAfter =
        markIncompletePatternTargets(
          prop.value,
          childPath,
          childPath === null ? undefined : context.read?.(childPath),
          blockedAfter,
          true,
          context,
        ) || blockedAfter;
    }
    return blockedAfter;
  }
  if (t.isArrayPattern(node)) {
    let blockedAfter =
      blocked ||
      (nested && isDefinitelyNullishReceiver(receiver, context.state));
    for (const [index, element] of node.elements.entries()) {
      if (element === null) continue;
      const childPath = path === null ? null : [...path, String(index)];
      blockedAfter =
        markIncompletePatternTargets(
          element,
          childPath,
          childPath === null ? undefined : context.read?.(childPath),
          blockedAfter,
          true,
          context,
        ) || blockedAfter;
    }
    return blockedAfter;
  }
  return false;
};

export const collectJavaScriptDestructuringCompletion = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): void => {
  if (!state.memberMutationFactsComplete) return;
  const readPresence = createSemanticReadPresenceQuery(state, false);
  const visit = (root: t.Node, initializer: t.Node | null | undefined) => {
    const source = expressionObjectIdentity(initializer, state);
    const sourcePresence =
      initializer != null && source.path !== null
        ? readPresence(source.bindingId, initializer, {
            path: source.path,
            selection: t.isArrayPattern(root) ? "array-iterator" : "own-data",
          })
        : undefined;
    const read = sourcePresence?.read;
    markIncompletePatternTargets(
      root,
      source.path,
      source.path === null || read === undefined
        ? initializer ?? undefined
        : (read(source.path) ?? initializer ?? undefined),
      false,
      false,
      { state, read },
    );
  };
  traverseJavaScriptValueAst(program, state.erasedSyntaxNodes, {
    enter: (node) => {
      if (
        t.isVariableDeclarator(node) &&
        (t.isObjectPattern(node.id) || t.isArrayPattern(node.id))
      )
        visit(node.id, node.init);
      else if (
        t.isAssignmentExpression(node, { operator: "=" }) &&
        (t.isObjectPattern(node.left) || t.isArrayPattern(node.left))
      )
        visit(node.left, node.right);
    },
  });
};

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
  return output;
};

interface ObjectCollectionContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly output: JavaScriptSemanticObjectOperation[];
  readonly writeTargets: Map<t.Node, t.Node>;
  readonly readPresence: ReturnType<typeof createSemanticReadPresenceQuery>;
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

const collectDestructuring = (
  root: t.Node,
  initializer: t.Node | null | undefined,
  ownerCallableId: string | null,
  { state, output, readPresence }: ObjectCollectionContext,
): void => {
  const source = expressionObjectIdentity(initializer, state);
  const rootArray = t.isArrayPattern(root);
  const owner = state.parentsByNode.get(root);
  const assignment = t.isAssignmentExpression(owner);
  const sourcePresence =
    initializer != null && source.path !== null
      ? readPresence(source.bindingId, initializer, {
          path: source.path,
          selection: rootArray ? "array-iterator" : "own-data",
        })
      : undefined;
  let ownSlot = sourcePresence?.read;
  let assignmentBlocked = false;
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
    const plainObjectPath = next.plainObjectPath === true && !hasDefault;
    if (
      hasDefault &&
      (!isKnownDefinedSource(selected) ||
        !isLexicalPatternDeclaration(owner, state))
    )
      ownSlot = undefined;
    const pattern = hasDefault
      ? unwrapJavaScriptExpression(occurrence.left).node
      : occurrence;
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
          pending.push(
            assignment
              ? {
                  pattern: prop?.value ?? property,
                  path: null,
                  lookup: "unproven",
                }
              : null,
          );
          continue;
        }
        pending.push({
          pattern: prop.value,
          path: [...path, name],
          plainObjectPath: plainObjectPath && !prop.computed,
          lookup: prop.computed ? "unproven" : "own",
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
        if (element === undefined || (!assignment && t.isRestElement(element)))
          pending.push(null);
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
    const patternBlocked =
      targetBinding !== undefined &&
      state.destructuringIncompleteBindings.has(targetBinding.bindingId);
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
        partial: assignmentBlocked || patternBlocked,
        provenOwnSlot:
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
