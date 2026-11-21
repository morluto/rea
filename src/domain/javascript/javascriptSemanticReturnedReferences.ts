import * as t from "@babel/types";
import {
  semanticAmbientEffectGeneration,
  semanticBindingEffectGeneration,
  semanticMemberWriteSources,
} from "./javascriptSemanticEffectLog.js";
import { semanticGlobalCodeSites } from "./javascriptSemanticEffectRecord.js";
import { intrinsicPrototypeMemberMayHaveChanged } from "./javascriptSemanticIntrinsicInstances.js";

import {
  semanticStaticPropertyKey,
  staticJavaScriptTruthiness,
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
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticReferenceSourcesInactive,
  semanticKnownArrayIteration,
  semanticKnownArrayIterationAt,
  semanticSelectedReferenceSlot,
} from "./javascriptSemanticReferenceSources.js";
import {
  semanticArrayPropertyReferences,
  semanticObjectPropertyReferences,
  semanticClassPropertyReferences,
} from "./javascriptSemanticObjectReferences.js";
import {
  semanticCapturedSelectionsAfterPropertyRead,
  semanticNormalizeCapturedSelections,
  semanticProjectedSourcesAtRead,
  semanticShiftCapturedSelections,
  type SemanticCapturedSelection,
} from "./javascriptSemanticProjectedSources.js";
import {
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  SemanticAliasSelections,
  semanticAliasSelectionChoices,
  type SemanticAliasSelectionPath,
} from "./javascriptSemanticAliasSelections.js";
import { semanticDirectInvocationArgument } from "./javascriptSemanticDirectInvocations.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";

/** A reference potentially handed to a caller or generator consumer. */
export interface SemanticReturnedReference {
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
}

interface Candidate {
  readonly node: t.Node;
  /** `undefined` means any projection depth after different projection depths merge. */
  readonly path: SemanticAliasSelectionPath | undefined;
  /** Member selection happens at its use, while a captured function keeps its read. */
  readonly readAt?: t.Node;
  readonly capturedSelections?:
    | readonly SemanticCapturedSelection[]
    | undefined;
  readonly invocation?: JavaScriptSourceInvocationContext;
  readonly classKind?: "instance" | "static";
}

export interface SemanticReturnedReferenceResult {
  readonly references: readonly SemanticReturnedReference[];
  /** Source-local callable targets resolved by the same binding/projection owner. */
  readonly callables: ReadonlySet<t.Function>;
  /** Source calls whose result can be selected as the callable. */
  readonly calleeCallResults?: ReadonlySet<t.CallExpression>;
  /** A visible invocation-method mutation prevents a source-local result proof. */
  readonly unresolvedInvocation?: boolean;
  /** Both states close the supported source-local may-target graph. Widened joins projections without dropping represented targets; it does not claim runtime completeness. */
  readonly precision: "exact" | "widened";
}

type SelectedSource = Pick<Candidate, "path" | "readAt" | "capturedSelections">;

interface SemanticReturnedReferenceReader {
  (
    callee: t.Node,
    invocation?: t.CallExpression | t.OptionalCallExpression,
    selected?: SelectedSource,
  ): SemanticReturnedReferenceResult;
  /** Whether the callee-only read depends on live ambient effects. */
  readonly observesAmbientEffects: (callee: t.Node) => boolean;
}

