import {
  semanticCapturedSelectionsAfterPropertyRead,
  semanticProjectedSourceFactsAtRead,
  semanticProjectedSourceEligibilityAtRead,
  semanticNormalizeCapturedSelections,
  semanticShiftCapturedSelections,
  type SemanticCapturedSelection,
} from "./javascriptSemanticProjectedSources.js";
import * as t from "@babel/types";
import { isBuiltin } from "node:module";
import { traverseJavaScriptValueAst } from "./javascriptSemanticTraversal.js";

import { BUILTIN_RESOURCE_METHODS } from "./javascriptBuiltinResourceMethods.js";
import { javaScriptRuntimeContext } from "./javascriptSourceParser.js";
import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticMemberEffect,
} from "./javascriptSemanticState.js";
import {
  isUnshadowedGlobal,
  commonJsWrapperBindingDeclaration,
  isUnmodifiedCommonJsWrapperBinding,
  semanticBindingAtRead,
  semanticBindingHasPriorValueWrite,
  semanticEffectTiming,
  semanticTopLevelEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import {
  isPrimitiveJavaScriptExpression,
  isPrimitiveJavaScriptCallableProperty,
  javaScriptExpressionValue,
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  semanticMemberChain,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  semanticPropertyPathKeyMatches,
  SemanticPropertyPathCoverage,
  SemanticPropertyPathEffectIndex,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import {
  resolveLocalCallables,
  type LocalCallableResolution,
} from "./javascriptSemanticCallResolution.js";
import { createSemanticAmbientEffectQuery } from "./javascriptSemanticEffectQueries.js";
import {
  staticSourceRelativeUrlPath,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { electronMemberPath } from "./javascriptElectronMemberWrites.js";
import {
  javaScriptScalarEvaluationSources,
  semanticBranchMayBeSkipped,
} from "./javascriptSemanticEvaluationOrder.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";
import { semanticSlotAtPath } from "./javascriptSemanticSlots.js";
import {
  semanticOpaqueBindingReadMayHaveChanged,
  createSemanticOpaqueReferenceEffectQuery,
} from "./javascriptSemanticOpaqueEffects.js";
import { semanticIterationSources } from "./javascriptSemanticIterationSources.js";
import {
  semanticCommonJsRequireOwnEnumerableAt,
  semanticReferenceSourcesInactive,
} from "./javascriptSemanticReferenceSources.js";
import {
  semanticArrayPropertyReferences,
  semanticObjectPropertyReferences,
} from "./javascriptSemanticObjectReferences.js";
import {
  SemanticAliasSelections,
  semanticAliasSelectionChoices,
  type SemanticAliasSelectionPath,
} from "./javascriptSemanticAliasSelections.js";
import { SEMANTIC_ALIAS_SELECTION_LIMIT } from "./javascriptSemanticResourceLimits.js";
import {
  semanticRequireOriginReaders,
  type JavaScriptRequireLoaderFact,
  type JavaScriptRequireOrigin,
} from "./javascriptSemanticRequireOriginSlot.js";
import {
  isUnmodifiedGlobalReference,
  isUnmodifiedImportMetaUrl,
} from "./javascriptSemanticAmbientWrites.js";

export type {
  JavaScriptRequireLoaderFact,
  JavaScriptRequireOrigin,
} from "./javascriptSemanticRequireOriginSlot.js";

const possibleCommonJsDelegateWriteStates =
  new WeakSet<JavaScriptSemanticAnalysisState>();

/** Source eligibility only; the shared write owner still proves receiver identity. */
export const observePossibleCommonJsDelegateWrite = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): void => {
  if (possibleCommonJsDelegateWriteStates.has(state)) return;
  const target = t.isAssignmentExpression(node)
    ? node.left
    : t.isUpdateExpression(node) ||
        t.isUnaryExpression(node, { operator: "delete" })
      ? node.argument
      : undefined;
  if (
    semanticIterationSources(node, state.parentsByNode.get(node) ?? null).some(
      (source) => source.kind === "reference-store",
    )
  )
    possibleCommonJsDelegateWriteStates.add(state);
  if (
    (t.isMemberExpression(target) || t.isOptionalMemberExpression(target)) &&
    ["require", null].includes(
      semanticStaticPropertyKey(target.property, target.computed),
    )
  )
    possibleCommonJsDelegateWriteStates.add(state);
  else if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
    possibleCommonJsDelegateWriteStates.add(state);
};

export const hasPossibleCommonJsDelegateWrite = (
  state: JavaScriptSemanticAnalysisState,
): boolean => possibleCommonJsDelegateWriteStates.has(state);

/** Member effects settle at the shared indexing boundary, invalidating derived delegates. */
export const invalidateSemanticRequireDelegateWrites = (
  state: JavaScriptSemanticAnalysisState,
): void => {
  moduleRequireWrites.delete(state);
  moduleReturnedReferences.delete(state);
};

const commonJsDelegateChangedAt = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  writesModuleRequire(state).some(
    (write) => semanticEffectTiming(node, write, state) !== "after",
  );

const commonJsLoaderAt = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptRequireLoaderFact =>
  commonJsDelegateChangedAt(node, state) ? "unknown" : "commonjs-loader";

/** Associate wrapper lookups with their loader; this does not claim execution. */
export const semanticRequireLoaderAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  factoryBindingIds: ReadonlySet<string>,
): JavaScriptRequireLoaderFact => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  const loader =
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    ["resolve", "main"].includes(
      semanticStaticPropertyKey(callee.property, callee.computed) ?? "",
    )
      ? callee.object
      : callee;
  const selected = selectedRequireSourcesAt(
    loader,
    node,
    state,
    factoryBindingIds,
  )?.loader;
  return selected !== undefined && selected !== "unknown"
    ? selected
    : requireLoaderValueAt(loader, node, state, factoryBindingIds);
};

/** Classify Node's wrapper and exact factory bindings by their lexical owner. */
const requireLoaderValueAt = (
  value: t.Node,
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  factoryBindingIds: ReadonlySet<string>,
): JavaScriptRequireLoaderFact => {
  const callee = unwrapJavaScriptExpression(value).node;
  // Only the selected require function is callable as the host loader.
  // Its resolve/main members remain association facts in the wrapper above.
  if (!t.isIdentifier(callee)) return "local";
  const loader = callee;
  const binding = resolveSemanticBindingState(state, loader, loader.name);
  if (binding !== undefined && factoryBindingIds.has(binding.bindingId))
    return semanticBindingHasPriorValueWrite(node, binding, state)
      ? "unknown"
      : "factory-loader";
  if (binding !== undefined && isSemanticCreateRequireBinding(binding, state))
    return "create-require";
  if (loader.name !== "require") return "local";
  if (binding === undefined) {
    if (
      javaScriptRuntimeContext(state.program) === "module" ||
      semanticResolutionBlocked(state, loader, "require")
    )
      return "unknown";
    return (state.ambientBindingWrites.get("require") ?? []).some(
      (write) => semanticEffectTiming(node, write, state) !== "after",
    )
      ? "unknown"
      : commonJsLoaderAt(node, state);
  }
  if (
    binding.hostOrigin === "commonjs-wrapper" &&
    [...binding.declarationKinds].every((kind) => kind === "var")
  ) {
    if (binding.definitions.some(({ kind }) => kind === "function"))
      return "local";
    return semanticBindingHasPriorValueWrite(node, binding, state)
      ? "unknown"
      : commonJsLoaderAt(node, state);
  }
  if (
    (t.isCallExpression(node) ||
      t.isOptionalCallExpression(node) ||
      t.isNewExpression(node)) &&
    isWrapperRequireInitializerCall(binding, node, state)
  )
    return commonJsLoaderAt(node, state);
  const wrapperBinding = commonJsWrapperBindingDeclaration(
    loader,
    "require",
    state,
  );
  if (
    wrapperBinding !== undefined &&
    !semanticBindingHasPriorValueWrite(node, wrapperBinding, state)
  )
    return commonJsLoaderAt(node, state);
  const initializer = semanticStableInitializer(binding, state)?.node;
  if (
    (binding.kind === "function" || binding.kind === "class") &&
    initializer !== undefined
  )
    return "local";
  if (
    binding.declarationKinds.size === 1 &&
    binding.declarationKinds.has("const") &&
    (t.isFunctionExpression(initializer) ||
      t.isArrowFunctionExpression(initializer))
  )
    return "local";
  return "unknown";
};

/** Classify a call through an exact recovered factory-loader binding. */
export const semanticFactoryRequireLoaderAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  bindingIds: ReadonlySet<string>,
): JavaScriptRequireLoaderFact | undefined => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (t.isIdentifier(callee))
    return semanticFactoryLoaderMemberAt(node, state, bindingIds, null);
  if (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    semanticStaticPropertyKey(callee.property, callee.computed) === "bind"
  )
    return semanticFactoryLoaderMemberAt(node, state, bindingIds, "bind");
  return undefined;
};

/** Classify an exact loader call by binding identity and expected member. */
export const semanticFactoryLoaderMemberAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  bindingIds: ReadonlySet<string>,
  member: string | null,
): JavaScriptRequireLoaderFact | undefined => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  let loader: t.Identifier | undefined;
  if (member === null) {
    if (t.isIdentifier(callee)) loader = callee;
  } else if (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    semanticStaticPropertyKey(callee.property, callee.computed) === member
  ) {
    const root = unwrapJavaScriptExpression(callee.object).node;
    if (t.isIdentifier(root)) loader = root;
  }
  if (loader === undefined) return undefined;
  const binding = resolveSemanticBindingState(state, loader, loader.name);
  if (binding === undefined || !bindingIds.has(binding.bindingId))
    return undefined;
  return semanticBindingHasPriorValueWrite(node, binding, state)
    ? "unknown"
    : "factory-loader";
};

const isSemanticCreateRequireBinding = (
  binding: NonNullable<ReturnType<typeof resolveSemanticBindingState>>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (binding.initializers.length !== 1) return false;
  const initializer = semanticStableInitializer(binding, state)?.node;
  return (
    createRequireFactoryCallAt(initializer, state)?.loader === "create-require"
  );
};

/** Retain the factory's actual certainty for both proof and eligibility consumers. */
const createRequireFactoryCallAt = (
  initializer: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
  factoryBindingIds: ReadonlySet<string> = new Set(),
):
  | Pick<
      JavaScriptRequireCallFact,
      "loader" | "sourceRelative" | "sourceRelativePath"
    >
  | undefined =>
  !t.isCallExpression(initializer)
    ? undefined
    : selectedRequireSourcesAt(
        initializer.callee,
        initializer,
        state,
        factoryBindingIds,
        "factory",
      );

type SourceRelativeCreateRequireBase =
  | { readonly kind: "source-file" }
  | { readonly kind: "source-relative-file"; readonly path: string };

const sourceRelativeCreateRequireBaseAt = (
  value: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): SourceRelativeCreateRequireBase | undefined => {
  if (value === undefined) return undefined;
  if (isUnmodifiedImportMetaUrl(value, state)) return { kind: "source-file" };
  if (!t.isNewExpression(value) || value.arguments.length !== 2)
    return undefined;
  const callee = unwrapJavaScriptExpression(value.callee).node;
  if (
    !t.isIdentifier(callee, { name: "URL" }) ||
    !isUnmodifiedGlobalReference(callee, state, "URL") ||
    !isUnmodifiedImportMetaUrl(
      t.isNode(value.arguments[1]) ? value.arguments[1] : undefined,
      state,
    )
  )
    return undefined;
  const urlPath = staticSourceRelativeUrlPath(value);
  return urlPath === undefined ||
    urlPath.directory ||
    urlPath.path.startsWith("/")
    ? undefined
    : { kind: "source-relative-file", path: urlPath.path };
};

