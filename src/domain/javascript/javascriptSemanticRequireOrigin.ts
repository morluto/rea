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
import {
  createGlobalPathReader,
  type GlobalReferenceRead,
} from "./javascriptSemanticAmbientWrites.js";
import {
  traverseJavaScriptAst,
  traverseJavaScriptValueAst,
} from "./javascriptSemanticTraversal.js";
import {
  clearSemanticModuleSourceQueries,
  semanticModuleSourceQueries,
} from "./javascriptSemanticModuleSourceCache.js";

import { BUILTIN_RESOURCE_METHODS } from "./javascriptBuiltinResourceMethods.js";
import { javaScriptRuntimeContext } from "./javascriptSourceParser.js";
import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  semanticPrototypeOwners,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptBindingIndex,
} from "./javascriptSemanticState.js";
import {
  commonJsWrapperBindingDeclaration,
  isUnmodifiedCommonJsWrapperBinding,
  semanticBindingAtRead,
  semanticBindingHasPriorValueWrite,
} from "./javascriptSemanticMutationInitializers.js";
import {
  stringValue,
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  semanticMemberChain,
  semanticWriteSiteTarget,
  semanticWriteTargets,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticPropertyPathKeyMatches } from "./javascriptSemanticPropertyPaths.js";
import { staticSourceRelativeUrlPath } from "./javascriptStaticAnalysisHelpers.js";
import {
  createSemanticModuleInterop,
  semanticModuleInteropWithAmbientWrites,
} from "./javascriptModuleInterop.js";
import {
  ambientBindingMayObserveWriteAt,
  ambientPathMayObserveAt,
  ambientPathOrMemberMayHaveChanged,
  bindingHasUnmodeledMemberValues,
  opaqueCodeMayRebindBinding,
  semanticEffectMayPrecede,
  semanticMemberWriteSources,
} from "./javascriptSemanticEffectLog.js";
import { semanticGlobalCodeSites } from "./javascriptSemanticEffectRecord.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import { semanticIterationSources } from "./javascriptSemanticIterationSources.js";
import {
  semanticCommonJsRequireOwnEnumerableAt,
  semanticReferenceIterationUnknown,
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
import {
  semanticRequireOriginReaders,
  type JavaScriptRequireLoaderFact,
  type JavaScriptRequireOrigin,
} from "./javascriptSemanticRequireOriginSlot.js";
import {
  isUnmodifiedGlobalReference,
  isUnmodifiedImportMetaUrl,
} from "./javascriptSemanticGlobalReference.js";
import { semanticConsumerMemo } from "./javascriptSemanticConsumer.js";

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
  clearSemanticModuleSourceQueries(state);
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
  // A selected loader is a bundler factory binding or comes from a loader
  // this program names. Without either, no value can select one, and a walk
  // that exhausted its budget would report an unknown loader that cannot
  // exist.
  if (
    factoryBindingIds.size === 0 &&
    !programMayNameCommonJsLoader(state.program)
  )
    return undefined;
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
      state.observations.valueResourceLimits.add("alias-selections");
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
const moduleRequireWrites = semanticConsumerMemo<readonly t.Node[]>();
const moduleReturnedReferences =
  semanticConsumerMemo<
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

/** A source position, with null and absent positions sharing one key. */
const positionKey = (position: number | null | undefined): string =>
  position === null || position === undefined ? "-" : String(position);

/**
 * Both loader queries retain the same read and shallow-copy selection owner.
 * Absent captures differ from an empty capture list. This hot key is built
 * without JSON serialization.
 */
const loaderSourceContextKey = (source: ModuleObjectSource): string => {
  let key = `${source.eligibility === true ? "e" : "-"}|${positionKey(source.readAt?.start)}|${positionKey(source.readAt?.end)}|`;
  const captures = source.capturedSelections;
  if (captures === undefined) return `${key}-`;
  key += "[";
  for (const { at, depth, ownEnumerable } of captures)
    key += `${positionKey(at.start)},${positionKey(at.end)},${String(depth)},${ownEnumerable === true ? "o" : "-"};`;
  return key;
};

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
    readAt:
      current.path.length === 0 ? undefined : (current.readAt ?? current.node),
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

const isCommonJsModuleObject = (
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

/** Names whose presence anywhere can denote or select a CommonJS loader. */
const COMMONJS_LOADER_NAMES: ReadonlySet<string> = new Set([
  "require",
  "module",
  "mainModule",
  "createRequire",
  "getBuiltinModule",
  // Global code can name a loader this program's syntax does not.
  "eval",
  "Function",
]);

/** String keys that select a loader; `"module"` is also an ordinary value. */
const COMMONJS_LOADER_KEYS: ReadonlySet<string> = new Set([
  "require",
  "mainModule",
  "createRequire",
  "getBuiltinModule",
]);

const COMMONJS_LOADER_MODULES: ReadonlySet<string> = new Set([
  "module",
  "node:module",
]);

const programLoaderCapability = new WeakMap<t.Program, boolean>();

/**
 * Whether this program names anything a CommonJS module object or loader
 * delegate can come from: `require`, `module`, a `mainModule` member, the
 * `module` builtin, `process` used as a value, or global code. Every
 * identity the loader walk recognizes is rooted in one of these, so a
 * program with none cannot contain one, and a walk that only exhausted its
 * budget there would report a loader that cannot exist. The answer depends
 * on syntax alone and is computed once per program.
 *
 * `typeof process` and a static member of `process` do not make it a value
 * that can be aliased or indexed dynamically; a `mainModule` member is named.
 */
const programMayNameCommonJsLoader = (program: t.Program): boolean => {
  const known = programLoaderCapability.get(program);
  if (known !== undefined) return known;
  let capable = false;
  traverseJavaScriptAst(program, {
    skip: () => capable,
    enter: (node, parent) => {
      if (nodeMayNameCommonJsLoader(node, parent)) capable = true;
    },
  });
  programLoaderCapability.set(program, capable);
  return capable;
};

const nodeMayNameCommonJsLoader = (
  node: t.Node,
  parent: t.Node | null,
): boolean => {
  if (t.isJSXIdentifier(node)) return COMMONJS_LOADER_NAMES.has(node.name);
  if (t.isIdentifier(node))
    return (
      COMMONJS_LOADER_NAMES.has(node.name) ||
      (node.name === "process" && !isInertProcessMention(node, parent))
    );
  if (t.isStringLiteral(node))
    return (
      COMMONJS_LOADER_KEYS.has(node.value) ||
      (COMMONJS_LOADER_MODULES.has(node.value) &&
        isModuleSpecifierPosition(node, parent))
    );
  if (t.isTemplateElement(node))
    return COMMONJS_LOADER_KEYS.has(node.value.cooked ?? node.value.raw);
  return (
    t.isTSImportEqualsDeclaration(node) || t.isTSExternalModuleReference(node)
  );
};

/**
 * `typeof process`, a static member of `process`, or `process` as a property
 * name: none lets the process object be aliased or indexed dynamically.
 */
const isInertProcessMention = (
  node: t.Identifier,
  parent: t.Node | null,
): boolean =>
  (t.isUnaryExpression(parent, { operator: "typeof" }) &&
    parent.argument === node) ||
  ((t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) &&
    !parent.computed) ||
  ((t.isObjectProperty(parent) ||
    t.isObjectMethod(parent) ||
    t.isClassMethod(parent) ||
    t.isClassProperty(parent)) &&
    parent.key === node &&
    !parent.computed);

/** A string that names the module an import, re-export or `import()` loads. */
const isModuleSpecifierPosition = (
  node: t.StringLiteral,
  parent: t.Node | null,
): boolean =>
  ((t.isImportDeclaration(parent) ||
    t.isExportNamedDeclaration(parent) ||
    t.isExportAllDeclaration(parent) ||
    t.isImportExpression(parent)) &&
    parent.source === node) ||
  ((t.isCallExpression(parent) || t.isOptionalCallExpression(parent)) &&
    t.isImport(parent.callee) &&
    parent.arguments[0] === node);

/**
 * Complete member-mutation facts fix every input of this query until the next
 * value-cache or require-delegate invalidation, so an identical query reuses
 * its answer and re-records the resource limits the first walk reached.
 */
const hasCommonJsModuleSource = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  includeUnknown: boolean,
  target: "module" | "delegate",
  readAt?: t.Node,
): ModuleSourceMatch => {
  if (!programMayNameCommonJsLoader(state.program)) return "no-match";
  if (!state.memberMutationFactsComplete)
    return walkCommonJsModuleSource(
      node,
      state,
      includeUnknown,
      target,
      readAt,
    );
  const queries = semanticModuleSourceQueries<ModuleSourceMatch>(state, node);
  let byOptions = queries.get(readAt);
  if (byOptions === undefined) {
    byOptions = new Map();
    queries.set(readAt, byOptions);
  }
  const key = `${target}:${String(includeUnknown)}`;
  const cached = byOptions.get(key);
  if (cached !== undefined) {
    for (const limit of cached.limits)
      state.observations.valueResourceLimits.add(limit);
    return cached.match;
  }
  const before = new Set(state.observations.valueResourceLimits);
  const match = walkCommonJsModuleSource(
    node,
    state,
    includeUnknown,
    target,
    readAt,
  );
  // The walk can clear this state's queries; retain the answer only if the
  // same generation still owns them.
  if (semanticModuleSourceQueries<ModuleSourceMatch>(state, node) === queries)
    byOptions.set(key, {
      match,
      limits: [...state.observations.valueResourceLimits].filter(
        (limit) => !before.has(limit),
      ),
    });
  return match;
};

const walkCommonJsModuleSource = (
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
    state.observations.valueResourceLimits.add("alias-selections");
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
  let pendingHead = 0;
  for (
    let next = pending.pop();
    next !== undefined;
    next = exhausted
      ? pendingHead < pending.length
        ? pending[pendingHead++]
        : undefined
      : pendingHead < pending.length
        ? pending.pop()
        : undefined
  ) {
    const value = unwrapJavaScriptExpression(next.node).node;
    const { awaitDepths } = next;
    const byMode =
      contexts.get(value) ??
      new Map<string, { readonly identities: Map<string, object> }>();
    const modeKey = `${awaitDepths.join(",")}#${loaderSourceContextKey(next)}`;
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
        state.observations.valueResourceLimits.add("alias-selections");
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
        const owner =
          invocation?.path?.length === 3 ? invocation.path[1] : undefined;
        const method = invocation?.path?.at(-1);
        const args = invocation?.arguments;
        if (
          (owner === "Object" || owner === "Reflect") &&
          method === "defineProperty"
        ) {
          const key = interop.staticString(args?.[1]);
          if (key === "require" || key === undefined)
            record(node, args?.[0] ?? t.nullLiteral());
        } else if (owner === "Reflect" && method === "set") {
          const key = interop.staticString(args?.[1]);
          if (key === "require" || key === undefined)
            record(node, args?.[3] ?? args?.[0] ?? t.nullLiteral());
        } else if (owner === "Object" && method === "defineProperties") {
          const descriptors = args?.[1];
          if (objectMayProvideRequire(descriptors))
            record(node, args?.[0] ?? t.nullLiteral());
        } else if (owner === "Object" && method === "assign") {
          const target = args?.[0];
          if (
            target !== undefined &&
            args?.slice(1).some(objectMayProvideRequire)
          )
            record(node, target);
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

const globalProcessReaders =
  semanticConsumerMemo<(site: t.Node) => GlobalReferenceRead>();

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
  "buffer",
  "stream",
  // `Stream` extends `EventEmitter`, so a member installed on that ancestor is inherited
  // by every fs stream. Measured on Node 24.22.1, defining `start` on
  // `EventEmitter.prototype` makes `createReadStream(p, {start:-1})` return a handle
  // while the unmutated call throws `ERR_OUT_OF_RANGE`.
  "events",
  // `fs.createReadStream` builds its `StringDecoder` from this module at first use, so a
  // replaced export changes which encodings a read stream accepts. Measured on Node
  // 24.22.1 with an admitting `Buffer.isEncoding`, replacing `StringDecoder` through the
  // default export constructs a handle from `{encoding:"nope"}`.
  "string_decoder",
]);

/** Mutable default/object selections share CommonJS identity; namespace slots do not. */
export const semanticMutableBuiltinOrigin = <Key = never>(
  origin: JavaScriptModuleOrigin,
  selected: readonly Key[] = [],
  escaped = false,
):
  | { readonly specifier: string; readonly path: readonly (Key | string)[] }
  | undefined => {
  const path = [...origin.importedPath, ...selected];
  if (origin.resolutionMode === "require")
    return { specifier: origin.specifier, path };
  const specifier = origin.specifier.replace(/^node:/u, "");
  if (!MUTABLE_BUILTIN_DEFAULTS.has(specifier)) return undefined;
  if (path[0] === "default") return { specifier, path: path.slice(1) };
  // Named imports cannot replace their namespace slots, but their exported
  // constructor objects still share identity with the CommonJS built-in.
  if (
    (selected.length > 0 || escaped) &&
    ((specifier === "fs" &&
      (path[0] === "ReadStream" ||
        path[0] === "WriteStream" ||
        path[0] === "FileReadStream" ||
        path[0] === "FileWriteStream")) ||
      (specifier === "buffer" && path[0] === "Buffer") ||
      // `Stream` is the ancestor both fs stream classes extend, so a member installed
      // through a named `Stream` import reaches them. Measured on Node 24.22.1, the
      // named-import form constructs a handle from `{start:-1}` exactly like the
      // CommonJS form.
      (specifier === "stream" &&
        (path[0] === "Readable" ||
          path[0] === "Writable" ||
          path[0] === "Stream")) ||
      (specifier === "events" && path[0] === "EventEmitter") ||
      // The default-import form is handled by the `default` arm above; this covers a
      // named `StringDecoder` import, whose binding is the same constructor object.
      (specifier === "string_decoder" && path[0] === "StringDecoder"))
  )
    return { specifier, path };
  if (specifier === "process" && (path[0] === "env" || path[0] === "argv"))
    return { specifier, path };
  // Named and namespace exports still expose the same mutable Agent object.
  if (
    (specifier === "http" || specifier === "https") &&
    path[0] === "globalAgent"
  )
    return { specifier, path };
  return specifier === "fs" && path[0] === "promises"
    ? { specifier, path }
    : undefined;
};

semanticRequireOriginReaders.origin = semanticRequireOrigin;
semanticRequireOriginReaders.candidate = semanticRequireOriginCandidate;
semanticRequireOriginReaders.loader = semanticRequireLoaderAt;