/** Resolve local result references conservatively, without claiming call execution. */
export const createSemanticReturnedReferences = (
  state: JavaScriptSemanticAnalysisState,
  consumption:
    | "potential-reference"
    | "direct-call"
    | "awaited-call" = "potential-reference",
): SemanticReturnedReferenceReader => {
  const results = new WeakMap<
    t.Node,
    {
      readonly result: SemanticReturnedReferenceResult;
      readonly invocation: t.Node | undefined;
      readonly iterationUnknown: boolean;
      readonly ambientGeneration: number | undefined;
      readonly opaqueSites: number;
      readonly dependencies: readonly {
        readonly binding: JavaScriptSemanticBindingState;
        readonly generation: number;
      }[];
    }
  >();
  const resolve = (
    callee: t.Node,
    invocation?: t.CallExpression | t.OptionalCallExpression,
    selected?: SelectedSource,
  ): SemanticReturnedReferenceResult => {
    const existing = selected === undefined ? results.get(callee) : undefined;
    if (
      existing !== undefined &&
      existing.invocation === invocation &&
      existing.iterationUnknown === state.arrayIterationUnknown &&
      existing.opaqueSites === semanticGlobalCodeSites(state).length &&
      (existing.ambientGeneration === undefined ||
        existing.ambientGeneration ===
          semanticAmbientEffectGeneration(state, "contents")) &&
      existing.dependencies.every(
        ({ binding, generation }) =>
          semanticBindingEffectGeneration(binding) === generation,
      )
    )
      return existing.result;
    // Plain lexical alias and callable walks depend on binding generations.
    // Only transitions that can consult live ambient effects require their
    // generation too; recording an unrelated ambient effect does not change
    // the syntax or binding identity of a plain callable.
    let readsAmbientEffects = invocation !== undefined;
    const dependencies = new Map<JavaScriptSemanticBindingState, number>();
    const functions = new Set<t.Function>();
    const work: Candidate[] = [];
    // A transition depends on the source read and current projection, not the
    // initializer history used to reach it. Keeping history out of the key lets
    // shared diamonds and reassignment cycles converge to the graph fixed point.
    const projectionDepths = new WeakMap<
      t.Node,
      Map<string, { depth: number | undefined }>
    >();
    const expanded = new WeakMap<t.Node, Set<string>>();
    let additionalContexts = 0;
    let contextsWidened = false;
    const result: {
      references: readonly SemanticReturnedReference[];
      callables: ReadonlySet<t.Function>;
      calleeCallResults?: Set<t.CallExpression>;
      precision: SemanticReturnedReferenceResult["precision"];
      unresolvedInvocation?: boolean;
    } = { references: [], callables: functions, precision: "exact" };
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
      javaScriptGenericInvocationMethod(invocation.callee) !== undefined;
    const inheritedInvocationChanged = (method: "call" | "apply"): boolean =>
      invocation !== undefined &&
      intrinsicPrototypeMemberMayHaveChanged(
        state,
        "Function",
        method,
        invocation,
      );
    // Exact finite alternatives retain unrelated keys and cross-path
    // correlations. Growing/shrinking cycles still converge at any depth;
    // selector-budget widening retains the complete may-target closure.
    const selections = new SemanticAliasSelections(() => {
      state.valueResourceLimits.add("alias-selections");
      result.precision = "widened";
    }, state.precision.alias_selections);
    const enqueue = (
      node: t.Node,
      path: Candidate["path"],
      readAt?: t.Node,
      capturedSelections?: readonly SemanticCapturedSelection[],
      invocationContext?: JavaScriptSourceInvocationContext,
      classKind?: Candidate["classKind"],
    ): void => {
      const source = unwrapJavaScriptExpression(node).node;
      if (contextsWidened) {
        path = undefined;
        capturedSelections = undefined;
        invocationContext = undefined;
      }
      const invocationKey = () =>
        invocationContext === undefined
          ? null
          : [
              invocationContext.receiver?.start,
              invocationContext.receiver?.end,
              invocationContext.receiverUnknown,
              // Parser recovery retains null argument slots; keep their index.
              invocationContext.arguments?.map((argument) => [
                argument?.start,
                argument?.end,
              ]),
            ];
      let readKey = JSON.stringify([
        readAt?.start ?? -1,
        readAt?.end ?? -1,
        invocationKey(),
        classKind,
      ]);
      const depths = projectionDepths.get(source) ?? new Map();
      projectionDepths.set(source, depths);
      let context = depths.get(readKey);
      if (context === undefined) {
        context = { depth: path?.length };
        depths.set(readKey, context);
      } else if (
        context.depth === undefined ||
        context.depth !== path?.length
      ) {
        if (context.depth !== undefined) result.precision = "widened";
        context.depth = undefined;
        path = undefined;
      }
      // Selector joins share the transition's read/invocation/receiver context.
      // Joining only by syntax would cross static and instance member names.
      if (path !== undefined) path = selections.normalize(context, path);
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
        (capturedSelections !== undefined || invocationContext !== undefined) &&
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
            enqueue(sourceInvocation.receiver, undefined);
          for (const argument of sourceInvocation.arguments ?? [])
            if (t.isExpression(argument)) enqueue(argument, undefined);
            else if (t.isSpreadElement(argument))
              enqueue(argument.argument, undefined);
        }
      }
      if (contextsWidened) {
        path = undefined;
        capturedSelections = undefined;
        invocationContext = undefined;
        readKey = JSON.stringify([
          readAt?.start ?? -1,
          readAt?.end ?? -1,
          null,
          classKind,
        ]);
        if (sourceGenericInvocation) result.unresolvedInvocation = true;
        depths.set(readKey, { depth: undefined });
        key = expansionKey();
        if (paths.has(key)) return;
      }
      paths.add(key);
      expanded.set(source, paths);
      work.push({
        node: source,
        ...(classKind === undefined ? {} : { classKind }),
        path,
        ...(readAt === undefined ? {} : { readAt }),
        ...(capturedSelections === undefined ? {} : { capturedSelections }),
        ...(invocationContext === undefined
          ? {}
          : { invocation: invocationContext }),
      });
    };
    enqueue(
      callee,
      selected?.path ?? [],
      selected?.readAt,
      selected?.capturedSelections,
      sourceInvocation,
    );
    while (work.length > 0) {
      const current = work.pop();
      if (current === undefined) break;
      const { node } = current;
      // An exact empty selection with an invocation is the value being called,
      // not a container whose callable children are potential escape targets.
      // Ordinary objects and arrays cannot supply that callable receiver. An
      // unknown projection still visits the full closure after budget widening.
      if (
        current.invocation !== undefined &&
        current.path?.length === 0 &&
        (t.isObjectExpression(node) || t.isArrayExpression(node))
      )
        continue;
      const pending: Candidate[] = [];
      if (t.isIdentifier(node)) {
        const binding = resolveSemanticBindingState(state, node, node.name);
        if (binding === undefined) {
          if (sourceGenericInvocation && current.path?.length === 0)
            result.unresolvedInvocation = true;
          continue;
        }
        // Binding effects are fixed during this synchronous walk. Many
        // source reads can select the same binding at different captures;
        // record its cache dependencies once and still resolve every read.
        if (!dependencies.has(binding)) {
          const generation = semanticBindingEffectGeneration(binding);
          dependencies.set(binding, generation);
          if (!readsAmbientEffects)
            readsAmbientEffects =
              generation > 0 ||
              binding.initializers.some(
                ({ iterationSources }) => iterationSources !== undefined,
              ) ||
              binding.referenceInitializers.some(
                ({ iterationSources, fallbackSources, requiredSources }) =>
                  iterationSources !== undefined ||
                  fallbackSources !== undefined ||
                  requiredSources !== undefined,
              );
        }
        // A directly invoked function's parameter starts as its argument,
        // which therefore did not escape at the call.
        const argument = semanticDirectInvocationArgument(node, binding, state);
        if (argument !== undefined)
          enqueue(
            argument,
            current.path,
            current.path?.length === 0 ? undefined : (current.readAt ?? node),
            current.capturedSelections,
            current.invocation,
            current.classKind,
          );
        if (current.path !== undefined) {
          if (
            sourceGenericInvocation &&
            current.path.length > 0 &&
            semanticProjectedSourcesAtRead(
              binding,
              node,
              current.path,
              state,
              true,
              // The current invocation receives its callee before its own
              // opaque effects; earlier captured member reads keep their site.
              invocation !== undefined &&
                current.readAt ===
                  unwrapJavaScriptExpression(invocation.callee).node
                ? invocation
                : (current.readAt ?? node),
              current.capturedSelections,
            ) === undefined
          )
            result.unresolvedInvocation = true;
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
              });
            }
            for (let index = pending.length - 1; index >= 0; index--) {
              const child = pending[index];
              if (child !== undefined)
                enqueue(
                  child.node,
                  child.path,
                  child.readAt,
                  child.capturedSelections,
                  child.invocation ?? current.invocation,
                  child.classKind ?? current.classKind,
                );
            }
            continue;
          }
          result.precision = "widened";
          if (sourceGenericInvocation) result.unresolvedInvocation = true;
        }
        const selected = semanticBindingAtRead(binding, node, state).binding;
        for (const initializer of [
          ...selected.initializers,
          ...selected.referenceInitializers,
        ]) {
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
          });
        }
        if (current.path === undefined)
          for (const source of semanticMemberWriteSources(binding))
            if (!semanticReferenceSourcesInactive(source, state))
              pending.push({ node: source.node, path: undefined });
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
        const condition = t.isConditionalExpression(node)
          ? staticJavaScriptTruthiness(node.test)
          : undefined;
        if (condition !== false)
          pending.push({
            ...current,
            node: t.isConditionalExpression(node) ? node.consequent : node.left,
          });
        if (condition !== true)
          pending.push({
            ...current,
            node: t.isConditionalExpression(node) ? node.alternate : node.right,
          });
      } else if (t.isSequenceExpression(node)) {
        const last = node.expressions.at(-1);
        if (last !== undefined) pending.push({ ...current, node: last });
      } else if (t.isCallExpression(node)) {
        if (current.path === undefined || current.path.length === 0)
          (result.calleeCallResults ??= new Set()).add(node);
      } else if (t.isFunction(node)) {
        if (current.path === undefined || current.path.length === 0)
          functions.add(node);
        else if (
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
              });
            else if (current.invocation.receiverUnknown)
              result.unresolvedInvocation = true;
            if (inheritedInvocationChanged(method))
              result.unresolvedInvocation = true;
          }
        }
      } else if (t.isObjectExpression(node)) {
        // Getter dispatch and prototype selection can consult live effects.
        readsAmbientEffects = true;
        const [key, ...suffix] = current.path ?? [];
        for (const choice of key === undefined
          ? [undefined]
          : semanticAliasSelectionChoices(key))
          for (const source of semanticObjectPropertyReferences(
            node,
            choice === undefined ? [] : [choice],
            state,
          )) {
            if (source.widenedGetterResult) result.precision = "widened";
            if (
              source.inherited &&
              current.capturedSelections?.some(
                (capture) => capture.depth === 1 && capture.ownEnumerable,
              )
            )
              continue;
            pending.push({
              ...current,
              node: source.node,
              path:
                current.path === undefined || source.widenedGetterResult
                  ? undefined
                  : [...source.path, ...suffix],
              capturedSelections: semanticCapturedSelectionsAfterPropertyRead(
                current.capturedSelections,
                source,
              ),
            });
          }
      } else if (t.isArrayExpression(node)) {
        const [key, ...path] = current.path ?? [];
        if (current.path !== undefined && key !== undefined) {
          readsAmbientEffects ||= node.elements.some(t.isSpreadElement);
          for (const choice of semanticAliasSelectionChoices(key))
            for (const source of semanticArrayPropertyReferences(
              node,
              [choice],
              state,
            )) {
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
                  source.capturedSelectionAt,
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
              enqueue(
                child.node,
                child.path,
                child.readAt,
                child.capturedSelections,
                child.invocation ?? current.invocation,
                child.classKind ?? current.classKind,
              );
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
      } else if (t.isNewExpression(node))
        pending.push({ ...current, node: node.callee, classKind: "instance" });
      else if (t.isClass(node)) {
        readsAmbientEffects = true;
        const [key, ...path] = current.path ?? [];
        if (current.path !== undefined && key !== undefined) {
          for (const choice of semanticAliasSelectionChoices(key)) {
            const prototype =
              current.classKind !== "instance" && choice === "prototype";
            if (prototype && path.length === 0) continue;
            const ownEnumerable = current.capturedSelections?.some(
              (capture) =>
                capture.depth === (prototype ? 2 : 1) && capture.ownEnumerable,
            );
            const member = prototype ? path[0] : choice;
            if (member === undefined) continue;
            for (const selected of semanticAliasSelectionChoices(member))
              for (const source of semanticClassPropertyReferences(
                {
                  owner: node,
                  kind: prototype
                    ? "prototype"
                    : (current.classKind ?? "static"),
                  ...(ownEnumerable ? { fieldsOnly: true as const } : {}),
                },
                [selected],
                state,
              )) {
                if (source.inherited && ownEnumerable) continue;
                if (source.widenedGetterResult) result.precision = "widened";
                pending.push({
                  ...current,
                  node: source.node,
                  path: source.widenedGetterResult
                    ? undefined
                    : [...source.path, ...(prototype ? path.slice(1) : path)],
                  classKind: "static",
                  capturedSelections:
                    semanticCapturedSelectionsAfterPropertyRead(
                      prototype
                        ? semanticShiftCapturedSelections(
                            current.capturedSelections,
                            -1,
                          )
                        : current.capturedSelections,
                      source,
                    ),
                });
              }
          }
          for (const child of pending)
            enqueue(
              child.node,
              child.path,
              child.readAt,
              child.capturedSelections,
              child.invocation ?? current.invocation,
              child.classKind ?? current.classKind,
            );
          continue;
        }
        // Unknown projections retain every possible callable descendant. At
        // zero depth only construction contributes a source-local result.
        for (const member of node.body.body) {
          if (
            t.isClassMethod(member) &&
            (current.path === undefined || member.kind === "constructor")
          )
            pending.push({
              ...current,
              node: member,
              path: current.path === undefined ? undefined : [],
            });
          else if (
            current.path === undefined &&
            t.isClassProperty(member) &&
            member.value != null
          )
            pending.push({ ...current, node: member.value, path: undefined });
        }
        if (node.superClass !== null && node.superClass !== undefined)
          pending.push({ ...current, node: node.superClass });
      }
      for (let index = pending.length - 1; index >= 0; index--) {
        const child = pending[index];
        if (child !== undefined)
          enqueue(
            child.node,
            child.path,
            child.readAt,
            child.capturedSelections,
            child.invocation ?? current.invocation,
            child.classKind ?? current.classKind,
          );
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
            : [{ node, projection: delegated ? [null] : [] }],
      );
    });
    result.references = output;
    if (selected === undefined)
      results.set(callee, {
        result,
        invocation,
        iterationUnknown: state.arrayIterationUnknown,
        ambientGeneration: readsAmbientEffects
          ? semanticAmbientEffectGeneration(state, "contents")
          : undefined,
        opaqueSites: semanticGlobalCodeSites(state).length,
        dependencies: [...dependencies].map(([binding, generation]) => ({
          binding,
          generation,
        })),
      });
    if (result.precision === "widened")
      state.returnedReferenceWidenings.add(callee);
    return result;
  };
  return Object.assign(resolve, {
    observesAmbientEffects: (callee: t.Node): boolean => {
      resolve(callee);
      return results.get(callee)?.ambientGeneration !== undefined;
    },
  });
};