/** Eligibility for observable loader slots; an unknown factory is not invocation proof. */
export const hasSemanticCreateRequireFactoryOrigin = (
  initializer: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const factory = createRequireFactoryCallAt(initializer, state);
  return factory !== undefined && factory.loader !== "local";
};

const isCreateRequireOrigin = (
  origin: JavaScriptModuleOrigin,
  selected: SemanticAliasSelectionPath,
): boolean => {
  if (!["module", "node:module"].includes(origin.specifier)) return false;
  const path = [...origin.importedPath, ...selected];
  return (
    (path.length === 1 && path[0] === "createRequire") ||
    ((origin.resolutionMode ?? "import") === "import" &&
      path.length === 2 &&
      path[0] === "default" &&
      path[1] === "createRequire")
  );
};

/** Assignment expressions expose their RHS; short-circuit stores may keep the old value. */
export const assignmentValueSources = (
  node: t.AssignmentExpression,
): readonly t.Node[] =>
  node.operator === "="
    ? [node.right]
    : ["||=", "&&=", "??="].includes(node.operator)
      ? [node.left, node.right]
      : [];

/** Follow selected values to Node's captured loader or its creating factory. */
const selectedRequireSourcesAt = (
  root: t.Node,
  site: t.Node,
  state: JavaScriptSemanticAnalysisState,
  factoryBindingIds: ReadonlySet<string>,
  target: "loader" | "factory" = "loader",
):
  | Pick<
      JavaScriptRequireCallFact,
      "loader" | "sourceRelative" | "sourceRelativePath"
    >
  | undefined => {
  const pending: ModuleObjectSource[] = [{ node: root, path: [] }];
  const seen = new WeakMap<t.Node, Set<string>>();
  let count = 0;
  let found = false;
  let loaderBinding = false;
  let selectedLoader: JavaScriptRequireLoaderFact | undefined;
  let unknown = false;
  let local = false;
  let nativeMemberAlternative = false;
  let sourceRelative = true;
  let sourceRelativeBase: SourceRelativeCreateRequireBase | undefined;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const node = unwrapJavaScriptExpression(current.node).node;
    const genericMember =
      current.path.length === 1 &&
      semanticAliasSelectionChoices(current.path[0]!).every(
        (key) => key === "call" || key === "apply",
      );
    const nativeGenericMember =
      target === "loader" &&
      genericMember &&
      t.isIdentifier(node) &&
      requireLoaderValueAt(node, node, state, factoryBindingIds) !== "local";
    const key = JSON.stringify([current.path, loaderSourceContextKey(current)]);
    const paths = seen.get(node) ?? new Set<string>();
    if (paths.has(key)) continue;
    paths.add(key);
    seen.set(node, paths);
    if (++count > SEMANTIC_ALIAS_SELECTION_LIMIT) {
      state.valueResourceLimits.add("alias-selections");
      return { loader: "unknown", sourceRelative: false };
    }
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      pending.push(
        ...inheritLoaderSourceContext(current, [
          loaderMemberSource(current, node),
        ]),
      );
    } else if (t.isIdentifier(node)) {
      if (target === "loader" && current.path.length === 0) {
        const captured = requireLoaderValueAt(
          node,
          node,
          state,
          factoryBindingIds,
        );
        if (captured !== "local" && captured !== "create-require") {
          const invoked =
            captured === "commonjs-loader"
              ? commonJsLoaderAt(site, state)
              : captured;
          found = true;
          unknown ||=
            invoked === "unknown" ||
            (selectedLoader !== undefined && selectedLoader !== invoked);
          selectedLoader ??= invoked;
          continue;
        }
      }
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (binding === undefined) {
        unknown = true;
        continue;
      }
      // Eligibility is separate from the selected value: replacing a known
      // loader with an opaque value keeps a gap, while a proven local function
      // no longer claims the previous factory's base or identity.
      loaderBinding ||=
        target === "loader" &&
        binding.initializers.some(
          (source) =>
            hasSemanticCreateRequireFactoryOrigin(source.node, state) ||
            (t.isIdentifier(source.node) &&
              requireLoaderValueAt(
                source.node,
                source.node,
                state,
                factoryBindingIds,
              ) !== "local"),
        );
      const facts = semanticProjectedSourceFactsAtRead(
        binding,
        node,
        current.path,
        state,
        true,
        current.readAt ?? node,
        current.capturedSelections,
      );
      if (nativeGenericMember)
        nativeMemberAlternative ||=
          facts === undefined ||
          facts.sources.length === 0 ||
          !facts.sources.every(({ node: source }) => {
            const value = unwrapJavaScriptExpression(source).node;
            return (
              t.isFunctionExpression(value) ||
              t.isArrowFunctionExpression(value)
            );
          });
      if (target === "factory" && binding.directOrigins.length > 0) {
        const native = binding.directOrigins.some((origin) =>
          isCreateRequireOrigin(origin, current.path),
        );
        loaderBinding ||= native;
        if (facts?.retainsOrigin) {
          found ||= native;
          local ||= !native;
          if (native) selectedLoader = "create-require";
        }
      }
      if (facts === undefined) {
        unknown = true;
        const retained = semanticBindingAtRead(
          binding,
          node,
          state.parentsByNode,
        ).binding;
        pending.push(
          ...inheritLoaderSourceContext(
            current,
            projectedLoaderSources(
              current,
              [...retained.initializers, ...retained.referenceInitializers]
                .filter(
                  (source) => !semanticReferenceSourcesInactive(source, state),
                )
                .map((source) => ({
                  node: source.node,
                  path: [...source.projection, ...current.path],
                })),
            ),
          ),
        );
      } else {
        unknown ||=
          facts.sources.length === 0 &&
          !(
            target === "factory" &&
            facts.retainsOrigin &&
            binding.directOrigins.length > 0
          );
        pending.push(
          ...inheritLoaderSourceContext(
            current,
            projectedLoaderSources(current, facts.sources),
          ),
        );
      }
    } else if (t.isObjectExpression(node) || t.isArrayExpression(node)) {
      if (current.path.length === 0) {
        local = true;
        continue;
      }
      const sources = loaderObjectPropertySources(current, node, state);
      unknown ||= sources.length === 0;
      pending.push(...inheritLoaderSourceContext(current, sources));
    } else if (t.isSequenceExpression(node)) {
      const last = node.expressions.at(-1);
      if (last !== undefined) pending.push({ ...current, node: last });
    } else if (t.isAssignmentExpression(node)) {
      for (const source of assignmentValueSources(node))
        pending.push({ ...current, node: source });
    } else if (t.isConditionalExpression(node) || t.isLogicalExpression(node)) {
      pending.push(
        {
          ...current,
          node: t.isConditionalExpression(node) ? node.consequent : node.left,
        },
        {
          ...current,
          node: t.isConditionalExpression(node) ? node.alternate : node.right,
        },
      );
    } else if (t.isCallExpression(node)) {
      const callee = unwrapJavaScriptExpression(node.callee).node;
      if (
        target === "loader" &&
        current.path.length === 0 &&
        t.isFunction(callee)
      ) {
        if (callee.async || callee.generator) {
          // A direct async/generator invocation returns a wrapper, not its contents.
          local = true;
          continue;
        }
        const returned = returnedLoaderReferences(state, "direct-call")(
          node.callee,
          node,
        );
        // The shared result owner is a may-reference graph. A block may also
        // fall through or throw; only an expression arrow supplies its whole result.
        unknown ||=
          returned.unresolvedInvocation === true ||
          !t.isArrowFunctionExpression(callee) ||
          t.isBlockStatement(callee.body);
        pending.push(
          ...inheritLoaderSourceContext(
            current,
            returned.references.map((reference) => ({
              node: reference.node,
              path: reference.projection,
            })),
          ),
        );
        continue;
      }
      if (target === "factory") {
        const origin = semanticRequireOrigin(node, state)?.origin;
        if (
          origin !== undefined &&
          isCreateRequireOrigin(origin, current.path)
        ) {
          found = true;
          selectedLoader = "create-require";
        } else unknown = true;
      } else if (current.path.length === 0 || genericMember) {
        const factory = createRequireFactoryCallAt(
          node,
          state,
          factoryBindingIds,
        );
        if (factory !== undefined && factory.loader !== "local") {
          if (genericMember) {
            // A conditional own write retains this inherited native method.
            // Alone it still belongs to the invocation owner's fallback.
            nativeMemberAlternative = true;
            if (factory.loader === "unknown") {
              loaderBinding = true;
              unknown = true;
            }
          } else {
            found = true;
            unknown ||=
              factory.loader === "unknown" ||
              (selectedLoader !== undefined &&
                selectedLoader !== "create-require");
            selectedLoader ??= "create-require";
            unknown ||= state.conditionallySkippedExpressions.has(node);
            const factoryBase = sourceRelativeCreateRequireBaseAt(
              node.arguments[0],
              state,
            );
            if (factoryBase === undefined) sourceRelative = false;
            else if (sourceRelativeBase === undefined)
              sourceRelativeBase = factoryBase;
            else if (
              sourceRelativeBase.kind !== factoryBase.kind ||
              (sourceRelativeBase.kind === "source-relative-file" &&
                factoryBase.kind === "source-relative-file" &&
                sourceRelativeBase.path !== factoryBase.path)
            ) {
              sourceRelative = false;
            }
          }
        } else if (factory?.loader === "local") local = true;
        else unknown = true;
      } else unknown = true;
    } else if (
      current.path.length === 0 &&
      (t.isFunction(node) || t.isClassExpression(node) || t.isLiteral(node))
    ) {
      local = true;
    } else {
      // Every selected expression contributes a possible value. An opaque
      // alternative cannot leave another factory as the sole proven origin.
      unknown = true;
    }
  }
  return found || local || (loaderBinding && unknown)
    ? {
        loader:
          (unknown && (found || loaderBinding)) ||
          (local && (found || nativeMemberAlternative))
            ? "unknown"
            : found
              ? (selectedLoader ?? "unknown")
              : "local",
        sourceRelative: found && sourceRelative && !unknown,
        ...(found &&
        !unknown &&
        sourceRelative &&
        sourceRelativeBase?.kind === "source-relative-file"
          ? { sourceRelativePath: sourceRelativeBase.path }
          : {}),
      }
    : undefined;
};

const loaderInvocationInterops = new WeakMap<
  JavaScriptSemanticAnalysisState,
  {
    readonly writes: number;
    readonly interop: ReturnType<typeof createSemanticModuleInterop>;
  }
>();

const loaderInvocationInterop = (state: JavaScriptSemanticAnalysisState) => {
  const prior = loaderInvocationInterops.get(state);
  if (prior?.writes === state.ambientWriteEffects.length) return prior.interop;
  const interop = createSemanticModuleInterop(state);
  for (const effect of state.ambientWriteEffects)
    if (effect.path[0] === "global")
      interop.retainWrite(effect.node ?? state.program, [
        "intrinsic",
        ...effect.path
          .slice(1)
          .map((key) =>
            key === null || typeof key === "object" ? null : String(key),
          ),
      ]);
  loaderInvocationInterops.set(state, {
    writes: state.ambientWriteEffects.length,
    interop,
  });
  return interop;
};

