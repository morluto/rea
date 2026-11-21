import {
  semanticCapturedSelectionsAfterPropertyRead,
  semanticProjectedSourceFactsAtRead,
  semanticProjectedSourceEligibilityAtRead,
  semanticNormalizeCapturedSelections,
  semanticShiftCapturedSelections,
  hasFreshProjectedReceiver,
  type SemanticCapturedSelection,
} from "./javascriptSemanticProjectedSources.js";
import * as t from "@babel/types";
import { isBuiltin } from "node:module";
import {
  createGlobalPathReader,
  type GlobalReferenceRead,
} from "./javascriptSemanticAmbientWrites.js";
import { traverseJavaScriptValueAst } from "./javascriptSemanticTraversal.js";

import { BUILTIN_RESOURCE_METHODS } from "./javascriptBuiltinResourceMethods.js";
import { javaScriptRuntimeContext } from "./javascriptSourceParser.js";
import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  semanticPrototypeOwners,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticMemberEffect,
  type JavaScriptBindingIndex,
} from "./javascriptSemanticState.js";
import {
  isUnshadowedGlobal,
  commonJsWrapperBindingDeclaration,
  isUnmodifiedCommonJsWrapperBinding,
  semanticBindingAtRead,
  semanticBindingHasPriorValueWrite,
} from "./javascriptSemanticMutationInitializers.js";
import {
  isPrimitiveJavaScriptExpression,
  isPrimitiveJavaScriptCallableProperty,
  javaScriptExpressionValue,
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  semanticMemberChain,
  semanticWriteSiteTarget,
  semanticWriteTargets,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  semanticPropertyPathKeyMatches,
  SemanticPropertyPathCoverage,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { semanticCallableHasNoReturnValue } from "./javascriptSemanticCallableResults.js";
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
import {
  createSemanticModuleInterop,
  semanticModuleInteropWithAmbientWrites,
} from "./javascriptModuleInterop.js";
import { electronMemberPath } from "./javascriptElectronMemberWrites.js";
import {
  javaScriptScalarEvaluationSources,
  semanticBranchMayBeSkipped,
} from "./javascriptSemanticEvaluationOrder.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";
import { semanticSlotAtPath } from "./javascriptSemanticSlots.js";
import {
  createSemanticMemberEffectLookup,
  semanticBindingEffectGeneration,
  semanticEffectMayFollow,
  createSemanticOpaqueReferenceEffectQuery,
  ambientPathMayHaveChanged,
  ambientBindingMayObserveWriteAt,
  ambientPathMayObserveAt,
  ambientPathOrMemberMayHaveChanged,
  bindingHasUnmodeledMemberValues,
  opaqueCodeMayRebindBinding,
  semanticEffectMayPrecede,
  semanticMemberWriteSources,
} from "./javascriptSemanticEffectLog.js";
import { semanticGlobalCodeSites } from "./javascriptSemanticEffectRecord.js";
import { semanticIterationSources } from "./javascriptSemanticIterationSources.js";
import {
  semanticCommonJsRequireOwnEnumerableAt,
  semanticReferenceIterationUnknown,
  semanticReferenceSourcesInactive,
} from "./javascriptSemanticReferenceSources.js";
import {
  createSemanticOwnPropertyReadQuery,
  semanticArrayPropertyReferences,
  semanticObjectPropertyReferences,
} from "./javascriptSemanticObjectReferences.js";
import {
  SemanticAliasSelections,
  semanticAliasSelectionChoices,
  type SemanticAliasSelectionPath,
} from "./javascriptSemanticAliasSelections.js";
import {
  semanticRequireOriginReaders,
  type JavaScriptRequireLoaderFact,
  type JavaScriptRequireOrigin,
} from "./javascriptSemanticRequireOriginSlot.js";
import {
  isUnmodifiedGlobalReference,
  isUnmodifiedImportMetaUrl,
} from "./javascriptSemanticGlobalReference.js";

const possibleCommonJsDelegateWriteStates =
  new WeakSet<JavaScriptSemanticAnalysisState>();

/** Admission and indexing share the same direct, projected and iteration leaves. */
function* commonJsDelegateWriteTargets(
  node: t.Node,
): Generator<t.MemberExpression | t.OptionalMemberExpression> {
  const write = semanticWriteSiteTarget(node);
  if (write === null) return;
  for (const target of semanticWriteTargets(write)) {
    if (!t.isMemberExpression(target) && !t.isOptionalMemberExpression(target))
      continue;
    const key = semanticStaticPropertyKey(target.property, target.computed);
    if (key === "require" || (key === null && target.computed)) yield target;
  }
}

/** Source eligibility only; the shared write owner still proves receiver identity. */
export const observePossibleCommonJsDelegateWrite = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): void => {
  if (possibleCommonJsDelegateWriteStates.has(state)) return;
  if (
    semanticIterationSources(node, state.parentsByNode.get(node) ?? null).some(
      (source) => source.kind === "reference-store",
    )
  )
    possibleCommonJsDelegateWriteStates.add(state);
  if (!commonJsDelegateWriteTargets(node).next().done)
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
  writesModuleRequire(state).some((write) =>
    semanticEffectMayPrecede(state, node, write),
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
      javaScriptRuntimeContext(state.program) !== "commonjs" ||
      semanticResolutionBlocked(state, loader, "require")
    )
      return "unknown";
    return ambientBindingMayObserveWriteAt(state, node, "require")
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
    return binding.hostOrigin === "commonjs-wrapper" ||
      javaScriptRuntimeContext(state.program) === "commonjs"
      ? commonJsLoaderAt(node, state)
      : "unknown";
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
      "loader" | "sourceRelative" | "sourceRelativePath" | "loaderAuthority"
    >
  | undefined => {
  const pending: ModuleObjectSource[] = [{ node: root, path: [] }];
  const seen = new WeakMap<t.Node, Set<string>>();
  let count = 0;
  let found = false;
  let candidate = false;
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
    if (++count > state.precision.alias_selections) {
      state.valueResourceLimits.add("alias-selections");
      return { loader: "unknown", sourceRelative: false };
    }
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      pending.push(
        ...inheritLoaderSourceContext(current, [
          loaderMemberSource(current, node, state.parentsByNode),
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
          candidate ||=
            invoked === "unknown" &&
            t.isIdentifier(node, { name: "require" }) &&
            isConditionalRequireAt(node, node, state);
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
        const retained = semanticBindingAtRead(binding, node, state).binding;
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
              // The immediate invocation produces this value before the
              // receiving call can apply opaque effects to it.
              readAt: node,
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
        ...(candidate ? { loaderAuthority: "candidate" as const } : {}),
        ...(found &&
        !unknown &&
        sourceRelative &&
        sourceRelativeBase?.kind === "source-relative-file"
          ? { sourceRelativePath: sourceRelativeBase.path }
          : {}),
      }
    : undefined;
};

export interface JavaScriptRequireCallFact {
  readonly operation: "load" | "resolve";
  readonly loader: JavaScriptRequireLoaderFact;
  readonly arguments:
    | readonly t.CallExpression["arguments"][number][]
    | undefined;
  readonly sourceRelative: boolean;
  readonly loaderAuthority?: "candidate";
  readonly memberUnproven?: true;
  /** A createRequire filename relative to the current source directory, when proven. */
  readonly sourceRelativePath?: string;
}

/** A child-property write does not replace the selected callable itself. */
export const semanticSelectedMemberMayHaveChanged = (
  index: JavaScriptBindingIndex,
  site: t.Node,
  member: t.Node,
): boolean => {
  const effects = index.effectsForReferenceAt(site, member);
  const targetDepth = semanticMemberChain(member)?.members.length;
  return (
    !effects.memberEffectsIndexed ||
    effects.effects.some(
      ({ kind, timing, path }) =>
        timing !== "after" &&
        (kind === "escape" ||
          (kind === "member-write" &&
            (targetDepth === undefined ||
              path === undefined ||
              path.length <= targetDepth))),
    )
  );
};

/** Classify the selected loader and normalize invocation arguments once. */
export const semanticRequireCallAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  factoryBindingIds: ReadonlySet<string>,
  index?: JavaScriptBindingIndex,
): JavaScriptRequireCallFact | undefined => {
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
  if (index !== undefined) {
    let member = callee;
    while (
      t.isMemberExpression(member) ||
      t.isOptionalMemberExpression(member)
    ) {
      const key = semanticStaticPropertyKey(member.property, member.computed);
      if (key === "call" || key === "apply" || key === "resolve") {
        const loader = requireLoaderValueAt(
          member.object,
          node,
          state,
          factoryBindingIds,
        );
        const selected =
          loader === "local"
            ? selectedRequireSourcesAt(
                member.object,
                node,
                state,
                factoryBindingIds,
              )
            : undefined;
        if (
          loader === "local" &&
          (selected === undefined || selected.loader === "local")
        ) {
          member = unwrapJavaScriptExpression(member.object).node;
          continue;
        }
        if (semanticSelectedMemberMayHaveChanged(index, node, member))
          return {
            operation: "load",
            loader: "unknown",
            // A changed call/apply member has no trustworthy argument mapping.
            arguments:
              member === callee && key === "resolve"
                ? node.arguments
                : undefined,
            sourceRelative: false,
            memberUnproven: true,
          };
      }
      member = unwrapJavaScriptExpression(member.object).node;
    }
  }
  if (semanticModuleRequireCallAt(node, state))
    return {
      operation: "load",
      loader: "unknown",
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
    if (loader === "unknown") {
      const receiver = unwrapJavaScriptExpression(callee.object).node;
      const candidate =
        t.isIdentifier(receiver, { name: "require" }) &&
        isConditionalRequireAt(receiver, node, state);
      return {
        operation: "resolve",
        loader,
        arguments: candidate ? node.arguments : undefined,
        sourceRelative: false,
        ...(candidate ? { loaderAuthority: "candidate" as const } : {}),
      };
    }
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
        ...(selected?.loaderAuthority === "candidate"
          ? { loaderAuthority: "candidate" as const }
          : {}),
        ...(selected?.sourceRelativePath === undefined
          ? {}
          : { sourceRelativePath: selected.sourceRelativePath }),
      };
  }
  const interop = semanticModuleInteropWithAmbientWrites(state);
  if (!t.isNewExpression(node)) {
    // Invocation normalization retains the selected path identity. Keep its
    // filename alongside that path rather than selecting the outer call again.
    const sourceRelativePaths = new Map<readonly string[], string>();
    const invocation = interop.intrinsicInvocation(node, (callee) => {
      const loader = requireLoaderValueAt(
        callee,
        node,
        state,
        factoryBindingIds,
      );
      if (loader !== "local" && loader !== "create-require") {
        const root = unwrapJavaScriptExpression(callee).node;
        const candidate =
          loader === "unknown" &&
          t.isIdentifier(root, { name: "require" }) &&
          isConditionalRequireAt(root, node, state);
        return [
          "require-loader",
          loader,
          "relative",
          ...(candidate ? ["candidate"] : []),
        ];
      }
      const selected = selectedRequireSourcesAt(
        callee,
        node,
        state,
        factoryBindingIds,
      );
      if (selected !== undefined) {
        const path = [
          "require-loader",
          selected.loader,
          selected.sourceRelative ? "relative" : "unknown",
          ...(selected.loaderAuthority === "candidate" ? ["candidate"] : []),
        ];
        if (selected.sourceRelativePath !== undefined)
          sourceRelativePaths.set(path, selected.sourceRelativePath);
        return path;
      }
      return interop.intrinsicPath(callee);
    });
    if (invocation?.path[0] === "require-loader") {
      const sourceRelativePath = sourceRelativePaths.get(invocation.path);
      return {
        operation: "load",
        loader:
          invocation.path[1] === "local"
            ? "local"
            : invocation.kind === "opaque"
              ? "unknown"
              : (invocation.path[1] as JavaScriptRequireLoaderFact),
        arguments: invocation.arguments,
        ...(invocation.kind === "known" && invocation.path[3] === "candidate"
          ? { loaderAuthority: "candidate" as const }
          : {}),
        sourceRelative:
          invocation.kind === "known" && invocation.path[2] === "relative",
        ...(invocation.kind === "known" && sourceRelativePath !== undefined
          ? { sourceRelativePath }
          : {}),
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

type ModuleSourceMatch = "possible" | "no-match" | "incomplete";
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
  parents: WeakMap<t.Node, t.Node>,
): ModuleObjectSource => ({
  node: member.object,
  readAt: current.readAt ?? member,
  capturedSelections:
    current.readAt === undefined
      ? semanticShiftCapturedSelections(current.capturedSelections, 1)
      : semanticNormalizeCapturedSelections([
          {
            // A later consumer must not time a read that already fed an
            // earlier assignment. `box.load = box.load || null` reads
            // `box.load` before that write.
            at:
              current.path.length === 0 &&
              !memberFeedsEarlierAssignment(member, current.readAt, parents)
                ? current.readAt
                : member,
            depth: 1,
          },
          ...(semanticShiftCapturedSelections(current.capturedSelections, 1) ??
            []),
        ]),
  path: [
    semanticStaticPropertyKey(member.property, member.computed),
    ...current.path,
  ],
});

/** True when this member is an input of an assignment that already ran. */
const memberFeedsEarlierAssignment = (
  member: t.Node,
  readAt: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  let assignment: t.AssignmentExpression | undefined;
  let parent = parents.get(member);
  while (parent !== undefined && parent !== readAt) {
    if (t.isAssignmentExpression(parent)) {
      let cursor: t.Node | undefined = member;
      while (cursor !== undefined && cursor !== parent) {
        const next = parents.get(cursor);
        if (next === parent && parent.right === cursor) assignment = parent;
        cursor = next;
      }
    }
    // An assignment inside a function runs with that function, not before it.
    if (t.isFunction(parent)) return false;
    parent = parents.get(parent);
  }
  return assignment !== undefined;
};

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
      : semanticArrayPropertyReferences(object, [choice], state)
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
): boolean => {
  const result = hasCommonJsModuleSource(node, state, includeUnknown, "module");
  return result === "possible" || (includeUnknown && result === "incomplete");
};

/** A captured delegate uses the same receiver and assignment ownership facts. */
export const isCommonJsRequireDelegate = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  includeUnknown = false,
  readAt?: t.Node,
): boolean =>
  hasCommonJsModuleSource(node, state, includeUnknown, "delegate", readAt) ===
  "possible";

const hasCommonJsModuleSource = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  includeUnknown: boolean,
  target: "module" | "delegate",
  readAt?: t.Node,
): ModuleSourceMatch => {
  type Work = ModuleObjectSource & {
    /** Await occurs after this many requested outer property selections. */
    readonly awaitDepths: readonly number[];
  };
  const pending: Work[] = [{ node, path: [], readAt, awaitDepths: [] }];
  // Keep depths separate and join finite key alternatives at each source read.
  const selections = new SemanticAliasSelections(() => {
    state.valueResourceLimits.add("alias-selections");
  }, state.precision.alias_selections);
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
  // A strict check that exhausts the budget examines the queued sources by
  // their own selected keys, breadth first, so a growing alias cannot starve a
  // sibling. One may still be a retained module identity, possibly behind a
  // binding, call, container or getter, so a second budget bounds every state
  // created after exhaustion. Unnormalized paths can grow without a binding.
  let exhausted = false;
  let drained = 0;
  for (
    let next = pending.pop();
    next !== undefined;
    next = exhausted ? pending.shift() : pending.pop()
  ) {
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
    let path = exhausted ? next.path : selections.normalize(context, next.path);
    if (selections.limited && !exhausted) {
      if (includeUnknown) return "possible";
      exhausted = true;
      // The limiter widens every key after exhaustion. Keep the selected keys.
      path = next.path;
    }
    const pathKey = JSON.stringify(path);
    let identity = context.identities.get(pathKey);
    if (identity === undefined) {
      // Consumption contexts must not provide an unbounded second path to
      // expansion beyond the shared selector budget.
      if (exhausted) {
        if (++drained > state.precision.alias_selections) return "incomplete";
      } else if (
        (byMode.size > 1 || context.identities.size > 0) &&
        ++additionalStates > state.precision.alias_selections
      ) {
        state.valueResourceLimits.add("alias-selections");
        if (includeUnknown) return "possible";
        exhausted = true;
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
        ...inheritLoaderSourceContext(next, sources)
          // These leaves cannot contribute a module source and the walker
          // would discard them without expanding their selected paths.
          .filter((source) => {
            const value = unwrapJavaScriptExpression(source.node).node;
            return (
              !t.isNumericLiteral(value) &&
              !t.isBooleanLiteral(value) &&
              !t.isNullLiteral(value)
            );
          })
          .map((source) => ({ ...source, awaitDepths: depths })),
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
      enqueue(
        loaderMemberSource({ ...next, path }, value, state.parentsByNode),
      );
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
      if (returnedResult.unresolvedInvocation) return "possible";
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
    if (processMainModulePath) return "possible";
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
      return "possible";
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
        return "possible";
      continue;
    }
    if (binding === undefined) continue;
    const read = semanticBindingAtRead(binding, value, state);
    const retainsMainModule =
      mainModulePath &&
      commonJsWrapperBindingDeclaration(value, "require", state) !==
        undefined &&
      !read.hasDefiniteInitializer;
    // A top-level `var require` may refer to a host wrapper on an unknown
    // runtime. Preserve a possible member-loader call without resolving it.
    if (
      includeUnknown &&
      mainModulePath &&
      javaScriptRuntimeContext(state.program) === "unknown" &&
      state.scopesById.get(binding.scopeId)?.kind === "program" &&
      binding.declarationKinds.size === 1 &&
      binding.declarationKinds.has("var") &&
      !read.hasDefiniteInitializer
    )
      return "possible";
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
      return "possible";
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
    if (retainsMainModule && (eligibility || facts?.retainsOrigin))
      return "possible";
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
      if (target !== "delegate") return "possible";
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
      if (sources === undefined) return "possible";
      eligibility = true;
    }
    enqueue(
      ...projectedLoaderSources({ ...next, node: value, path }, sources).map(
        (source) => (eligibility ? { ...source, eligibility } : source),
      ),
    );
  }
  return "no-match";
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
  const interop = semanticModuleInteropWithAmbientWrites(state);
  return (
    interop.intrinsicInvocation(node, (callee) =>
      isCommonJsRequireDelegate(callee, state, false, node)
        ? ["commonjs-require-delegate"]
        : interop.intrinsicPath(callee),
    )?.path[0] === "commonjs-require-delegate"
  );
};

/**
 * An exhausted selector walk can still exclude the host on a closed graph of
 * local values. Follow every retained source and member-write RHS without
 * expanding selector paths. Opaque inputs and an unfinished graph stay unknown.
 */
const hasClosedLocalReceiverSources = (
  root: t.Node,
  write: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (
    !state.memberMutationFactsComplete ||
    // The closure follows inherited members without selecting a read time.
    semanticGlobalCodeSites(state).length > 0 ||
    semanticPrototypeOwners.some((owner) =>
      ambientPathOrMemberMayHaveChanged(state, ["global", owner]),
    )
  )
    return false;
  const pending: t.Node[] = [];
  const scheduled = new Set<t.Node>();
  const enqueue = (source: t.Node): boolean => {
    const node = unwrapJavaScriptExpression(source).node;
    if (scheduled.has(node)) return true;
    if (scheduled.size >= state.precision.alias_selections) return false;
    scheduled.add(node);
    pending.push(node);
    return true;
  };
  if (!enqueue(root)) return false;
  const bindings = new Set<string>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (t.isIdentifier(node)) {
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (
        binding === undefined ||
        semanticResolutionBlocked(state, node, node.name) ||
        commonJsWrapperBindingDeclaration(node, node.name, state) !==
          undefined ||
        binding.definitions.some(
          ({ kind }) => kind === "parameter" || kind === "catch",
        ) ||
        binding.directOrigins.length !== 0 ||
        binding.initializers.length === 0 ||
        bindingHasUnmodeledMemberValues(binding, write, state) ||
        opaqueCodeMayRebindBinding(binding, state, node)
      )
        return false;
      if (bindings.has(binding.bindingId)) continue;
      bindings.add(binding.bindingId);
      for (const sources of [
        binding.initializers,
        binding.referenceInitializers,
        semanticMemberWriteSources(binding),
      ])
        for (const source of sources) {
          if (semanticReferenceIterationUnknown(source, state)) return false;
          if (
            !semanticReferenceSourcesInactive(source, state) &&
            !enqueue(source.node)
          )
            return false;
        }
    } else if (
      t.isMemberExpression(node) ||
      t.isOptionalMemberExpression(node)
    ) {
      if (!enqueue(node.object)) return false;
    } else if (t.isObjectExpression(node)) {
      for (const property of node.properties) {
        if (
          !t.isObjectProperty(property) ||
          semanticStaticPropertyKey(property.key, property.computed) ===
            "__proto__"
        )
          return false;
        if (!enqueue(property.value)) return false;
      }
    } else if (t.isArrayExpression(node)) {
      for (const element of node.elements) {
        if (t.isSpreadElement(element)) return false;
        if (element !== null && !enqueue(element)) return false;
      }
    } else if (t.isConditionalExpression(node) || t.isLogicalExpression(node)) {
      const [left, right] = t.isConditionalExpression(node)
        ? [node.consequent, node.alternate]
        : [node.left, node.right];
      if (!enqueue(left) || !enqueue(right)) return false;
    } else if (!readExactJavaScriptLiteral(node).found) {
      return false;
    }
  }
  return true;
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
  const matchingEffects = createSemanticMemberEffectLookup();
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
          javaScriptScalarEvaluationSources(expression, scalarEvaluationBodies),
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
      opaqueCodeMayRebindBinding(binding, state, value)
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
      semanticBindingEffectGeneration(binding) > 0
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
  const ownPropertyAt = createSemanticOwnPropertyReadQuery(
    state,
    opaqueReferenceEffect,
  );
  const scalarEvaluationBodies = (
    node:
      | t.MemberExpression
      | t.OptionalMemberExpression
      | t.CallExpression
      | t.OptionalCallExpression,
  ): readonly t.Node[] | undefined => {
    // Reading a data slot does not call user code. For a proven own getter,
    // follow what the getter evaluates, independently of the value it returns.
    const bodies: t.Node[] = [];
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      const key = semanticStaticPropertyKey(node.property, node.computed);
      const root = unwrapJavaScriptExpression(node.object).node;
      if (
        key === null ||
        (!t.isObjectExpression(root) && !t.isIdentifier(root))
      )
        return undefined;
      const known = ownPropertyAt(root, key, node, (method) => {
        bodies.push(method.body);
        return true;
      });
      return known ? bodies : undefined;
    }
    // Substituting parameter/default/receiver values requires call context.
    // Keep those calls with the normal invocation owner.
    if (
      node.arguments.length > 0 ||
      semanticGlobalCodeSites(state).some((site) =>
        semanticEffectMayPrecede(state, node, site),
      )
    )
      return undefined;
    const targets = resolveLocalCallables({
      node: node.callee,
      state,
      callableById,
      bindingCache: callableCache,
      seenInitializers: new Set(),
    });
    if (!targets.complete || targets.callableIds.length === 0) return undefined;
    for (const id of targets.callableIds) {
      const fn = state.callableNodesById.get(id);
      if (
        !t.isFunction(fn) ||
        fn.generator ||
        fn.async ||
        fn.params.length !== 0
      )
        return undefined;
      bodies.push(fn.body);
    }
    return bodies;
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
          Array.from(matchingEffects(binding, "escape", path, false)).some(
            (effect) =>
              effect.node !== at &&
              effect.path.length < path.length &&
              effect.path.every((key, index) =>
                semanticPropertyPathKeyMatches(key, String(path[index])),
              ) &&
              semanticEffectMayPrecede(state, at, effect.node) &&
              !nativeReplacement(effect.node),
          )
        )
          return undefined;
        let latest: JavaScriptSemanticMemberEffect | undefined;
        if (path.length > 0)
          for (const effect of matchingEffects(
            binding,
            "member-write",
            path,
            false,
          )) {
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
            if (!semanticEffectMayPrecede(state, at, effect.node)) continue;
            if (untouched) return undefined;
            if (
              semanticEffectMayFollow(state, at, effect.node) ||
              !isDefiniteReplacement(effect.node) ||
              !definitelyWritesPath(effect, binding) ||
              effect.path.some((key) => typeof key !== "string")
            )
              return undefined;
            if (latest === undefined) latest = effect;
            else {
              if (!semanticEffectMayPrecede(state, latest.node!, effect.node))
                latest = effect;
              else if (
                semanticEffectMayFollow(state, latest.node!, effect.node)
              )
                return undefined;
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
    }[] = nodes
      .filter((node) => node != null)
      .map((node) => ({
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
        for (const effect of matchingEffects(binding, "escape", path, false)) {
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
            semanticEffectMayPrecede(state, readAt, effect.node) &&
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
        : matchingEffects(binding, "member-write", path)) {
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
          semanticEffectMayPrecede(
            state,
            effect.path.length > path.length ? call : readAt,
            effect.node,
          ) &&
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
      const intrinsicReferences = interop.intrinsicValueReferences(
        value,
        (mutation, key, read) =>
          inheritedDescriptorFieldChanged("value", mutation, read) &&
          (typeof key !== "string" ||
            writtenValues(mutation, key, read) === undefined),
      );
      if (intrinsicReferences === undefined) return true;
      for (const reference of intrinsicReferences)
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
          !ambientPathMayHaveChanged(state, ["commonjs-module", first])
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
        if (
          results.length === 0 &&
          (callable.callableIds.length === 0 ||
            (!t.isFunction(value.callee) &&
              semanticGlobalCodeSites(state).some((site) =>
                semanticEffectMayPrecede(state, value.callee, site),
              )) ||
            !callable.callableIds.every((id) =>
              semanticCallableHasNoReturnValue(state.callableNodesById.get(id)),
            ))
        )
          return true;
        // Even a call that falls through evaluates its arguments.
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
          timeDependent = true;
          pending.push(
            ...javaScriptScalarEvaluationSources(
              value,
              scalarEvaluationBodies,
            ).map((node) => ({
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
  const record = (node: t.Node, receiver: t.Node): void => {
    const resolution = hasCommonJsModuleSource(
      receiver,
      state,
      false,
      "module",
    );
    if (
      resolution === "possible" ||
      (resolution === "incomplete" &&
        !hasClosedLocalReceiverSources(receiver, node, state))
    )
      writes.push(node);
  };
  traverseJavaScriptValueAst(state.program, state.erasedSyntaxNodes, {
    enter: (node) => {
      for (const target of commonJsDelegateWriteTargets(node))
        record(node, target.object);
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
          method === "defineProperty"
        ) {
          const key = interop.staticPropertyKey(args?.[1]);
          if (
            (key === "require" || key === undefined) &&
            args?.[0] !== undefined
          )
            record(node, args[0]);
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

/** Methods, spreads and unknown computed keys can all supply an own delegate. */
const objectMayProvideRequire = (node: t.Node | undefined): boolean =>
  !t.isObjectExpression(node) ||
  node.properties.some((property) => {
    if (t.isSpreadElement(property)) return true;
    const key = semanticStaticPropertyKey(property.key, property.computed);
    return key === "require" || key === null;
  });

/** Whether the original global process object can still own effects at this source site. */
export const semanticOriginalGlobalProcessAt = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  !ambientPathMayObserveAt(state, node, ["global", "process"]) &&
  !ambientBindingMayObserveWriteAt(state, node, "process");

const globalProcessReaders = new WeakMap<
  JavaScriptSemanticAnalysisState,
  (site: t.Node) => GlobalReferenceRead
>();

/**
 * Whether a write or escape through the global process object at this source
 * site may still reach the original object: the global path reader does not
 * prove a replacement with a fresh object before it. Reads that need a
 * definite identity ask `semanticOriginalGlobalProcessAt` instead.
 */
export const semanticEffectMayReachOriginalGlobalProcess = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let read = globalProcessReaders.get(state);
  if (read === undefined) {
    read = createGlobalPathReader(state, ["process"]);
    globalProcessReaders.set(state, read);
  }
  const fact = read(node);
  return (
    fact.status !== "replacement" ||
    !hasFreshProjectedReceiver(fact.value, [], state)
  );
};

/**
 * What a global process reference is used for. A `"read"` needs the original
 * object for certain; an `"effect"` (a write or an escape through the
 * reference) is attributed to it while it may still be the original.
 */
export type SemanticGlobalProcessUse = "read" | "effect";

const globalProcessAt = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  use: SemanticGlobalProcessUse,
): boolean =>
  use === "read"
    ? semanticOriginalGlobalProcessAt(node, state)
    : semanticEffectMayReachOriginalGlobalProcess(node, state);

/** Node's unbound process reference shares the cached process exports object. */
export const semanticGlobalProcessOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  use: SemanticGlobalProcessUse = "read",
): JavaScriptModuleOrigin | undefined =>
  t.isIdentifier(node, { name: "process" }) &&
  resolveSemanticBindingState(state, node, "process") === undefined &&
  !semanticResolutionBlocked(state, node, "process") &&
  globalProcessAt(node, state, use)
    ? { specifier: "node:process", importedPath: [], resolutionMode: "require" }
    : undefined;

/** Resolve qualified global-object process references, preserving their selected path. */
export const semanticGlobalProcessPathOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  use: SemanticGlobalProcessUse = "read",
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
    !globalProcessAt(node, state, use)
  )
    return undefined;
  return {
    specifier: "node:process",
    importedPath: members.slice(1),
    resolutionMode: "require",
  };
};

/** Check one unknown-host wrapper candidate at its source-ordered read. */
const isConditionalRequireAt = (
  root: t.Identifier,
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  allowAmbientModule = false,
): boolean => {
  const runtime = javaScriptRuntimeContext(state.program);
  if (
    (runtime !== "unknown" && !(allowAmbientModule && runtime === "module")) ||
    semanticResolutionBlocked(state, root, "require") ||
    commonJsDelegateChangedAt(node, state)
  )
    return false;
  const binding = resolveSemanticBindingState(state, root, "require");
  if (
    binding !== undefined &&
    (binding.hostOrigin === "commonjs-wrapper" ||
      state.scopesById.get(binding.scopeId)?.kind !== "program" ||
      binding.declarationKinds.size !== 1 ||
      !binding.declarationKinds.has("var") ||
      (semanticBindingHasPriorValueWrite(node, binding, state) &&
        !(
          (t.isCallExpression(node) ||
            t.isOptionalCallExpression(node) ||
            t.isNewExpression(node)) &&
          isWrapperRequireInitializerCall(binding, node, state)
        )))
  )
    return false;
  return !ambientBindingMayObserveWriteAt(state, node, "require");
};

/** Recover an unshadowed literal require origin and its exact member path. */
export const semanticRequireOriginCandidate = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
  allowAmbientModule = false,
): JavaScriptRequireOrigin | undefined => {
  const chain = semanticMemberChain(node);
  const current = chain?.root;
  if (
    chain === undefined ||
    (!t.isCallExpression(current) && !t.isOptionalCallExpression(current)) ||
    !t.isIdentifier(current.callee, { name: "require" })
  )
    return undefined;
  const binding = resolveSemanticBindingState(state, current.callee, "require");
  const runtime = javaScriptRuntimeContext(state.program);
  const candidate =
    (runtime === "unknown" ||
      (allowAmbientModule && runtime === "module" && binding === undefined)) &&
    binding?.hostOrigin !== "commonjs-wrapper";
  if (
    candidate
      ? !isConditionalRequireAt(
          current.callee,
          current,
          state,
          allowAmbientModule,
        )
      : commonJsDelegateChangedAt(current, state) ||
        (binding !== undefined &&
          !isUnmodifiedCommonJsWrapperBinding(
            current.callee,
            "require",
            state,
          ) &&
          !isWrapperRequireInitializerCall(binding, current, state)) ||
        (binding === undefined &&
          (javaScriptRuntimeContext(state.program) === "module" ||
            semanticResolutionBlocked(state, current.callee, "require"))) ||
        ambientBindingMayObserveWriteAt(state, current, "require")
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
          ...(candidate ? { loaderAuthority: "candidate" as const } : {}),
        },
        call: current,
      };
};

/** Only a proven host loader may establish Node builtin identity. */
export const semanticRequireOrigin = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptRequireOrigin | undefined => {
  const result = semanticRequireOriginCandidate(node, state);
  return result?.origin.loaderAuthority === "candidate" ? undefined : result;
};

/** Node's exported child objects retain their direct builtin-module identity. */
export const semanticRequireExportsIdentity = <Key>(
  specifier: string,
  path: readonly Key[],
): { readonly specifier: string; readonly path: readonly (Key | string)[] } => {
  const name = specifier.replace(/^node:/u, "");
  if (name === "fs/promises") return { specifier: name, path };
  // The events export and its EventEmitter alias expose the same constructor.
  if (name === "events" && path[0] === "EventEmitter" && path.length > 1)
    return { specifier: name, path: path.slice(1) };
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
  "events",
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
  if (specifier === "events" && path[0] === "EventEmitter" && path.length > 1)
    return { specifier, path };
  if (specifier === "process" && (path[0] === "env" || path[0] === "argv"))
    return { specifier, path };
  return specifier === "fs" && path[0] === "promises"
    ? { specifier, path }
    : undefined;
};

semanticRequireOriginReaders.origin = semanticRequireOrigin;
semanticRequireOriginReaders.candidate = semanticRequireOriginCandidate;
semanticRequireOriginReaders.loader = semanticRequireLoaderAt;
