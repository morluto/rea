import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  semanticCallableResultExpressions,
  semanticCallableResultKind,
} from "./javascriptSemanticCallableResults.js";
import {
  javaScriptSourceInvocationContext,
  javaScriptGenericInvocationMethod,
  resolveJavaScriptGenericInvocation,
  type JavaScriptSourceInvocationContext,
} from "./javascriptIntrinsicInvocation.js";
import {
  semanticBindingAtRead,
  semanticEffectTiming,
  semanticStableBindingInitializedBeforeRead,
} from "./javascriptSemanticMutationInitializers.js";
import {
  semanticReferenceSourcesInactive,
  semanticKnownArrayIteration,
  semanticKnownArrayIterationAt,
  semanticSelectedReferenceSlot,
} from "./javascriptSemanticReferenceSources.js";
import { semanticOpaqueBindingReadMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import { semanticArrayPropertyReferences } from "./javascriptSemanticObjectReferences.js";
import {
  semanticNormalizeCapturedSelections,
  semanticProjectedSourceFactsAtRead,
  semanticProjectedSourcesAtRead,
  semanticShiftCapturedSelections,
  type SemanticCapturedSelection,
} from "./javascriptSemanticProjectedSources.js";
import {
  semanticArrayIndex,
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  SemanticAliasSelections,
  semanticAliasSelectionChoices,
  type SemanticAliasSelectionPath,
} from "./javascriptSemanticAliasSelections.js";
import { semanticCopiedReferencePath } from "./javascriptSemanticCopiedReferencePaths.js";
import { semanticMethodDefinitionExpression } from "./javascriptSemanticEvaluationOrder.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { evaluateSemanticSelectedBranches } from "./javascriptSemanticValues.js";

/** A parameter source bound by an enclosing call-site frame. */
export interface SemanticCallFrameParameterSource {
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
  readonly capturedSelections?: readonly SemanticCapturedSelection[];
  readonly restElementIndex?: number | null;
  readonly copyKind?: "object-rest" | "array-rest";
  readonly copyProjectionOffset?: number;
  readonly copyExcludedKeys?: readonly string[];
  readonly copyStartIndex?: number;
}

/** Active invocation-frame parameter and receiver facts for nested callee resolution. */
export interface SemanticReturnedReferenceCallFrame {
  readonly id: number;
  readonly callReadAt: t.Node;
  readonly hasOpaqueArguments?: boolean | undefined;
  readonly parameterSources: ReadonlyMap<
    string,
    readonly SemanticCallFrameParameterSource[]
  >;
  readonly inactiveDefaultNodes: ReadonlySet<t.Node>;
  readonly receiverCallables: ReadonlySet<t.Function>;
  readonly receiverSources: readonly t.Expression[];
  readonly parentFrame?: SemanticReturnedReferenceCallFrame | undefined;
}

/** A reference potentially handed to a caller or generator consumer. */
export interface SemanticReturnedReference {
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
  readonly kind?: "return" | "yield";
  readonly resultKind?: "value" | "promise" | "iterator" | "async-iterator";
}

interface Candidate {
  readonly node: t.Node;
  /** `undefined` means any projection depth after different projection depths merge. */
  readonly path: SemanticAliasSelectionPath | undefined;
  /** Member selection happens at its use, while a captured function keeps its read. */
  readonly readAt?: t.Node | undefined;
  readonly capturedSelections?:
    | readonly SemanticCapturedSelection[]
    | undefined;
  readonly invocation?: JavaScriptSourceInvocationContext | undefined;
  readonly frame?: SemanticReturnedReferenceCallFrame | undefined;
}

export interface SemanticReturnedReferenceResult {
  readonly references: readonly SemanticReturnedReference[];
  /** Source-local callable targets resolved by the same binding/projection owner. */
  readonly callables: ReadonlySet<t.Function>;
  /** Actual invocation contexts reaching each callable when an invocation was supplied. */
  readonly callableInvocations?: ReadonlyMap<
    t.Function,
    readonly JavaScriptSourceInvocationContext[]
  >;
  /** Callables reached after context widening where positional arguments could not be preserved. */
  readonly widenedCallables?: ReadonlySet<t.Function>;
  /** Whether the callee may evaluate to `undefined` or a callable outside `callables`. */
  readonly unresolvedCallable?: boolean;
  /** A visible invocation-method mutation prevents a source-local result proof. */
  readonly unresolvedInvocation?: boolean;
  /** Both states close the supported source-local may-target graph. Widened joins projections without dropping represented targets; it does not claim runtime completeness. */
  readonly precision: "exact" | "widened";
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
  consumption:
    | "potential-reference"
    | "direct-call"
    | "awaited-call" = "potential-reference",
  options?: { readonly includeResultMetadata?: boolean },
): ((
  callee: t.Node,
  invocation?:
    | t.CallExpression
    | t.OptionalCallExpression
    | t.TaggedTemplateExpression,
  callFrame?: SemanticReturnedReferenceCallFrame,
) => SemanticReturnedReferenceResult) => {
  const results = new WeakMap<
    t.Node,
    {
      readonly result: SemanticReturnedReferenceResult;
      readonly invocation: t.Node | undefined;
      readonly iterationUnknown: boolean;
      readonly ambientWrites: number;
      readonly dependencies: readonly {
        readonly binding: JavaScriptSemanticBindingState;
        readonly writes: number;
        readonly escapes: number;
      }[];
    }
  >();
  const objectTargets = new WeakMap<t.ObjectExpression, ObjectTargetIndex>();
  return (callee, invocation, callFrame) => {
    const existing = callFrame === undefined ? results.get(callee) : undefined;
    if (
      existing !== undefined &&
      existing.invocation === invocation &&
      existing.iterationUnknown === state.arrayIterationUnknown &&
      existing.ambientWrites === state.ambientWriteEffects.length &&
      existing.dependencies.every(
        ({ binding, writes, escapes }) =>
          binding.memberWrites.length === writes &&
          binding.escapedPaths.length === escapes,
      )
    )
      return existing.result;
    const dependencies = new Map<
      JavaScriptSemanticBindingState,
      { readonly writes: number; readonly escapes: number }
    >();
    const functions = new Set<t.Function>();
    const callableInvocations = new Map<
      t.Function,
      JavaScriptSourceInvocationContext[]
    >();
    const widenedCallables = new Set<t.Function>();
    const work: Candidate[] = [];
    // A transition depends on the source read and current projection, not the
    // initializer history used to reach it. Keeping history out of the key lets
    // shared diamonds and reassignment cycles converge to the graph fixed point.
    const projectionDepths = new WeakMap<
      t.Node,
      Map<string, number | undefined>
    >();
    const expanded = new WeakMap<t.Node, Set<string>>();
    const includeResultMetadata = options?.includeResultMetadata === true;
    let additionalContexts = 0;
    let contextsWidened = false;
    let unresolvedCallable = false;
    const result: {
      references: readonly SemanticReturnedReference[];
      callables: ReadonlySet<t.Function>;
      callableInvocations?: ReadonlyMap<
        t.Function,
        readonly JavaScriptSourceInvocationContext[]
      >;
      widenedCallables?: ReadonlySet<t.Function>;
      precision: SemanticReturnedReferenceResult["precision"];
      unresolvedCallable?: boolean;
      unresolvedInvocation?: boolean;
    } = includeResultMetadata
      ? {
          references: [],
          callables: functions,
          callableInvocations,
          widenedCallables,
          precision: "exact",
        }
      : {
          references: [],
          callables: functions,
          precision: "exact",
        };
    // The invocation owner retains the actual callable receiver. A bare alias
    // of fn.call has lost that receiver and cannot execute fn by itself.
    const nativeArrayIteration = (array: t.ArrayExpression) =>
      semanticKnownArrayIterationAt(array, state);
    const sourceInvocation =
      invocation === undefined
        ? undefined
        : javaScriptSourceInvocationContext(invocation, nativeArrayIteration);
    const sourceGenericInvocation =
      invocation !== undefined &&
      javaScriptGenericInvocationMethod(
        t.isTaggedTemplateExpression(invocation)
          ? invocation.tag
          : invocation.callee,
      ) !== undefined;
    const inheritedInvocationChanged = (method: "call" | "apply"): boolean => {
      if (invocation === undefined) return false;
      const inheritedPath = ["global", "Function", "prototype", method];
      return state.ambientWriteEffects.some(
        (effect) =>
          effect.path.length <= inheritedPath.length &&
          effect.path.every(
            (key, index) =>
              key === null ||
              semanticPropertyPathKeyMatches(key, inheritedPath[index] ?? ""),
          ) &&
          semanticEffectTiming(invocation, effect.node, state) !== "after",
      );
    };
    // Exact finite alternatives retain unrelated keys and cross-path
    // correlations. Growing/shrinking cycles still converge at any depth;
    // selector-budget widening retains the complete may-target closure.
    const selections = new SemanticAliasSelections(() => {
      state.valueResourceLimits.add("alias-selections");
      result.precision = "widened";
    }, state.precision.alias_selections);
    const enqueue = (candidate: Candidate): void => {
      const source = unwrapJavaScriptExpression(candidate.node).node;
      let { path, capturedSelections } = candidate;
      const { readAt } = candidate;
      let invocationContext = candidate.invocation;
      let frame = candidate.frame;
      if (contextsWidened) {
        path = undefined;
        capturedSelections = undefined;
        invocationContext = undefined;
        frame = undefined;
      }
      const invocationKey = () =>
        invocationContext === undefined
          ? null
          : [
              invocationContext.receiver?.start,
              invocationContext.receiver?.end,
              invocationContext.receiverUnknown,
              invocationContext.arguments?.map((argument) => [
                argument.start,
                argument.end,
              ]),
            ];
      let readKey = JSON.stringify([
        readAt?.start ?? -1,
        readAt?.end ?? -1,
        invocationKey(),
        frame?.id ?? 0,
      ]);
      const depths = projectionDepths.get(source) ?? new Map();
      projectionDepths.set(source, depths);
      if (!depths.has(readKey)) {
        depths.set(readKey, path?.length);
      } else {
        const previous = depths.get(readKey);
        if (previous === undefined || previous !== path?.length) {
          if (previous !== undefined) result.precision = "widened";
          depths.set(readKey, undefined);
          path = undefined;
        }
      }
      if (path !== undefined) path = selections.normalize(source, path);
      capturedSelections =
        path === undefined
          ? undefined
          : semanticNormalizeCapturedSelections(
              capturedSelections,
              path.length,
            );
      const expansionKey = () =>
        JSON.stringify([
          readKey,
          path ?? null,
          capturedSelections?.map(({ at, depth, ownEnumerable }) => [
            at.start,
            at.end,
            depth,
            ownEnumerable,
          ]),
        ]);
      let key = expansionKey();
      const paths = expanded.get(source) ?? new Set<string>();
      if (paths.has(key)) return;
      // Copy/invocation contexts add selector dimensions. Bound them by the
      // same query budget, then visit the complete unknown-projection closure.
      if (
        !contextsWidened &&
        (capturedSelections !== undefined ||
          invocationContext !== undefined ||
          frame !== undefined) &&
        paths.size > 0 &&
        ++additionalContexts > state.precision.alias_selections
      ) {
        contextsWidened = true;
        state.valueResourceLimits.add("alias-selections");
        result.precision = "widened";
        // Generic transitions select only the source receiver and authored
        // argument values. Keep that complete finite source closure when their
        // precise positional contexts merge, including later callable receivers.
        if (sourceInvocation !== undefined) {
          if (sourceInvocation.receiver !== undefined)
            enqueue({ node: sourceInvocation.receiver, path: undefined });
          for (const argument of sourceInvocation.arguments ?? [])
            if (t.isExpression(argument))
              enqueue({ node: argument, path: undefined });
            else if (t.isSpreadElement(argument))
              enqueue({ node: argument.argument, path: undefined });
        }
        enqueueWidenedCallFrames(callFrame, frame, enqueue);
      }
      if (contextsWidened) {
        unresolvedCallable = true;
        path = undefined;
        capturedSelections = undefined;
        invocationContext = undefined;
        frame = undefined;
        readKey = JSON.stringify([
          readAt?.start ?? -1,
          readAt?.end ?? -1,
          null,
          0,
        ]);
        if (sourceGenericInvocation) result.unresolvedInvocation = true;
        depths.set(readKey, undefined);
        key = expansionKey();
        if (paths.has(key)) return;
      }
      paths.add(key);
      expanded.set(source, paths);
      work.push({
        node: source,
        path,
        ...(readAt === undefined ? {} : { readAt }),
        ...(capturedSelections === undefined ? {} : { capturedSelections }),
        ...(invocationContext === undefined
          ? {}
          : { invocation: invocationContext }),
        ...(frame === undefined ? {} : { frame }),
      });
    };
    enqueue({
      node: callee,
      path: [],
      invocation: sourceInvocation,
      frame: callFrame,
    });
    while (work.length > 0) {
      const current = work.pop();
      if (current === undefined) break;
      const { node } = current;
      if (current.path === undefined) unresolvedCallable = true;
      // An exact empty selection with an invocation is the value being called,
      // not a container whose callable children are potential escape targets.
      // Ordinary objects and arrays cannot supply that callable receiver. An
      // unknown projection still visits the full closure after budget widening.
      if (
        (current.invocation !== undefined ||
          consumption !== "potential-reference") &&
        current.path?.length === 0 &&
        (t.isObjectExpression(node) || t.isArrayExpression(node))
      )
        continue;
      const pending: Candidate[] = [];
      if (t.isIdentifier(node)) {
        if (semanticResolutionBlocked(state, node, node.name)) {
          unresolvedCallable = true;
          if (sourceGenericInvocation && current.path?.length === 0)
            result.unresolvedInvocation = true;
          continue;
        }
        const binding = resolveSemanticBindingState(state, node, node.name);
        if (binding === undefined) {
          unresolvedCallable = true;
          if (sourceGenericInvocation && current.path?.length === 0)
            result.unresolvedInvocation = true;
          continue;
        }
        dependencies.set(binding, {
          writes: binding.memberWrites.length,
          escapes: binding.escapedPaths.length,
        });
        if (
          binding.directOrigins.length > 0 ||
          semanticOpaqueBindingReadMayHaveChanged(binding, node, state)
        )
          unresolvedCallable = true;
        const matchedFrame = findParameterCallFrame(
          binding.bindingId,
          current.frame,
        );
        if (current.path !== undefined) {
          const strictFacts = semanticProjectedSourceFactsAtRead(
            binding,
            node,
            current.path,
            state,
            true,
            // The current invocation receives its callee before its own
            // opaque effects; earlier captured member reads keep their site.
            invocation !== undefined &&
              current.readAt ===
                unwrapJavaScriptExpression(
                  t.isTaggedTemplateExpression(invocation)
                    ? invocation.tag
                    : invocation.callee,
                ).node
              ? invocation
              : (current.readAt ?? node),
            current.capturedSelections,
          );
          const hasDefiniteInitializer =
            semanticBindingAtRead(binding, node, state)
              .hasDefiniteInitializer ||
            semanticStableBindingInitializedBeforeRead(binding, node, state);
          const retainsParameterOrigin =
            !hasDefiniteInitializer &&
            (current.path.length === 0 || strictFacts?.retainsOrigin === true);
          const frameExpansion =
            matchedFrame !== undefined && retainsParameterOrigin
              ? expandFrameParameterCandidates(
                  binding,
                  current,
                  matchedFrame,
                  state,
                )
              : undefined;
          const originResolved =
            hasDefiniteInitializer || frameExpansion?.originResolved === true;
          if (current.path.length === 0) {
            if (!originResolved) unresolvedCallable = true;
          } else if (strictFacts === undefined) {
            unresolvedCallable = true;
            if (sourceGenericInvocation) result.unresolvedInvocation = true;
          } else if (strictFacts.retainsOrigin && !originResolved)
            unresolvedCallable = true;
          const selectedSources = semanticProjectedSourcesAtRead(
            binding,
            node,
            current.path,
            state,
            false,
            current.readAt ?? node,
            current.capturedSelections,
          );
          if (selectedSources !== undefined) {
            for (const source of selectedSources) {
              if (matchedFrame?.inactiveDefaultNodes.has(source.node)) continue;
              const capturedSelections = [
                ...(semanticShiftCapturedSelections(
                  current.capturedSelections,
                  source.path.length - current.path.length,
                ) ?? []),
                ...(source.capturedSelections ?? []),
              ];
              pending.push({
                ...source,
                ...(current.path.length === 0
                  ? {}
                  : { readAt: current.readAt ?? node }),
                ...(capturedSelections.length === 0
                  ? {}
                  : { capturedSelections }),
                frame: current.frame,
              });
            }
            if (frameExpansion !== undefined)
              pending.push(...frameExpansion.candidates);
            for (let index = pending.length - 1; index >= 0; index--) {
              const child = pending[index];
              if (child !== undefined)
                enqueue({
                  ...child,
                  invocation: child.invocation ?? current.invocation,
                });
            }
            continue;
          }
          result.precision = "widened";
          unresolvedCallable = true;
          if (sourceGenericInvocation) result.unresolvedInvocation = true;
        }
        const selected = semanticBindingAtRead(binding, node, state).binding;
        for (const initializer of [
          ...selected.initializers,
          ...selected.referenceInitializers,
        ]) {
          if (matchedFrame?.inactiveDefaultNodes.has(initializer.node))
            continue;
          if (semanticReferenceSourcesInactive(initializer, state)) continue;
          pending.push({
            node: initializer.node,
            path:
              current.path === undefined
                ? undefined
                : [...initializer.projection, ...current.path],
            ...(current.path?.length === 0
              ? {}
              : { readAt: current.readAt ?? node }),
            ...(current.capturedSelections === undefined
              ? {}
              : {
                  capturedSelections: semanticShiftCapturedSelections(
                    current.capturedSelections,
                    initializer.projection.length,
                  ),
                }),
            frame: current.frame,
          });
        }
        if (matchedFrame !== undefined)
          pending.push(
            ...expandFrameParameterCandidates(
              binding,
              current,
              matchedFrame,
              state,
            ).candidates,
          );
        if (current.path === undefined)
          for (const effect of binding.memberWrites)
            for (const source of effect.assignedSources ?? [])
              if (!semanticReferenceSourcesInactive(source, state))
                pending.push({
                  node: source.node,
                  path: undefined,
                  frame: current.frame,
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
          if (t.isOptionalMemberExpression(receiver)) unresolvedCallable = true;
          const segment = semanticStaticPropertyKey(
            receiver.property,
            receiver.computed,
          );
          if (segment === null) unresolvedCallable = true;
          path.push(segment);
          receiver = unwrapJavaScriptExpression(receiver.object).node;
        }
        pending.push({
          ...current,
          node: receiver,
          readAt: current.readAt ?? node,
          ...(current.capturedSelections === undefined
            ? {}
            : {
                capturedSelections: semanticShiftCapturedSelections(
                  current.capturedSelections,
                  path.length,
                ),
              }),
          path:
            current.path === undefined
              ? undefined
              : [...path.reverse(), ...current.path],
        });
      } else if (
        t.isConditionalExpression(node) ||
        t.isLogicalExpression(node)
      ) {
        for (const branch of evaluateSemanticSelectedBranches(node, state))
          pending.push({ ...current, node: branch });
      } else if (t.isSequenceExpression(node)) {
        const last = node.expressions.at(-1);
        if (last !== undefined) pending.push({ ...current, node: last });
        else unresolvedCallable = true;
      } else if (t.isFunction(node)) {
        if (current.path === undefined || current.path.length === 0) {
          functions.add(node);
          if (current.path === undefined || current.invocation === undefined) {
            if (invocation !== undefined) widenedCallables.add(node);
          } else {
            const existingContexts = callableInvocations.get(node) ?? [];
            existingContexts.push(current.invocation);
            callableInvocations.set(node, existingContexts);
          }
        } else if (
          current.invocation !== undefined &&
          current.path.every((key) =>
            semanticAliasSelectionChoices(key).every(
              (choice) => choice === "call" || choice === "apply",
            ),
          )
        ) {
          // Own member writes have already selected their actual RHS above.
          // Only a remaining inherited invocation member reaches this branch.
          const methods = semanticAliasSelectionChoices(
            current.path.at(-1)!,
          ).filter(
            (method): method is "call" | "apply" =>
              method === "call" || method === "apply",
          );
          if (methods.length === 0) unresolvedCallable = true;
          for (const method of methods) {
            const selected = resolveJavaScriptGenericInvocation(
              method,
              current.invocation,
              nativeArrayIteration,
            );
            if (selected !== undefined)
              pending.push({
                node: selected.callable,
                path: [],
                invocation: selected.context,
                frame: callFrame,
              });
            else {
              unresolvedCallable = true;
              if (current.invocation.receiverUnknown)
                result.unresolvedInvocation = true;
            }
            if (inheritedInvocationChanged(method)) {
              unresolvedCallable = true;
              result.unresolvedInvocation = true;
            }
          }
        } else {
          unresolvedCallable = true;
        }
      } else if (t.isObjectExpression(node))
        selectObjectTargets(node, current, pending, objectTargets, () => {
          unresolvedCallable = true;
        });
      else if (t.isArrayExpression(node)) {
        const [key, ...path] = current.path ?? [];
        if (current.path !== undefined && key !== undefined) {
          const definiteElementHit = semanticAliasSelectionChoices(key).every(
            (choice) => {
              if (choice === null || typeof choice === "object") return false;
              const idx = semanticArrayIndex(choice);
              return (
                idx !== null &&
                idx < node.elements.length &&
                node.elements[idx] !== null &&
                node.elements[idx] !== undefined &&
                !node.elements
                  .slice(0, idx + 1)
                  .some(
                    (element) => element !== null && t.isSpreadElement(element),
                  )
              );
            },
          );
          if (!definiteElementHit) unresolvedCallable = true;
          for (const choice of semanticAliasSelectionChoices(key))
            for (const source of semanticArrayPropertyReferences(node, [
              choice,
            ])) {
              let projection = source.path;
              if (
                source.capturedSelectionAt !== undefined &&
                !semanticKnownArrayIteration(
                  semanticSelectedReferenceSlot(
                    { node: source.node, projection: [] },
                    state,
                    source.capturedSelectionAt,
                  )?.value,
                  state,
                )
              )
                projection = [null, ...source.path.slice(1)];
              const selectedPath = [...projection, ...path];
              pending.push({
                ...current,
                node: source.node,
                path: selectedPath,
                capturedSelections: [
                  ...(semanticShiftCapturedSelections(
                    current.capturedSelections,
                    selectedPath.length - current.path.length,
                  ) ?? []),
                  ...(source.capturedSelectionAt === undefined
                    ? []
                    : [{ at: source.capturedSelectionAt, depth: 1 }]),
                ],
              });
            }
          for (let index = pending.length - 1; index >= 0; index--) {
            const child = pending[index];
            if (child !== undefined)
              enqueue({
                ...child,
                invocation: child.invocation ?? current.invocation,
              });
          }
          continue;
        }
        let uncertainOffset = false;
        node.elements.forEach((element, offset) => {
          if (element === null) return;
          if (t.isSpreadElement(element)) {
            uncertainOffset = true;
            pending.push({
              ...current,
              node: element.argument,
              path: current.path === undefined ? undefined : [null, ...path],
              capturedSelections: [
                ...(current.capturedSelections ?? []),
                { at: element.argument, depth: 1 },
              ],
            });
          } else if (
            current.path === undefined ||
            key === undefined ||
            uncertainOffset ||
            semanticAliasSelectionChoices(key).some((choice) =>
              semanticPropertyPathKeyMatches(choice, String(offset)),
            )
          )
            pending.push({
              ...current,
              node: element,
              path: current.path === undefined ? undefined : path,
              capturedSelections:
                semanticShiftCapturedSelections(
                  current.capturedSelections,
                  -1,
                ) ?? [],
            });
        });
      } else if (t.isNewExpression(node)) {
        unresolvedCallable = true;
        pending.push({ ...current, node: node.callee });
      } else if (t.isClass(node)) {
        if (current.path === undefined || current.path.length > 0)
          unresolvedCallable = true;
        const [key, ...path] = current.path ?? [];
        for (const member of node.body.body) {
          if (t.isClassMethod(member)) {
            if (
              ((current.path === undefined || current.path.length === 0) &&
                member.kind === "constructor") ||
              current.path === undefined ||
              (key !== undefined &&
                semanticAliasSelectionChoices(key).some((choice) => {
                  const name = semanticStaticPropertyKey(
                    member.key,
                    member.computed,
                  );
                  return (
                    name === null ||
                    semanticPropertyPathKeyMatches(choice, name)
                  );
                }))
            )
              pending.push({
                ...current,
                node: member,
                path: current.path === undefined ? undefined : path,
                capturedSelections: semanticShiftCapturedSelections(
                  current.capturedSelections,
                  -1,
                ),
              });
          } else if (
            t.isClassProperty(member) &&
            member.value !== null &&
            member.value !== undefined &&
            (key !== undefined || current.path === undefined) &&
            (current.path === undefined ||
              (key !== undefined &&
                semanticAliasSelectionChoices(key).some((choice) => {
                  const name = semanticStaticPropertyKey(
                    member.key,
                    member.computed,
                  );
                  return (
                    name === null ||
                    semanticPropertyPathKeyMatches(choice, name)
                  );
                })))
          )
            pending.push({
              ...current,
              node: member.value,
              path: current.path === undefined ? undefined : path,
              capturedSelections: semanticShiftCapturedSelections(
                current.capturedSelections,
                -1,
              ),
            });
        }
        if (node.superClass !== null && node.superClass !== undefined)
          pending.push({ ...current, node: node.superClass });
      } else if (t.isThisExpression(node)) {
        if (!enqueueThisReceiverCandidates(node, current, state, pending))
          unresolvedCallable = true;
      } else if (
        current.path?.length !== 0 ||
        !isDefinitelyDefinedNonCallableLeaf(node)
      ) {
        unresolvedCallable = true;
      }
      for (let index = pending.length - 1; index >= 0; index--) {
        const child = pending[index];
        if (child !== undefined)
          enqueue({
            ...child,
            invocation: child.invocation ?? current.invocation,
          });
      }
    }
    const output = [...functions].flatMap((callable) => {
      // A direct generator/async call produces a fresh iterator/Promise, not
      // the yielded/resolved contents. Escape analysis still retains those
      // potential references for their eventual consumers.
      const resultKind = semanticCallableResultKind(callable);
      if (
        consumption !== "potential-reference" &&
        (resultKind === "iterator" ||
          resultKind === "async-iterator" ||
          (consumption === "direct-call" && resultKind === "promise"))
      )
        return [];
      return semanticCallableResultExpressions(callable).flatMap(
        ({ node, delegated, kind }) =>
          node === null ||
          (consumption !== "potential-reference" && kind !== "return")
            ? []
            : [
                includeResultMetadata
                  ? {
                      node,
                      projection: delegated ? [null] : [],
                      kind,
                      resultKind,
                    }
                  : { node, projection: delegated ? [null] : [] },
              ],
      );
    });
    result.references = output;
    if (includeResultMetadata && unresolvedCallable)
      result.unresolvedCallable = true;
    if (callFrame === undefined)
      results.set(callee, {
        result,
        invocation,
        iterationUnknown: state.arrayIterationUnknown,
        ambientWrites: state.ambientWriteEffects.length,
        dependencies: [...dependencies].map(([binding, counts]) => ({
          binding,
          ...counts,
        })),
      });
    if (result.precision === "widened")
      state.returnedReferenceWidenings.add(callee);
    return result;
  };
};

const enqueueWidenedCallFrames = (
  rootFrame: SemanticReturnedReferenceCallFrame | undefined,
  activeFrame: SemanticReturnedReferenceCallFrame | undefined,
  enqueue: (candidate: Candidate) => void,
): void => {
  const seen = new Set<number>();
  for (const start of [rootFrame, activeFrame]) {
    for (let frame = start; frame !== undefined; frame = frame.parentFrame) {
      if (seen.has(frame.id)) break;
      seen.add(frame.id);
      for (const sources of frame.parameterSources.values())
        for (const source of sources)
          enqueue({ node: source.node, path: undefined });
      for (const receiver of frame.receiverSources)
        enqueue({ node: receiver, path: undefined });
    }
  }
};

const findParameterCallFrame = (
  bindingId: string,
  callFrame: SemanticReturnedReferenceCallFrame | undefined,
): SemanticReturnedReferenceCallFrame | undefined => {
  for (let frame = callFrame; frame !== undefined; frame = frame.parentFrame)
    if (frame.parameterSources.has(bindingId)) return frame;
  return undefined;
};

const isDefinitelyUndefinedParameterArg = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const unwrapped = unwrapJavaScriptExpression(node).node;
  if (t.isUnaryExpression(unwrapped, { operator: "void" })) return true;
  return (
    t.isIdentifier(unwrapped, { name: "undefined" }) &&
    !semanticResolutionBlocked(state, unwrapped, "undefined") &&
    resolveSemanticBindingState(state, unwrapped, "undefined") === undefined
  );
};

const selectFrameParameterPaths = (
  argSource: SemanticCallFrameParameterSource,
  fullPath: SemanticAliasSelectionPath,
): readonly SemanticAliasSelectionPath[] => {
  if (argSource.restElementIndex !== undefined) {
    if (fullPath.length === 0) return [];
    const [firstSegment, ...remaining] = fullPath;
    if (
      firstSegment === undefined ||
      !semanticAliasSelectionChoices(firstSegment).some(
        (choice) =>
          choice === null ||
          typeof choice === "number" ||
          semanticArrayIndex(String(choice)) !== null,
      )
    )
      return [];
    if (
      argSource.restElementIndex !== null &&
      !semanticAliasSelectionChoices(firstSegment).some((choice) =>
        semanticPropertyPathKeyMatches(
          choice,
          String(argSource.restElementIndex),
        ),
      )
    )
      return [];
    return [[...argSource.projection, ...remaining]];
  }
  if (argSource.copyProjectionOffset !== undefined) {
    const [key, ...remaining] = fullPath;
    const paths: SemanticAliasSelectionPath[] = [];
    for (const choice of key === undefined
      ? [undefined]
      : semanticAliasSelectionChoices(key)) {
      const copied = semanticCopiedReferencePath(
        argSource,
        choice === undefined ? [] : [choice],
        "identity",
      );
      if (copied !== null) paths.push([...copied, ...remaining]);
    }
    return paths;
  }
  return [[...argSource.projection, ...fullPath]];
};

const expandFrameParameterCandidates = (
  binding: JavaScriptSemanticBindingState,
  current: Candidate,
  matchedFrame: SemanticReturnedReferenceCallFrame,
  state: JavaScriptSemanticAnalysisState,
): {
  readonly candidates: readonly Candidate[];
  readonly originResolved: boolean;
} => {
  const mappedArgs = matchedFrame.parameterSources.get(binding.bindingId) ?? [];
  if (current.path === undefined) {
    return {
      candidates: mappedArgs.map((argSource) => ({
        node: argSource.node,
        path: undefined,
        readAt: matchedFrame.callReadAt,
        invocation: current.invocation,
        frame: matchedFrame.parentFrame,
      })),
      originResolved: false,
    };
  }
  const hasActiveDefault = [
    ...binding.initializers,
    ...binding.referenceInitializers,
  ].some(
    (init) =>
      !matchedFrame.inactiveDefaultNodes.has(init.node) &&
      !semanticReferenceSourcesInactive(init, state),
  );
  const candidates: Candidate[] = [];
  let matchedAnyArg = false;
  let hasUncertainArg = false;
  for (const argSource of mappedArgs) {
    if (
      hasActiveDefault &&
      argSource.projection.length === 0 &&
      isDefinitelyUndefinedParameterArg(argSource.node, state)
    )
      continue;
    if (
      argSource.restElementIndex === null ||
      (argSource.copyProjectionOffset === undefined &&
        argSource.projection.some((seg) => seg === null))
    )
      hasUncertainArg = true;
    for (const selectedPath of selectFrameParameterPaths(
      argSource,
      current.path,
    )) {
      matchedAnyArg = true;
      const capturedSelections = [
        ...(semanticShiftCapturedSelections(
          current.capturedSelections,
          selectedPath.length - current.path.length,
        ) ?? []),
        ...(argSource.capturedSelections ?? []),
      ];
      candidates.push({
        node: argSource.node,
        path: selectedPath,
        readAt: matchedFrame.callReadAt,
        ...(capturedSelections.length === 0 ? {} : { capturedSelections }),
        invocation: current.invocation,
        frame: matchedFrame.parentFrame,
      });
    }
  }
  return {
    candidates,
    originResolved:
      !matchedFrame.hasOpaqueArguments &&
      !hasUncertainArg &&
      (matchedAnyArg || hasActiveDefault),
  };
};

const enqueueThisReceiverCandidates = (
  node: t.ThisExpression,
  current: Candidate,
  state: JavaScriptSemanticAnalysisState,
  pending: Candidate[],
): boolean => {
  let cursor = state.parentsByNode.get(node);
  let child: t.Node = node;
  let owner: t.Function | undefined;
  while (cursor !== undefined) {
    if (
      t.isFunction(cursor) &&
      !t.isArrowFunctionExpression(cursor) &&
      !semanticMethodDefinitionExpression(cursor, child)
    ) {
      owner = cursor;
      break;
    }
    child = cursor;
    cursor = state.parentsByNode.get(cursor);
  }
  if (owner === undefined) return false;
  for (
    let frame = current.frame;
    frame !== undefined;
    frame = frame.parentFrame
  ) {
    if (!frame.receiverCallables.has(owner)) continue;
    if (frame.hasOpaqueArguments || frame.receiverSources.length === 0)
      return false;
    for (const receiverSource of frame.receiverSources)
      pending.push({
        ...current,
        node: receiverSource,
        readAt: frame.callReadAt,
        frame: frame.parentFrame,
      });
    return true;
  }
  return false;
};

const isDefinitelyDefinedNonCallableLeaf = (node: t.Node): boolean =>
  t.isStringLiteral(node) ||
  t.isNumericLiteral(node) ||
  t.isBooleanLiteral(node) ||
  t.isBigIntLiteral(node) ||
  t.isNullLiteral(node) ||
  t.isRegExpLiteral(node) ||
  t.isTemplateLiteral(node);

const selectObjectTargets = (
  node: t.ObjectExpression,
  item: Candidate,
  pending: Candidate[],
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
  markUnresolved: () => void,
): void => {
  const [key, ...path] = item.path ?? [];
  const childPath = item.path === undefined ? undefined : path;
  if (key !== null && typeof key === "object" && "alternatives" in key) {
    for (const choice of semanticAliasSelectionChoices(key))
      selectObjectTargets(
        node,
        { ...item, path: [choice, ...path] },
        pending,
        indexes,
        markUnresolved,
      );
    return;
  }
  if (key !== null && key !== undefined && typeof key !== "object") {
    const index = objectTargetIndex(node, indexes);
    const property = index.propertyByName.get(String(key));
    if (property !== undefined) {
      const isPrototypeSetter =
        t.isObjectProperty(property) &&
        !property.computed &&
        !property.shorthand &&
        String(key) === "__proto__";
      const isAccessor =
        t.isObjectMethod(property) && property.kind !== "method";
      if (isPrototypeSetter || isAccessor) markUnresolved();
      const unknowns: ObjectTargetUnknown[] = [];
      for (
        let unknown = index.trailingUnknownsByProperty.get(property);
        unknown !== undefined;
        unknown = unknown.previous
      )
        unknowns.push(unknown);
      if (unknowns.length > 0) markUnresolved();
      for (const { node: unknown } of unknowns.reverse())
        pending.push({
          ...item,
          node: t.isSpreadElement(unknown)
            ? unknown.argument
            : t.isObjectProperty(unknown)
              ? unknown.value
              : unknown,
          ...(t.isSpreadElement(unknown) ? {} : { path: childPath }),
          capturedSelections: t.isSpreadElement(unknown)
            ? [
                ...(item.capturedSelections ?? []),
                { at: unknown.argument, depth: 1, ownEnumerable: true },
              ]
            : (semanticShiftCapturedSelections(item.capturedSelections, -1) ??
              []),
        });
      pending.push({
        ...item,
        node: t.isObjectProperty(property) ? property.value : property,
        path: childPath,
        capturedSelections:
          semanticShiftCapturedSelections(item.capturedSelections, -1) ?? [],
      });
      return;
    }
  }
  if (item.path === undefined || item.path.length > 0) markUnresolved();
  let replaced = false;
  for (const property of [...node.properties].reverse()) {
    if (replaced) break;
    if (t.isSpreadElement(property)) {
      pending.push({
        ...item,
        node: property.argument,
        capturedSelections: [
          ...(item.capturedSelections ?? []),
          { at: property.argument, depth: 1, ownEnumerable: true },
        ],
      });
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (
      key !== null &&
      key !== undefined &&
      name !== null &&
      !semanticPropertyPathKeyMatches(key, name)
    )
      continue;
    if (t.isObjectProperty(property))
      pending.push({
        ...item,
        node: property.value,
        path: childPath,
        capturedSelections:
          semanticShiftCapturedSelections(item.capturedSelections, -1) ?? [],
      });
    else
      pending.push({
        ...item,
        node: property,
        path: childPath,
        capturedSelections:
          semanticShiftCapturedSelections(item.capturedSelections, -1) ?? [],
      });
    if (
      key !== null &&
      key !== undefined &&
      typeof key !== "object" &&
      name === String(key)
    )
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