export interface JavaScriptRequireCallFact {
  readonly operation: "load" | "resolve";
  readonly loader: JavaScriptRequireLoaderFact;
  readonly arguments:
    | readonly t.CallExpression["arguments"][number][]
    | undefined;
  readonly sourceRelative: boolean;
  /** A createRequire filename relative to the current source directory, when proven. */
  readonly sourceRelativePath?: string;
}

/** Classify the selected loader and normalize invocation arguments once. */
export const semanticRequireCallAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  factoryBindingIds: ReadonlySet<string>,
): JavaScriptRequireCallFact | undefined => {
  if (semanticModuleRequireCallAt(node, state))
    return {
      operation: "load",
      loader: "unknown",
      arguments: undefined,
      sourceRelative: false,
    };
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    ["call", "apply"].includes(
      semanticStaticPropertyKey(callee.property, callee.computed) ?? "",
    ) &&
    selectedRequireSourcesAt(callee, node, state, factoryBindingIds)?.loader ===
      "local"
  )
    return {
      operation: "load",
      loader: "local",
      arguments: undefined,
      sourceRelative: false,
    };
  if (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    semanticStaticPropertyKey(callee.property, callee.computed) === "resolve"
  ) {
    const loader = requireLoaderValueAt(
      callee.object,
      node,
      state,
      factoryBindingIds,
    );
    if (loader === "unknown")
      return {
        operation: "load",
        loader,
        arguments: undefined,
        sourceRelative: false,
      };
    // Bundler factory loaders can share the `require` shape, but their
    // `.resolve` member is not Node's module resolver.
    if (loader === "commonjs-loader" || loader === "create-require") {
      const selected = selectedRequireSourcesAt(
        callee.object,
        node,
        state,
        factoryBindingIds,
      );
      return {
        operation: "resolve",
        loader: selected?.loader ?? loader,
        arguments: node.arguments,
        sourceRelative:
          selected?.sourceRelative ?? loader === "commonjs-loader",
        ...(selected?.sourceRelativePath === undefined
          ? {}
          : { sourceRelativePath: selected.sourceRelativePath }),
      };
    }
  }
  if (t.isNewExpression(node)) {
    const loader = requireLoaderValueAt(
      node.callee,
      node,
      state,
      factoryBindingIds,
    );
    const selected = selectedRequireSourcesAt(
      node.callee,
      node,
      state,
      factoryBindingIds,
    );
    if (selected !== undefined || loader !== "local")
      return {
        operation: "load",
        loader: selected?.loader ?? loader,
        arguments: node.arguments,
        sourceRelative: selected?.sourceRelative ?? loader !== "create-require",
        ...(selected?.sourceRelativePath === undefined
          ? {}
          : { sourceRelativePath: selected.sourceRelativePath }),
      };
  }
  const interop = loaderInvocationInterop(state);
  if (!t.isNewExpression(node)) {
    const invocation = interop.intrinsicInvocation(node, (callee) => {
      const loader = requireLoaderValueAt(
        callee,
        node,
        state,
        factoryBindingIds,
      );
      if (loader !== "local" && loader !== "create-require")
        return ["require-loader", loader, "relative"];
      const selected = selectedRequireSourcesAt(
        callee,
        node,
        state,
        factoryBindingIds,
      );
      if (selected !== undefined)
        return [
          "require-loader",
          selected.loader,
          selected.sourceRelative ? "relative" : "unknown",
        ];
      return interop.intrinsicPath(callee);
    });
    if (invocation?.path[0] === "require-loader") {
      const selected = selectedRequireSourcesAt(
        node.callee,
        node,
        state,
        factoryBindingIds,
      );
      return {
        operation: "load",
        loader:
          invocation.path[1] === "local"
            ? "local"
            : invocation.kind === "opaque"
              ? "unknown"
              : (invocation.path[1] as JavaScriptRequireLoaderFact),
        arguments: invocation.arguments,
        sourceRelative:
          invocation.kind === "known" && invocation.path[2] === "relative",
        ...(selected?.sourceRelativePath === undefined
          ? {}
          : { sourceRelativePath: selected.sourceRelativePath }),
      };
    }
  }
  const factory = semanticFactoryRequireLoaderAt(
    node,
    state,
    factoryBindingIds,
  );
  return factory === undefined
    ? undefined
    : {
        operation: "load",
        loader: factory,
        arguments: node.arguments.slice(t.isIdentifier(node.callee) ? 0 : 1),
        sourceRelative: true,
      };
};

/** The RHS call runs before its assignment replaces Node's wrapper loader. */
const isWrapperRequireInitializerCall = (
  binding: NonNullable<ReturnType<typeof resolveSemanticBindingState>>,
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const scope = state.scopesById.get(binding.scopeId);
  if (
    scope?.kind !== "program" ||
    binding.kind !== "variable" ||
    binding.declarationKinds.size !== 1 ||
    !binding.declarationKinds.has("var") ||
    binding.initializers.length !== 1 ||
    binding.initializers[0]?.node !== node
  )
    return false;
  const assignment = state.parentsByNode.get(node);
  if (
    !t.isAssignmentExpression(assignment) ||
    assignment.right !== node ||
    state.conditionallySkippedExpressions.has(node)
  )
    return false;
  const statement = state.parentsByNode.get(assignment);
  if (!t.isExpressionStatement(statement)) return false;
  if (state.parentsByNode.get(statement) !== state.program) return false;
  const target = unwrapJavaScriptExpression(assignment.left).node;
  return (
    t.isIdentifier(target, { name: "require" }) &&
    resolveSemanticBindingState(state, target, target.name) === binding
  );
};

// Ambient indexing finishes before these derived facts are consumed. Keep only
// replacement sites, rather than rescanning unrelated global member writes.
const globalProcessReplacements = new WeakMap<
  JavaScriptSemanticAnalysisState,
  readonly (t.Node | undefined)[]
>();
const moduleRequireWrites = new WeakMap<
  JavaScriptSemanticAnalysisState,
  readonly t.Node[]
>();
const moduleReturnedReferences = new WeakMap<
  JavaScriptSemanticAnalysisState,
  Map<
    "direct-call" | "awaited-call",
    ReturnType<typeof createSemanticReturnedReferences>
  >
>();

/** Reuse one result-reference owner for loader values and module receivers. */
const returnedLoaderReferences = (
  state: JavaScriptSemanticAnalysisState,
  mode: "direct-call" | "awaited-call",
): ReturnType<typeof createSemanticReturnedReferences> => {
  let factories = moduleReturnedReferences.get(state);
  if (factories === undefined) {
    factories = new Map();
    moduleReturnedReferences.set(state, factories);
  }
  let returned = factories.get(mode);
  if (returned === undefined) {
    returned = createSemanticReturnedReferences(state, mode);
    factories.set(mode, returned);
  }
  return returned;
};

type ModuleObjectSource = {
  readonly node: t.Node;
  readonly path: SemanticAliasSelectionPath;
  readonly eligibility?: true;
  readonly readAt?: t.Node | undefined;
  readonly capturedSelections?:
    | readonly SemanticCapturedSelection[]
    | undefined;
};

/** Both loader queries retain the same read and shallow-copy selection owner. */
const loaderSourceContextKey = (source: ModuleObjectSource): string =>
  JSON.stringify([
    source.eligibility,
    source.readAt?.start,
    source.readAt?.end,
    source.capturedSelections?.map(({ at, depth, ownEnumerable }) => [
      at.start,
      at.end,
      depth,
      ownEnumerable,
    ]),
  ]);

const inheritLoaderSourceContext = (
  current: ModuleObjectSource,
  sources: readonly ModuleObjectSource[],
): ModuleObjectSource[] =>
  sources.map((source) => ({
    ...(current.eligibility ? { eligibility: true as const } : {}),
    ...(current.readAt === undefined ? {} : { readAt: current.readAt }),
    ...source,
    capturedSelections: semanticNormalizeCapturedSelections(
      source.capturedSelections ?? current.capturedSelections,
      source.path.length,
    ),
  }));

// A later read site selects only the remaining path. This member selects its
// own key when it is evaluated, so `o.k = o.k || d` reads o.k before the write.
const loaderMemberSource = (
  current: ModuleObjectSource,
  member: t.MemberExpression | t.OptionalMemberExpression,
): ModuleObjectSource => ({
  node: member.object,
  readAt: current.readAt ?? member,
  capturedSelections:
    current.readAt === undefined
      ? semanticShiftCapturedSelections(current.capturedSelections, 1)
      : semanticNormalizeCapturedSelections([
          { at: member, depth: 1 },
          ...(semanticShiftCapturedSelections(current.capturedSelections, 1) ??
            []),
        ]),
  path: [
    semanticStaticPropertyKey(member.property, member.computed),
    ...current.path,
  ],
});

const projectedLoaderSources = (
  current: ModuleObjectSource,
  sources: readonly ModuleObjectSource[],
): ModuleObjectSource[] =>
  sources.map((source) => ({
    ...source,
    // Selecting a whole stored RHS captures its own member read. Only a
    // remaining descendant path observes that shared value at the later use.
    readAt:
      source.path.length === 0
        ? source.node
        : current.path.length === 0
          ? undefined
          : (current.readAt ?? current.node),
    capturedSelections: [
      ...(semanticShiftCapturedSelections(
        current.capturedSelections,
        source.path.length - current.path.length,
      ) ?? []),
      ...(source.capturedSelections ?? []),
    ],
  }));

const loaderObjectPropertySources = (
  current: ModuleObjectSource,
  object: t.ObjectExpression | t.ArrayExpression,
  state: JavaScriptSemanticAnalysisState,
): ModuleObjectSource[] => {
  const [key, ...remaining] = current.path;
  if (key === undefined) return [];
  return semanticAliasSelectionChoices(key).flatMap((choice) =>
    (t.isObjectExpression(object)
      ? semanticObjectPropertyReferences(object, [choice], state)
      : semanticArrayPropertyReferences(object, [choice])
    )
      .filter(
        (source) =>
          !source.inherited ||
          !current.capturedSelections?.some(
            (capture) => capture.depth === 1 && capture.ownEnumerable,
          ),
      )
      .map((source) => ({
        node: source.node,
        path: [...source.path, ...remaining],
        capturedSelections: semanticCapturedSelectionsAfterPropertyRead(
          current.capturedSelections,
          source,
        ),
      })),
  );
};

export const isCommonJsModuleObject = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  includeUnknown = true,
): boolean => hasCommonJsModuleSource(node, state, includeUnknown, "module");

/** A captured delegate uses the same receiver and assignment ownership facts. */
export const isCommonJsRequireDelegate = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  includeUnknown = false,
  readAt?: t.Node,
): boolean =>
  hasCommonJsModuleSource(node, state, includeUnknown, "delegate", readAt);

const hasCommonJsModuleSource = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  includeUnknown: boolean,
  target: "module" | "delegate",
  readAt?: t.Node,
): boolean => {
  type Work = ModuleObjectSource & {
    /** Await occurs after this many requested outer property selections. */
    readonly awaitDepths: readonly number[];
  };
  const pending: Work[] = [{ node, path: [], readAt, awaitDepths: [] }];
  // Keep depths separate and join finite key alternatives at each source read.
  const selections = new SemanticAliasSelections(() => {
    state.valueResourceLimits.add("alias-selections");
  });
  const contexts = new WeakMap<
    t.Node,
    Map<
      string,
      {
        readonly identities: Map<string, object>;
      }
    >
  >();
  const examined = new WeakSet<object>();
  let additionalStates = 0;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapJavaScriptExpression(next.node).node;
    const { awaitDepths } = next;
    const byMode =
      contexts.get(value) ??
      new Map<string, { readonly identities: Map<string, object> }>();
    const modeKey = JSON.stringify([awaitDepths, loaderSourceContextKey(next)]);
    let context = byMode.get(modeKey);
    if (context === undefined) {
      context = { identities: new Map() };
      byMode.set(modeKey, context);
      contexts.set(value, byMode);
    }
    const path = selections.normalize(context, next.path);
    if (selections.limited) return true;
    const pathKey = JSON.stringify(path);
    let identity = context.identities.get(pathKey);
    if (identity === undefined) {
      // Consumption contexts must not provide an unbounded second path to
      // expansion beyond the shared selector budget.
      if (
        (byMode.size > 1 || context.identities.size > 0) &&
        ++additionalStates > SEMANTIC_ALIAS_SELECTION_LIMIT
      ) {
        state.valueResourceLimits.add("alias-selections");
        return true;
      }
      identity = {};
      context.identities.set(pathKey, identity);
    }
    // A revisited state adds no source. A cycle's other entries are expanded
    // once each, so a cycle is not an unknown loader.
    if (examined.has(identity)) continue;
    examined.add(identity);
    const enqueueAt = (
      depths: readonly number[],
      ...sources: ModuleObjectSource[]
    ) => {
      pending.push(
        ...inheritLoaderSourceContext(next, sources).map((source) => ({
          ...source,
          awaitDepths: depths,
        })),
      );
    };
    const enqueue = (...sources: ModuleObjectSource[]) => {
      enqueueAt(awaitDepths, ...sources);
    };
    if (t.isAwaitExpression(value)) {
      enqueueAt(
        [...new Set([...awaitDepths, path.length])].sort(
          (left, right) => left - right,
        ),
        { node: value.argument, path },
      );
      continue;
    }
    if (t.isMemberExpression(value) || t.isOptionalMemberExpression(value)) {
      enqueue(loaderMemberSource({ ...next, path }, value));
      continue;
    }
    if (
      path.length > 0 &&
      (t.isObjectExpression(value) || t.isArrayExpression(value))
    ) {
      enqueueAt(
        // Awaiting a fresh container does not await one of its children.
        awaitDepths.filter((depth) => depth !== path.length),
        ...loaderObjectPropertySources({ ...next, path }, value, state),
      );
      continue;
    }
    if (t.isConditionalExpression(value) || t.isLogicalExpression(value)) {
      enqueue(
        {
          node: t.isConditionalExpression(value)
            ? value.consequent
            : value.left,
          path,
        },
        {
          node: t.isConditionalExpression(value)
            ? value.alternate
            : value.right,
          path,
        },
      );
      continue;
    }
    if (t.isSequenceExpression(value)) {
      const last = value.expressions.at(-1);
      if (last !== undefined) enqueue({ node: last, path });
      continue;
    }
    if (t.isAssignmentExpression(value)) {
      enqueue(...assignmentValueSources(value).map((node) => ({ node, path })));
      continue;
    }
    if (
      t.isCallExpression(value) ||
      t.isOptionalCallExpression(value) ||
      t.isNewExpression(value)
    ) {
      const mode = awaitDepths.includes(path.length)
        ? "awaited-call"
        : "direct-call";
      const returnedResult = returnedLoaderReferences(state, mode)(
        value.callee,
        t.isNewExpression(value) ? undefined : value,
      );
      if (returnedResult.unresolvedInvocation) return true;
      enqueue(
        ...returnedResult.references.map((source) => ({
          node: source.node,
          path: [...source.projection, ...path],
          capturedSelections: semanticShiftCapturedSelections(
            next.capturedSelections,
            source.projection.length,
          ),
        })),
      );
      continue;
    }
    if (!t.isIdentifier(value)) continue;
    const binding = resolveSemanticBindingState(state, value, value.name);
    const processMainModulePath =
      semanticGlobalProcessOrigin(value, state) !== undefined &&
      path.length === (target === "module" ? 1 : 2) &&
      semanticAliasSelectionChoices(path[0]!).some(
        (key) =>
          key === null || semanticPropertyPathKeyMatches(key, "mainModule"),
      ) &&
      (target === "module" ||
        semanticAliasSelectionChoices(path[1]!).some(
          (key) =>
            key === null || semanticPropertyPathKeyMatches(key, "require"),
        ));
    if (processMainModulePath) return true;
    const mainModulePath =
      value.name === "require" &&
      state.program.sourceType === "script" &&
      path.length === (target === "module" ? 1 : 2) &&
      semanticAliasSelectionChoices(path[0]!).some(
        (key) => key === null || semanticPropertyPathKeyMatches(key, "main"),
      ) &&
      (target === "module" ||
        semanticAliasSelectionChoices(path[1]!).some(
          (key) =>
            key === null || semanticPropertyPathKeyMatches(key, "require"),
        ));
    // Native wrapper require.main is a Module, with a process-relative loader.
    // Its selected binding writes below can replace that source with local data.
    if (
      mainModulePath &&
      binding === undefined &&
      !semanticResolutionBlocked(state, value, "require")
    )
      return true;
    const copyAdmitsModuleDelegate =
      value.name !== "module" ||
      target !== "delegate" ||
      path.length !== 1 ||
      !next.capturedSelections?.some(
        (capture) =>
          capture.depth === 1 &&
          capture.ownEnumerable &&
          !semanticCommonJsRequireOwnEnumerableAt(capture.at, state),
      );
    if (value.name === "module" && binding === undefined) {
      if (
        copyAdmitsModuleDelegate &&
        (target === "module"
          ? path.length === 0
          : path.length === 1 &&
            semanticAliasSelectionChoices(path[0]!).some(
              (key) =>
                key === null || semanticPropertyPathKeyMatches(key, "require"),
            )) &&
        !semanticResolutionBlocked(state, value, "module")
      )
        return true;
      continue;
    }
    if (binding === undefined) continue;
    const read = semanticBindingAtRead(binding, value, state.parentsByNode);
    const retainsMainModule =
      mainModulePath &&
      commonJsWrapperBindingDeclaration(value, "require", state) !==
        undefined &&
      !read.hasDefiniteInitializer;
    if (
      value.name === "module" &&
      copyAdmitsModuleDelegate &&
      (target === "module"
        ? path.length === 0
        : path.length === 1 &&
          semanticAliasSelectionChoices(path[0]!).some(
            (key) =>
              key === null || semanticPropertyPathKeyMatches(key, "require"),
          )) &&
      commonJsWrapperBindingDeclaration(value, "module", state) !== undefined &&
      !read.hasDefiniteInitializer
    )
      return true;
    let eligibility = next.eligibility;
    const facts = eligibility
      ? undefined
      : semanticProjectedSourceFactsAtRead(
          binding,
          value,
          path,
          state,
          includeUnknown,
          next.readAt ?? value,
          next.capturedSelections,
        );
    if (retainsMainModule && (eligibility || facts?.retainsOrigin)) return true;
    let sources = eligibility
      ? semanticProjectedSourceEligibilityAtRead(
          binding,
          value,
          path,
          state,
          next.readAt ?? value,
          next.capturedSelections,
        )
      : facts?.sources;
    if (sources === undefined) {
      if (target !== "delegate") return true;
      // An opaque member effect can obscure a selected native delegate, but
      // cannot make every escaped callable a possible Node loader. Keep its
      // receiver's retained sources as the eligibility boundary for that gap.
      sources = semanticProjectedSourceEligibilityAtRead(
        binding,
        value,
        path,
        state,
        next.readAt ?? value,
        next.capturedSelections,
      );
      if (sources === undefined) return true;
      eligibility = true;
    }
    enqueue(
      ...projectedLoaderSources({ ...next, node: value, path }, sources).map(
        (source) => (eligibility ? { ...source, eligibility } : source),
      ),
    );
  }
  return false;
};

/** Select an unchecked member-loader receiver before its identity is examined. */
export const semanticModuleRequireReceiver = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
): t.Node | undefined => {
  let callee = unwrapJavaScriptExpression(node.callee).node;
  while (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    ["bind", "call", "apply"].includes(
      semanticStaticPropertyKey(callee.property, callee.computed) ?? "",
    )
  )
    // Capturing a bound delegate can load outside the visible module graph.
    // Keep that possibility without asserting bind/call/apply is unmodified.
    callee = unwrapJavaScriptExpression(callee.object).node;
  return (t.isMemberExpression(callee) ||
    t.isOptionalMemberExpression(callee)) &&
    semanticStaticPropertyKey(callee.property, callee.computed) === "require"
    ? callee.object
    : undefined;
};

/** Recognize an unchecked module loader without asserting its current delegate. */
export const semanticModuleRequireCallAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  includeUnknown = true,
): boolean => {
  const receiver = semanticModuleRequireReceiver(node);
  if (
    receiver !== undefined &&
    isCommonJsModuleObject(receiver, state, includeUnknown)
  )
    return true;
  let target = unwrapJavaScriptExpression(node.callee).node;
  while (
    (t.isMemberExpression(target) || t.isOptionalMemberExpression(target)) &&
    ["bind", "call", "apply"].includes(
      semanticStaticPropertyKey(target.property, target.computed) ?? "",
    )
  )
    target = unwrapJavaScriptExpression(target.object).node;
  // The callee is selected before the current invocation can escape or mutate
  // its receiver. Earlier captured member reads retain their own source site.
  if (isCommonJsRequireDelegate(target, state, includeUnknown, node))
    return true;
  if (t.isNewExpression(node)) return false;
  const interop = loaderInvocationInterop(state);
  return (
    interop.intrinsicInvocation(node, (callee) =>
      isCommonJsRequireDelegate(callee, state, false, node)
        ? ["commonjs-require-delegate"]
        : interop.intrinsicPath(callee),
    )?.path[0] === "commonjs-require-delegate"
  );
};

const writesModuleRequire = (
  state: JavaScriptSemanticAnalysisState,
): readonly t.Node[] => {
  const cached = moduleRequireWrites.get(state);
  if (cached !== undefined) return cached;
  // Interop invocation resolution may ask for require provenance while this
  // index is being built. Publish a temporary empty result to break that cycle.
  moduleRequireWrites.set(state, []);
  const writes: t.Node[] = [];
  const interop = createSemanticModuleInterop(state);
  const isModuleObject = (node: t.Node): boolean =>
    isCommonJsModuleObject(node, state, false);
  const opaqueReferenceEffect = createSemanticOpaqueReferenceEffectQuery(state);
  const effectIndices = new WeakMap<
    readonly JavaScriptSemanticMemberEffect[],
    SemanticPropertyPathEffectIndex<JavaScriptSemanticMemberEffect>
  >();
  const matchingEffects = (
    effects: readonly JavaScriptSemanticMemberEffect[],
    path: JavaScriptSemanticPropertyPath,
    descendants = true,
  ): Iterable<JavaScriptSemanticMemberEffect> => {
    let index = effectIndices.get(effects);
    if (index === undefined) {
      index = new SemanticPropertyPathEffectIndex();
      for (const effect of effects) index.retain(effect.path, effect);
      effectIndices.set(effects, index);
    }
    return index.matching(path, descendants);
  };
  const isSeparateReceiver = (
    node: t.Node,
    visited = new Set<string>(),
  ): boolean => {
    const expression = unwrapJavaScriptExpression(node).node;
    if (
      t.isSequenceExpression(expression) &&
      expression.expressions
        .slice(0, -1)
        .some((prefix) => exposesModule([prefix], prefix))
    )
      return false;
    const value = javaScriptExpressionValue(node);
    if (
      interop.isFreshObject(value) ||
      (isPrimitiveJavaScriptExpression(expression) &&
        !exposesModule(
          javaScriptScalarEvaluationSources(expression),
          expression,
        )) ||
      (t.isUnaryExpression(value) && !exposesModule([value.argument], value)) ||
      isUnshadowedGlobal(value, state, "undefined")
    )
      return true;
    const evaluated = evaluateSemanticExpression(expression, state, expression);
    if (
      evaluated.status === "literal" ||
      (evaluated.status === "union" && evaluated.values.length > 0)
    )
      return true;
    if ("resourceLimit" in evaluated && evaluated.resourceLimit !== undefined)
      return false;
    if (t.isConditionalExpression(value))
      return (
        isSeparateReceiver(value.consequent, visited) &&
        isSeparateReceiver(value.alternate, visited)
      );
    if (t.isLogicalExpression(value))
      return (
        isSeparateReceiver(value.left, visited) &&
        isSeparateReceiver(value.right, visited)
      );
    const separateNamespace = (origin: JavaScriptModuleOrigin): boolean =>
      isBuiltin(origin.specifier) &&
      (origin.importedPath.length === 0 ||
        (origin.resolutionMode !== "require" &&
          origin.importedPath.length === 1 &&
          origin.importedPath[0] === "default"));
    const required = semanticRequireOrigin(value, state);
    if (required !== undefined && separateNamespace(required.origin))
      return true;
    if (!t.isIdentifier(value)) return false;
    const binding = resolveSemanticBindingState(state, value, value.name);
    if (
      binding === undefined ||
      visited.has(binding.bindingId) ||
      semanticOpaqueBindingReadMayHaveChanged(binding, value, state)
    )
      return false;
    const snapshot = semanticBindingAtRead(binding, value, state.parentsByNode);
    if (snapshot.status !== "ordered") return false;
    const { initializers, referenceInitializers, directOrigins } =
      snapshot.binding;
    if (referenceInitializers.length !== 0) return false;
    if (initializers.length === 0)
      return directOrigins.length > 0 && directOrigins.every(separateNamespace);
    const next = new Set(visited).add(binding.bindingId);
    return initializers.every(
      ({ node: source, projection }) =>
        projection.length === 0 && isSeparateReceiver(source, next),
    );
  };
  // Unknown keys, spread sources and accessors may all replace the delegate.
  const mayContainRequire = (source: t.Node | undefined): boolean =>
    !t.isObjectExpression(source) ||
    source.properties.some((property) => {
      if (t.isSpreadElement(property)) return true;
      const key = semanticStaticPropertyKey(property.key, property.computed);
      return key === null || key === "require";
    });
  // This index is built over a completed binding/ambient-write snapshot. Cache
  // only fully explored module-free node/projection pairs; a partial walk that
  // found exposure cannot establish anything about its other visited nodes.
  const moduleFree = new WeakMap<t.Node, SemanticPropertyPathCoverage>();
  const calleeModuleFree = new WeakMap<t.Node, SemanticPropertyPathCoverage>();
  const plainObject = (
    source: t.Node | undefined,
    seen = new Set<string>(),
  ): t.ObjectExpression | undefined => {
    if (source === undefined) return undefined;
    const value = unwrapJavaScriptExpression(source).node;
    if (t.isObjectExpression(value))
      return value.properties.every(t.isObjectProperty) ? value : undefined;
    if (!t.isIdentifier(value)) return undefined;
    const binding = resolveSemanticBindingState(state, value, value.name);
    if (
      binding === undefined ||
      seen.has(binding.bindingId) ||
      binding.memberWrites.length > 0 ||
      binding.escapedPaths.length > 0
    )
      return undefined;
    const initializer = semanticStableInitializer(binding, state);
    return initializer?.projection.length === 0
      ? plainObject(initializer.node, new Set(seen).add(binding.bindingId))
      : undefined;
  };
  // Member effects already own aliases, selected paths and ordering. Follow
  // their assigned values instead of treating every write as the wrapper.
  // Accessors and unproven descriptor/source maps remain conservative.
  const ambientEffectAt = createSemanticAmbientEffectQuery(state);
  const awaitMayAssimilate = (operand: t.Node, at: t.Node): boolean => {
    if (
      isPrimitiveJavaScriptExpression(operand) ||
      isUnshadowedGlobal(operand, state, "undefined")
    )
      return false;
    const value = evaluateSemanticExpression(operand, state, at);
    if (
      value.status === "literal" ||
      (value.status === "union" && value.values.length > 0)
    )
      return false;
    if (value.status !== "object" && value.status !== "array") return true;
    const then = semanticSlotAtPath(value, ["then"]);
    if (
      then.presence === "present" &&
      (then.value.status === "literal" ||
        (then.value.status === "union" && then.value.values.length > 0))
    )
      return false;
    if (then.presence !== "absent") return true;
    return (
      ambientEffectAt(["global", "Object", "prototype", "then"], at) ||
      (value.status === "array" &&
        ambientEffectAt(["global", "Array", "prototype", "then"], at))
    );
  };
  const returnedReferences = createSemanticReturnedReferences(state);
  const callableById = new Map(
    state.callables.map((callable) => [callable.callableId, callable]),
  );
  const callableCache = new WeakMap<t.Identifier, LocalCallableResolution>();
  const inheritedDescriptorFieldChanged = (
    field: string,
    at: t.Node,
    consumedAt: t.Node,
  ): boolean => {
    // A deferred descriptor may run before this consumer, but a prototype write
    // ordered after the consumer cannot supply that earlier descriptor value.
    return ambientEffectAt(
      ["global", "Object", "prototype", field],
      at,
      consumedAt,
    );
  };
  const writtenValues = (
    mutation: t.Node | undefined,
    key: string,
    consumedAt = mutation,
  ):
    | readonly { node: t.Node; path: JavaScriptSemanticPropertyPath }[]
    | undefined => {
    if (t.isAssignmentExpression(mutation))
      return ["=", "||=", "&&=", "??="].includes(mutation.operator)
        ? [{ node: mutation.right, path: [] }]
        : undefined;
    if (!t.isCallExpression(mutation) && !t.isOptionalCallExpression(mutation))
      return undefined;
    const invocation = interop.intrinsicInvocation(mutation);
    const args = invocation?.arguments;
    if (
      invocation?.kind !== "known" ||
      args === undefined ||
      args.some(t.isSpreadElement)
    )
      return undefined;
    const operation = invocation.path.join(".");
    if (operation === "intrinsic.Reflect.set" && args[2] !== undefined)
      return [{ node: args[2], path: [] }];
    if (operation === "intrinsic.Object.assign")
      return args.slice(1).every((source) => plainObject(source) !== undefined)
        ? args.slice(1).map((node) => ({ node, path: [key] }))
        : undefined;
    let descriptor: t.Node | undefined;
    if (operation === "intrinsic.Object.defineProperties") {
      const properties = plainObject(args[1]);
      if (
        properties?.properties.some(
          (property) =>
            !t.isObjectProperty(property) ||
            semanticStaticPropertyKey(property.key, property.computed) === null,
        )
      )
        return undefined;
      const selected = properties?.properties.findLast(
        (property) =>
          t.isObjectProperty(property) &&
          semanticStaticPropertyKey(property.key, property.computed) === key,
      );
      if (t.isObjectProperty(selected)) descriptor = selected.value;
    } else if (
      [
        "intrinsic.Object.defineProperty",
        "intrinsic.Reflect.defineProperty",
      ].includes(operation)
    )
      descriptor = args[2];
    const data = plainObject(descriptor);
    if (
      data === undefined ||
      !data.properties.every(
        (property) =>
          t.isObjectProperty(property) &&
          ["value", "writable", "enumerable", "configurable"].includes(
            semanticStaticPropertyKey(property.key, property.computed) ?? "",
          ),
      )
    )
      return undefined;
    // ToPropertyDescriptor also reads inherited fields. An omitted value is
    // only module-free while its prototype lookup remains unmodified; own
    // fields shadow that lookup, and plainObject already excludes accessors.
    for (const field of [
      "value",
      "writable",
      "enumerable",
      "configurable",
      "get",
      "set",
    ])
      if (
        !data.properties.some(
          (property) =>
            t.isObjectProperty(property) &&
            semanticStaticPropertyKey(property.key, property.computed) ===
              field,
        ) &&
        inheritedDescriptorFieldChanged(field, mutation, consumedAt ?? mutation)
      )
        return undefined;
    return [{ node: data, path: ["value"] }];
  };
  // Resolve only ordered, exact literal allocations. Unknown aliases, getters,
  // conditional replacements and computed slots cannot prove distinct owners.
  const nativeDataDefinition = (node: t.Node | undefined): boolean => {
    if (!t.isCallExpression(node)) return false;
    const invocation = interop.intrinsicInvocation(node);
    if (
      invocation?.kind !== "known" ||
      ![
        "intrinsic.Object.defineProperty",
        "intrinsic.Reflect.defineProperty",
      ].includes(invocation.path.join("."))
    )
      return false;
    const descriptor = plainObject(invocation.arguments?.[2]);
    return (
      descriptor !== undefined &&
      descriptor.properties.some(
        (property) =>
          t.isObjectProperty(property) &&
          semanticStaticPropertyKey(property.key, property.computed) ===
            "value",
      ) &&
      descriptor.properties.every((property) => {
        if (!t.isObjectProperty(property)) return false;
        const key = semanticStaticPropertyKey(property.key, property.computed);
        return (
          key !== null &&
          key !== "get" &&
          key !== "set" &&
          (key !== "writable" ||
            t.isBooleanLiteral(property.value, { value: true }))
        );
      })
    );
  };
  const nativeReplacements = new WeakMap<t.Node, boolean>();
  const nativeReplacement = (node: t.Node | undefined): boolean => {
    if (!t.isCallExpression(node)) return false;
    const cached = nativeReplacements.get(node);
    if (cached !== undefined) return cached;
    nativeReplacements.set(node, false);
    const invocation = interop.intrinsicInvocation(node);
    const args = invocation?.arguments;
    if (
      invocation?.kind !== "known" ||
      args === undefined ||
      args.length < 3 ||
      args.some(t.isSpreadElement)
    )
      return false;
    let ancestor: t.Node | undefined = args[0];
    while (ancestor !== undefined && ancestor !== node)
      ancestor = state.parentsByNode.get(ancestor);
    if (ancestor === undefined) {
      // Normalized bound inputs retain their capture location. Compare the
      // complete target allocation, including member projections, rather than
      // only its root binding: holder.inner may change while holder does not.
      const captured = literalAllocation(args[0]!, [], args[0]!);
      if (
        captured === undefined ||
        captured !== literalAllocation(args[0]!, [], node)
      )
        return false;
    }
    const operation = invocation.path.join(".");
    if (operation === "intrinsic.Object.defineProperty") {
      const definite = nativeDataDefinition(node);
      nativeReplacements.set(node, definite);
      return definite;
    }
    if (
      operation !== "intrinsic.Reflect.set" &&
      (operation !== "intrinsic.Reflect.defineProperty" ||
        !nativeDataDefinition(node))
    )
      return false;
    const key = interop.staticPropertyKey(args[1]);
    if (key === undefined || key === "__proto__") return false;
    const target = literalAllocation(args[0]!, [], node);
    // A literal's own data slot starts writable. The allocation proof checks
    // prior escapes and every intervening write, rejecting descriptor changes
    // that could remove writability. Reflect can then complete this replacement.
    const ownData =
      t.isObjectExpression(target) &&
      target.properties.some(
        (property) =>
          t.isObjectProperty(property) &&
          semanticStaticPropertyKey(property.key, property.computed) === key,
      ) &&
      literalAllocation(args[0]!, [key], node) !== undefined;
    const sameReceiver =
      operation !== "intrinsic.Reflect.set" ||
      args[3] === undefined ||
      // Normalized arguments keep their original evaluation sites, including
      // bound receivers captured before a later member/root reassignment.
      literalAllocation(args[3], [], args[3]) === target;
    let compatible = true;
    if (operation === "intrinsic.Reflect.defineProperty") {
      const descriptor = plainObject(args[2]);
      // A writable data slot permits a value change and tightening configurable.
      // Relaxing configurable or specifying enumerable needs the original,
      // untouched literal descriptor (writable/enumerable/configurable=true).
      // Allocation identity alone cannot prove those flags after a definition.
      const untouched = () =>
        literalAllocation(args[0]!, [key], node, true) !== undefined;
      compatible =
        descriptor !== undefined &&
        descriptor.properties.every((property) => {
          if (!t.isObjectProperty(property)) return false;
          const field = semanticStaticPropertyKey(
            property.key,
            property.computed,
          );
          if (field !== "configurable" && field !== "enumerable") return true;
          if (!t.isBooleanLiteral(property.value)) return false;
          return (
            (field === "configurable" && !property.value.value) || untouched()
          );
        });
    }
    const definite = ownData && sameReceiver && compatible;
    nativeReplacements.set(node, definite);
    return definite;
  };
  const definiteReplacements = new WeakMap<t.Node, boolean>();
  const isDefiniteReplacement = (node: t.Node | undefined): boolean => {
    if (node === undefined) return false;
    const cached = definiteReplacements.get(node);
    if (cached !== undefined) return cached;
    // The member-effect index records possible writes, including a native
    // mutator's target when a different receiver is written, and descriptor
    // changes that can make a subsequent ordinary assignment fail. Such calls
    // cannot establish a completed replacement of the indexed slot.
    let definite =
      t.isAssignmentExpression(node, { operator: "=" }) ||
      nativeReplacement(node);
    let child = node;
    for (
      let parent = state.parentsByNode.get(child);
      definite && parent !== undefined && !t.isFunction(parent);
      parent = state.parentsByNode.get(child)
    ) {
      // A break or continue can bypass a replacement while the later read runs.
      // Use the same unconditional-body restriction as initializer projection.
      if (
        t.isLabeledStatement(parent) ||
        t.isLoop(parent) ||
        semanticBranchMayBeSkipped(parent, child)
      )
        definite = false;
      child = parent;
    }
    definiteReplacements.set(node, definite);
    return definite;
  };
  const allocationWriteIndices = new WeakMap<
    JavaScriptSemanticBindingState,
    {
      exact: Map<string, JavaScriptSemanticMemberEffect[]>;
      unknown: JavaScriptSemanticMemberEffect[];
    }
  >();
  const definitelyWritesPath = (
    effect: JavaScriptSemanticMemberEffect,
    owner: JavaScriptSemanticBindingState,
  ): boolean => {
    const mutation = effect.node;
    let source: t.Node | undefined;
    let path: readonly (string | number | null)[] = [];
    if (t.isAssignmentExpression(mutation)) source = mutation.left;
    else if (t.isCallExpression(mutation)) {
      const invocation = interop.intrinsicInvocation(mutation);
      source = invocation?.arguments?.[0];
      path = [interop.staticPropertyKey(invocation?.arguments?.[1]) ?? null];
    }
    const visited = new Set<string>();
    while (source !== undefined) {
      const { root, members } = electronMemberPath(
        javaScriptExpressionValue(source),
      );
      path = [...members, ...path];
      if (!t.isIdentifier(root) || path.includes(null)) return false;
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (binding === owner)
        return (
          (visited.size === 0 ||
            semanticStableInitializer(owner, state) !== undefined) &&
          path.length === effect.path.length &&
          path.every((key, index) => key === effect.path[index])
        );
      if (binding === undefined || visited.has(binding.bindingId)) return false;
      visited.add(binding.bindingId);
      const read = semanticBindingAtRead(binding, root, state.parentsByNode);
      if (
        read.status !== "ordered" ||
        !read.hasDefiniteInitializer ||
        read.binding.initializers.length !== 1 ||
        read.binding.referenceInitializers.length !== 0
      )
        return false;
      const initializer = read.binding.initializers[0]!;
      source = initializer.node;
      path = [...initializer.projection, ...path];
    }
    return false;
  };
  const allocationWritesAtPath = (
    binding: JavaScriptSemanticBindingState,
    path: JavaScriptSemanticPropertyPath,
  ): readonly JavaScriptSemanticMemberEffect[] => {
    let index = allocationWriteIndices.get(binding);
    if (index === undefined) {
      index = { exact: new Map(), unknown: [] };
      for (const effect of binding.memberWrites) {
        if (effect.path.some((key) => key === null || typeof key === "object"))
          index.unknown.push(effect);
        else {
          const key = JSON.stringify(effect.path.map(String));
          const values = index.exact.get(key) ?? [];
          values.push(effect);
          index.exact.set(key, values);
        }
      }
      allocationWriteIndices.set(binding, index);
    }
    const effects = [...index.unknown];
    for (let length = 0; length <= path.length; length++)
      effects.push(
        ...(index.exact.get(
          JSON.stringify(path.slice(0, length).map(String)),
        ) ?? []),
      );
    return effects;
  };
  const literalAllocation = (
    source: t.Node,
    path: JavaScriptSemanticPropertyPath,
    at: t.Node,
    untouched = false,
  ): t.Node | undefined => {
    const seen = new Set<t.Node>();
    while (true) {
      const value = javaScriptExpressionValue(source);
      if (
        seen.has(value) ||
        path.some((key) => key === null || typeof key === "object")
      )
        return undefined;
      seen.add(value);
      if (t.isMemberExpression(value) || t.isOptionalMemberExpression(value)) {
        const key = semanticStaticPropertyKey(value.property, value.computed);
        if (key === null) return undefined;
        source = value.object;
        path = [key, ...path];
        continue;
      }
      if (t.isIdentifier(value)) {
        const binding = resolveSemanticBindingState(state, value, value.name);
        if (binding === undefined) return undefined;
        if (
          path.length > 0 &&
          binding.escapedPaths.some(
            (effect) =>
              effect.node !== at &&
              effect.path.length < path.length &&
              effect.path.every((key, index) =>
                semanticPropertyPathKeyMatches(key, String(path[index])),
              ) &&
              semanticEffectTiming(at, effect.node, state) !== "after" &&
              !nativeReplacement(effect.node),
          )
        )
          return undefined;
        let latest: JavaScriptSemanticMemberEffect | undefined;
        if (path.length > 0)
          for (const effect of allocationWritesAtPath(binding, path)) {
            // Allocation inputs are read before this invocation performs its
            // own write. This also bounds recursive native replacement proof.
            if (effect.node === at) continue;
            if (
              effect.path.length > path.length ||
              !effect.path.every((key, index) =>
                semanticPropertyPathKeyMatches(key, String(path[index])),
              )
            )
              continue;
            const timing = semanticEffectTiming(at, effect.node, state);
            if (timing === "after") continue;
            if (untouched) return undefined;
            if (
              timing !== "before" ||
              !isDefiniteReplacement(effect.node) ||
              !definitelyWritesPath(effect, binding) ||
              effect.path.some((key) => typeof key !== "string")
            )
              return undefined;
            if (latest === undefined) latest = effect;
            else {
              const order = semanticEffectTiming(
                latest.node!,
                effect.node,
                state,
              );
              if (order === "unknown") return undefined;
              if (order === "after") latest = effect;
            }
          }
        if (latest !== undefined) {
          const references = writtenValues(
            latest.node,
            String(latest.path.at(-1)),
          );
          if (references?.length !== 1) return undefined;
          const reference = references[0]!;
          source = reference.node;
          path = [...reference.path, ...path.slice(latest.path.length)];
          at = latest.node!;
          continue;
        }
        const snapshot = semanticBindingAtRead(
          binding,
          at,
          state.parentsByNode,
        );
        if (
          snapshot.status !== "ordered" ||
          snapshot.binding.initializers.length !== 1 ||
          snapshot.binding.referenceInitializers.length !== 0
        )
          return undefined;
        const initializer = snapshot.binding.initializers[0]!;
        const initial = unwrapJavaScriptExpression(initializer.node).node;
        // A saved child followed by another selection needs separate capture and
        // use clocks; leave that unresolved instead of assigning it a new owner.
        if (
          path.length > 0 &&
          (initializer.projection.length > 0 ||
            t.isMemberExpression(initial) ||
            t.isOptionalMemberExpression(initial))
        )
          return undefined;
        source = initializer.node;
        if (path.length === 0) at = initializer.node;
        path = [...initializer.projection, ...path];
        continue;
      }
      if (t.isObjectExpression(value)) {
        if (path.length === 0) return value;
        if (
          !value.properties.every(
            (property) =>
              t.isObjectProperty(property) &&
              semanticStaticPropertyKey(property.key, property.computed) !==
                null,
          )
        )
          return undefined;
        const property = value.properties.findLast(
          (property) =>
            t.isObjectProperty(property) &&
            semanticStaticPropertyKey(property.key, property.computed) ===
              String(path[0]),
        );
        if (!t.isObjectProperty(property)) return undefined;
        source = property.value;
        path = path.slice(1);
        continue;
      }
      if (t.isArrayExpression(value) && path.length === 0) return value;
      return undefined;
    }
  };
  const writesSeparateChild = (
    source: t.Node,
    path: JavaScriptSemanticPropertyPath,
    capturedAt: t.Node,
    effect: JavaScriptSemanticMemberEffect,
  ): boolean => {
    if (
      path.length === 0 ||
      effect.path.length <= path.length ||
      effect.path.some((key) => typeof key !== "string")
    )
      return false;
    const mutation = effect.node;
    let receiver: t.Node | undefined;
    if (
      t.isAssignmentExpression(mutation) &&
      (t.isMemberExpression(mutation.left) ||
        t.isOptionalMemberExpression(mutation.left))
    )
      receiver = mutation.left.object;
    else if (
      t.isCallExpression(mutation) ||
      t.isOptionalCallExpression(mutation)
    ) {
      const invocation = interop.intrinsicInvocation(mutation);
      if (
        invocation?.kind === "known" &&
        [
          "intrinsic.Object.assign",
          "intrinsic.Object.defineProperty",
          "intrinsic.Object.defineProperties",
          "intrinsic.Reflect.defineProperty",
        ].includes(invocation.path.join("."))
      )
        receiver = invocation.arguments?.[0];
    }
    for (
      let remaining = effect.path.length - path.length - 1;
      remaining > 0 && receiver !== undefined;
      remaining--
    ) {
      const value = unwrapJavaScriptExpression(receiver).node;
      receiver =
        t.isMemberExpression(value) || t.isOptionalMemberExpression(value)
          ? value.object
          : undefined;
    }
    if (receiver === undefined) return false;
    const saved = literalAllocation(source, path, capturedAt);
    const written = literalAllocation(receiver, [], receiver);
    return saved !== undefined && written !== undefined && saved !== written;
  };
  const exposesModule = (
    nodes: readonly t.Node[],
    call: t.Node,
    calleeRoot = false,
  ): boolean => {
    // A callee can carry bound inputs; its implementation is not itself a
    // value supplied to unknown code. Keep those two absence proofs separate.
    const pending: {
      node: t.Node;
      path: JavaScriptSemanticPropertyPath;
      readAt?: t.Node;
      // Discharging a recorded write requires a positive module-free proof;
      // unknown call results and closures must retain the original uncertainty.
      written?: true;
      callee?: true;
      // The immediate prefix may itself be scalar (name in name.length).
      // Earlier ancestors and opaque binding effects can replace that scalar.
      changed?: "parent" | "ancestor";
    }[] = nodes.map((node) => ({
      node,
      path: [],
      ...(calleeRoot ? { callee: true } : {}),
    }));
    const traversals = Array.from(
      { length: 12 },
      () => new WeakMap<t.Node, Map<t.Node, SemanticPropertyPathCoverage>>(),
    );
    let timeDependent = false;
    const examined: {
      node: t.Node;
      path: JavaScriptSemanticPropertyPath;
      callee?: true;
    }[] = [];
    while (pending.length > 0) {
      const {
        node: source,
        path,
        readAt: capturedAt,
        written,
        callee,
        changed: inheritedChange,
      } = pending.pop()!;
      let changed = inheritedChange;
      const provenFree = callee ? calleeModuleFree : moduleFree;
      const value = unwrapJavaScriptExpression(source).node;
      const readAt = capturedAt ?? value;
      const traversal =
        traversals[
          (inheritedChange === "ancestor"
            ? 8
            : inheritedChange === "parent"
              ? 4
              : 0) +
            (callee ? 2 : 0) +
            (written ? 1 : 0)
        ]!;
      const captures =
        traversal.get(value) ?? new Map<t.Node, SemanticPropertyPathCoverage>();
      const coverage =
        captures.get(readAt) ?? new SemanticPropertyPathCoverage();
      if (coverage.covers(path)) continue;
      coverage.retain(path);
      captures.set(readAt, coverage);
      traversal.set(value, captures);
      const binding = t.isIdentifier(value)
        ? resolveSemanticBindingState(state, value, value.name)
        : undefined;
      if (binding !== undefined && path.length > 0) {
        // A selected scalar is captured at its read. Escaping an ancestor
        // before that read can replace the slot; escaping the selected value
        // itself cannot replace the property that already supplied it.
        const opaque = opaqueReferenceEffect(binding, readAt);
        if (opaque !== undefined) timeDependent = true;
        if (opaque === true) changed = "ancestor";
        for (const effect of matchingEffects(
          binding.escapedPaths,
          path,
          false,
        )) {
          if (
            effect.path.length >= path.length ||
            !effect.path.every((key, index) => {
              const selected = path[index];
              return (
                selected === null ||
                typeof selected === "object" ||
                semanticPropertyPathKeyMatches(key, String(selected))
              );
            })
          )
            continue;
          timeDependent = true;
          if (
            effect.node !== call &&
            semanticEffectTiming(readAt, effect.node, state) !== "after" &&
            !nativeReplacement(effect.node)
          )
            changed =
              changed === "ancestor" || effect.path.length < path.length - 1
                ? "ancestor"
                : "parent";
        }
      }
      const context = {
        ...(written ? { written } : {}),
        ...(callee ? { callee } : {}),
        ...(changed ? { changed } : {}),
      };
      for (const effect of binding === undefined
        ? []
        : matchingEffects(binding.memberWrites, path)) {
        if (
          !effect.path.slice(0, path.length).every((key, index) => {
            const selected = path[index];
            return (
              selected === null ||
              typeof selected === "object" ||
              semanticPropertyPathKeyMatches(key, String(selected))
            );
          })
        )
          continue;
        // A saved object's contents remain shared through this call; replacing
        // its selected parent slot is checked at the earlier capture instead.
        // Such timing-dependent proofs cannot be reused at
        // another alias use merely because they reached the same initializer.
        timeDependent = true;
        if (
          effect.node !== call &&
          effect.node !== state.parentsByNode.get(readAt) &&
          semanticEffectTiming(
            effect.path.length > path.length ? call : readAt,
            effect.node,
            state,
          ) !== "after" &&
          !writesSeparateChild(value, path, readAt, effect)
        ) {
          const key = effect.path.at(-1);
          const values =
            effect.path.every((part) => typeof part === "string") &&
            typeof key === "string"
              ? writtenValues(effect.node, key, call)
              : undefined;
          if (values === undefined) return true;
          for (const reference of values)
            pending.push({
              node: reference.node,
              path: [...reference.path, ...path.slice(effect.path.length)],
              readAt,
              ...context,
              written: true,
            });
        }
      }
      if (!written && !changed && provenFree.get(value)?.covers(path)) continue;
      examined.push({ node: value, path, ...(callee ? { callee } : {}) });
      for (const reference of interop.intrinsicValueReferences(value))
        pending.push({
          node: reference.node,
          path: [...reference.path, ...path],
          readAt: reference.readAt ?? reference.node,
          ...context,
        });
      if (isModuleObject(value)) {
        if (path.length === 0) return true;
        const first = path[0];
        if (
          typeof first === "string" &&
          ["id", "filename", "loaded"].includes(first) &&
          !state.ambientWrites.covers(["commonjs-module", first])
        )
          continue;
        return true;
      }
      if (t.isIdentifier(value)) {
        if (
          written &&
          (binding === undefined || binding.initializers.length === 0) &&
          !isUnshadowedGlobal(value, state, "undefined")
        )
          return true;
        if (binding !== undefined) {
          // Initializers do not prove a subsequently changed property module-free.
          // Consume the alias-aware effect owner, preserving unrelated slots,
          // earlier saved values and the current call's own argument exposure.
          for (const initializer of semanticBindingAtRead(
            binding,
            value,
            state.parentsByNode,
          ).binding.initializers)
            pending.push({
              node: initializer.node,
              readAt:
                initializer.projection.length > 0 && path.length === 0
                  ? initializer.node
                  : readAt,
              path: [
                ...initializer.projection.map((key) =>
                  key === null ? null : String(key),
                ),
                ...path,
              ],
              ...context,
            });
        }
      } else if (t.isSpreadElement(value))
        pending.push({
          node: value.argument,
          path,
          readAt,
          ...context,
        });
      else if (t.isArrayExpression(value)) {
        if (changed === "ancestor" && path.length > 0) return true;
        const [key, ...remaining] = path;
        const shifted = value.elements.some(t.isSpreadElement);
        for (let index = 0; index < value.elements.length; index++) {
          const element = value.elements[index];
          if (
            element !== null &&
            element !== undefined &&
            (key === undefined ||
              shifted ||
              semanticPropertyPathKeyMatches(key, String(index)) ||
              t.isSpreadElement(element))
          )
            pending.push({
              node: element,
              path: key === undefined ? [] : remaining,
              readAt,
              ...context,
            });
        }
      } else if (t.isObjectExpression(value)) {
        if (changed === "ancestor" && path.length > 0) return true;
        pending.push(
          ...semanticObjectPropertyReferences(value, path, state).map(
            (reference) => ({
              ...reference,
              readAt,
              ...context,
            }),
          ),
        );
      } else if (
        t.isMemberExpression(value) ||
        t.isOptionalMemberExpression(value)
      ) {
        if (value.computed)
          pending.push({
            node: value.property,
            path: [],
            readAt: value.property,
          });
        pending.push({
          node: value.object,
          readAt: path.length === 0 ? value : readAt,
          path: [
            semanticStaticPropertyKey(value.property, value.computed),
            ...path,
          ],
          ...context,
        });
      } else if (
        t.isConditionalExpression(value) ||
        t.isLogicalExpression(value)
      ) {
        pending.push(
          {
            node: t.isConditionalExpression(value)
              ? value.consequent
              : value.left,
            path,
            readAt,
            ...context,
          },
          {
            node: t.isConditionalExpression(value)
              ? value.alternate
              : value.right,
            path,
            readAt,
            ...context,
          },
        );
      } else if (t.isSequenceExpression(value)) {
        const last = value.expressions.at(-1);
        if (last !== undefined)
          pending.push({
            node: last,
            path,
            readAt,
            ...context,
          });
      } else if (t.isAssignmentExpression(value)) {
        if (["=", "||=", "&&=", "??="].includes(value.operator))
          pending.push({
            node: value.right,
            path,
            readAt,
            ...context,
          });
        if (["||=", "&&=", "??="].includes(value.operator))
          pending.push({
            node: value.left,
            path,
            readAt,
            ...context,
          });
        if (!["=", "||=", "&&=", "??="].includes(value.operator))
          pending.push(
            ...[value.left, value.right].map((node) => ({
              node,
              path: [],
              readAt,
            })),
          );
      } else if (t.isUpdateExpression(value)) {
        pending.push({ node: value.argument, path: [], readAt });
      } else if (t.isFunction(value) || t.isClass(value)) {
        // Binding/member effects above still own overwritten metadata. Resolve
        // the selected intrinsic scalar before treating the whole callable as
        // a value that unknown code can invoke.
        if (isPrimitiveJavaScriptCallableProperty(value, path)) {
          if (
            changed !== undefined &&
            (changed !== "parent" ||
              !isPrimitiveJavaScriptCallableProperty(value, path.slice(0, -1)))
          )
            return true;
          continue;
        }
        // A callable value can expose captures or results when unknown code
        // invokes it. Merely allocating the callable proves neither absent.
        if (!callee) return true;
      } else if (
        t.isNewExpression(value) ||
        t.isTaggedTemplateExpression(value)
      ) {
        // Construction can expose instance fields even when an explicit return
        // is primitive. Neither it nor a tagged-template invocation uses the
        // ordinary call-result proof below.
        return true;
      } else if (
        t.isCallExpression(value) ||
        t.isOptionalCallExpression(value)
      ) {
        // Bound intrinsic references were expanded above at their capture sites.
        const bound = interop.boundIntrinsic(value);
        if (bound?.kind === "known") {
          pending.push(
            ...[
              ...(bound.receiver === undefined ? [] : [bound.receiver]),
              ...(bound.arguments ?? []),
            ].map((node) => ({
              node,
              path: [],
              readAt: node,
            })),
          );
          continue;
        }
        // A callable result can carry module even with no arguments. Unknown
        // or partial candidates cannot prove absence. Use the call-target
        // owner's completeness contract; returned references only expose
        // positive possibilities and intentionally do not prove method slots.
        const callable = resolveLocalCallables({
          node: value.callee,
          state,
          callableById,
          bindingCache: callableCache,
          seenInitializers: new Set(),
        });
        if (!callable.complete) return true;
        const returned = returnedReferences(value.callee, value);
        if (returned.unresolvedInvocation) return true;
        const results = returned.references;
        if (results.length === 0) return true;
        pending.push(
          ...value.arguments.map((node) => ({ node, path: [], readAt })),
          ...results.map((reference) => ({
            node: reference.node,
            path: [...reference.projection, ...path],
            readAt,
            ...context,
            written: true as const,
          })),
        );
      } else if (t.isAwaitExpression(value)) {
        // Then is looked up at suspension, including inherited slots. The own
        // slot inventory can prove a non-callable override; unknown coverage
        // cannot establish that the resumed value is the original operand.
        timeDependent = true;
        if (awaitMayAssimilate(value.argument, value)) return true;
        pending.push({
          node: value.argument,
          path,
          readAt,
          ...context,
          written: true,
        });
      } else if (t.isYieldExpression(value)) {
        // The caller supplies a yield expression's resumed value.
        return true;
      } else if (
        t.isBinaryExpression(value) ||
        t.isUnaryExpression(value) ||
        t.isTemplateLiteral(value)
      ) {
        // Scalar results do not expose their operands to the replacement.
        // Keep effectful subexpressions separate from the scalar result:
        // typeof change(module) still evaluates the call, and a strict
        // comparison can contain a coercive arithmetic operand.
        if (isPrimitiveJavaScriptExpression(value)) {
          pending.push(
            ...javaScriptScalarEvaluationSources(value).map((node) => ({
              node,
              path: [],
              readAt,
            })),
          );
          continue;
        }
        const operands = t.isBinaryExpression(value)
          ? [value.left, value.right]
          : t.isUnaryExpression(value)
            ? [value.argument]
            : value.expressions;
        pending.push(...operands.map((node) => ({ node, path: [], readAt })));
      } else if (
        written &&
        !readExactJavaScriptLiteral(value).found &&
        !t.isUnaryExpression(value) &&
        !t.isBinaryExpression(value) &&
        !t.isTemplateLiteral(value) &&
        !t.isUpdateExpression(value)
      )
        return true;
    }
    if (timeDependent) return false;
    for (const { node, path, callee } of examined) {
      const provenFree = callee ? calleeModuleFree : moduleFree;
      const coverage =
        provenFree.get(node) ?? new SemanticPropertyPathCoverage();
      coverage.retain(path);
      provenFree.set(node, coverage);
    }
    return false;
  };
  traverseJavaScriptValueAst(state.program, state.erasedSyntaxNodes, {
    enter: (node) => {
      const target = t.isAssignmentExpression(node)
        ? node.left
        : t.isUpdateExpression(node) ||
            t.isUnaryExpression(node, { operator: "delete" })
          ? node.argument
          : undefined;
      if (
        t.isMemberExpression(target) ||
        t.isOptionalMemberExpression(target)
      ) {
        const key = semanticStaticPropertyKey(target.property, target.computed);
        if (
          (key === "require" || (key === null && target.computed)) &&
          isModuleObject(target.object)
        )
          writes.push(node);
      }
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        const invocation = interop.intrinsicInvocation(node);
        if (
          invocation?.kind === "opaque" &&
          ((invocation.path[1] === "Object" &&
            ["assign", "defineProperty", "defineProperties"].includes(
              invocation.path[2] ?? "",
            )) ||
            (invocation.path[1] === "Reflect" &&
              invocation.path[2] === "set")) &&
          invocation.path.at(-1) !== "bind"
        ) {
          // An overwritten callable does not retain native mutator argument
          // semantics. Preserve any module reference supplied directly,
          // through call/apply containers or a captured bound argument.
          if (
            exposesModule(node.arguments, node) ||
            exposesModule([node.callee], node, true)
          )
            writes.push(node);
          return;
        }
        const owner =
          invocation?.path?.length === 3 ? invocation.path[1] : undefined;
        const method = invocation?.path?.at(-1);
        const args = invocation?.arguments;
        if (
          (owner === "Object" || owner === "Reflect") &&
          method === "defineProperty" &&
          isModuleObject(args?.[0] ?? t.nullLiteral())
        ) {
          const key = interop.staticPropertyKey(args?.[1]);
          if (key === "require" || key === undefined) writes.push(node);
        } else if (owner === "Reflect" && method === "set") {
          const key = args?.slice(0, 2).some(t.isSpreadElement)
            ? undefined
            : args !== undefined && args.length < 2
              ? "undefined"
              : interop.staticPropertyKey(args?.[1]);
          if (key !== "require" && key !== undefined) return;
          // Ordinary [[Set]] writes the receiver, which defaults to the target
          // only when omitted. An unknown receiver can still be this module.
          const receiver =
            args !== undefined && args.length >= 4 ? args[3] : args?.[0];
          if (
            receiver === undefined ||
            args?.slice(0, 4).some(t.isSpreadElement)
          ) {
            writes.push(node);
            return;
          }
          if (!isSeparateReceiver(receiver)) writes.push(node);
        } else if (
          owner === "Object" &&
          method === "defineProperties" &&
          isModuleObject(args?.[0] ?? t.nullLiteral())
        ) {
          const descriptors = args?.[1];
          if (mayContainRequire(descriptors)) writes.push(node);
        } else if (
          owner === "Object" &&
          method === "assign" &&
          isModuleObject(args?.[0] ?? t.nullLiteral())
        ) {
          if (args?.slice(1).some(mayContainRequire)) writes.push(node);
        }
      }
    },
  });
  moduleRequireWrites.set(state, writes);
  return writes;
};

/** Whether the original global process object can still own effects at this source site. */
export const semanticOriginalGlobalProcessAt = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let replacements = globalProcessReplacements.get(state);
  if (replacements === undefined) {
    replacements = [
      ...state.ambientWriteEffects
        .filter(
          ({ path }) =>
            path.length <= 2 &&
            path.every((key, index) =>
              semanticPropertyPathKeyMatches(
                key,
                ["global", "process"][index]!,
              ),
            ),
        )
        .map(({ node: write }) => write),
      ...(state.ambientBindingWrites.get("process") ?? []),
    ];
    globalProcessReplacements.set(state, replacements);
  }
  return !replacements.some(
    (write) =>
      !semanticTopLevelEffectFollowsCapture(node, write, state.parentsByNode),
  );
};

/** Node's unbound process reference shares the cached process exports object. */
export const semanticGlobalProcessOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined =>
  t.isIdentifier(node, { name: "process" }) &&
  resolveSemanticBindingState(state, node, "process") === undefined &&
  !semanticResolutionBlocked(state, node, "process") &&
  semanticOriginalGlobalProcessAt(node, state)
    ? { specifier: "node:process", importedPath: [], resolutionMode: "require" }
    : undefined;

/** Resolve qualified global-object process references, preserving their selected path. */
export const semanticGlobalProcessPathOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined => {
  const chain = semanticMemberChain(node);
  if (chain === undefined) return undefined;
  const { root: current, members } = chain;
  if (
    !t.isIdentifier(current) ||
    !["globalThis", "global", "window", "self"].includes(current.name) ||
    resolveSemanticBindingState(state, current, current.name) !== undefined ||
    semanticResolutionBlocked(state, current, current.name) ||
    members[0] !== "process" ||
    !semanticOriginalGlobalProcessAt(node, state)
  )
    return undefined;
  return {
    specifier: "node:process",
    importedPath: members.slice(1),
    resolutionMode: "require",
  };
};

/** Recover an unshadowed literal require origin and its exact member path. */
export const semanticRequireOrigin = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptRequireOrigin | undefined => {
  const chain = semanticMemberChain(node);
  const current = chain?.root;
  if (
    chain === undefined ||
    !t.isCallExpression(current) ||
    !t.isIdentifier(current.callee, { name: "require" })
  )
    return undefined;
  if (commonJsDelegateChangedAt(current, state)) return undefined;
  const requireBinding = resolveSemanticBindingState(
    state,
    current.callee,
    "require",
  );
  if (
    (requireBinding !== undefined &&
      !isUnmodifiedCommonJsWrapperBinding(current.callee, "require", state) &&
      !isWrapperRequireInitializerCall(requireBinding, current, state)) ||
    (requireBinding === undefined &&
      (javaScriptRuntimeContext(state.program) === "module" ||
        semanticResolutionBlocked(state, current.callee, "require"))) ||
    (state.ambientBindingWrites.get("require") ?? []).some(
      (write) =>
        !semanticTopLevelEffectFollowsCapture(
          current,
          write,
          state.parentsByNode,
        ),
    )
  )
    return undefined;
  const specifier = stringValue(current.arguments[0]);
  return specifier === undefined
    ? undefined
    : {
        origin: {
          specifier,
          importedPath: chain.members,
          resolutionMode: "require",
        },
        call: current,
      };
};

/** Node's exported child objects retain their direct builtin-module identity. */
export const semanticRequireExportsIdentity = <Key>(
  specifier: string,
  path: readonly Key[],
): { readonly specifier: string; readonly path: readonly (Key | string)[] } => {
  const name = specifier.replace(/^node:/u, "");
  if (name === "fs/promises") return { specifier: name, path };
  if (["path", "path/posix", "path/win32"].includes(name)) {
    let selected = name;
    let remaining = path;
    while (
      remaining.length > 1 &&
      (remaining[0] === "posix" || remaining[0] === "win32")
    ) {
      selected = `path/${remaining[0]}`;
      remaining = remaining.slice(1);
    }
    return { specifier: selected, path: remaining };
  }
  return name === "fs" && path[0] === "promises" && path.length > 1
    ? { specifier: "fs/promises", path: path.slice(1) }
    : { specifier: name, path };
};

const MUTABLE_BUILTIN_DEFAULTS = new Set([
  ...Object.keys(BUILTIN_RESOURCE_METHODS),
  "http",
  "https",
  "child_process",
  "timers",
  "process",
  "path",
  "path/posix",
  "path/win32",
  "url",
]);

/** Known Node namespaces have native descriptors; external exports do not. */
export const semanticBuiltinNamespace = (
  origin: JavaScriptModuleOrigin,
): boolean => {
  const path =
    origin.resolutionMode !== "require" && origin.importedPath[0] === "default"
      ? origin.importedPath.slice(1)
      : origin.importedPath;
  const shared = semanticRequireExportsIdentity(origin.specifier, path);
  return (
    shared.path.length === 0 && MUTABLE_BUILTIN_DEFAULTS.has(shared.specifier)
  );
};

/** Mutable default/object selections share CommonJS identity; namespace slots do not. */
export const semanticMutableBuiltinOrigin = <Key = never>(
  origin: JavaScriptModuleOrigin,
  selected: readonly Key[] = [],
):
  | { readonly specifier: string; readonly path: readonly (Key | string)[] }
  | undefined => {
  const path = [...origin.importedPath, ...selected];
  if (origin.resolutionMode === "require")
    return { specifier: origin.specifier, path };
  const specifier = origin.specifier.replace(/^node:/u, "");
  if (!MUTABLE_BUILTIN_DEFAULTS.has(specifier)) return undefined;
  if (path[0] === "default") return { specifier, path: path.slice(1) };
  if (specifier === "process" && (path[0] === "env" || path[0] === "argv"))
    return { specifier, path };
  return specifier === "fs" && path[0] === "promises"
    ? { specifier, path }
    : undefined;
};

semanticRequireOriginReaders.origin = semanticRequireOrigin;
semanticRequireOriginReaders.loader = semanticRequireLoaderAt;
