import {
  JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS,
  resolveJavaScriptSemanticPrecision,
  type JavaScriptSemanticPrecisionInput,
} from "./javascriptSemanticPrecision.js";
import { semanticPatternPropertyReadSources } from "./javascriptSemanticIterationSources.js";
import {
  createSemanticOpaqueGlobalObserver,
  indexSemanticOpaqueEffects,
  semanticOpaqueBindingEffects,
  semanticBindingCanBeRebound,
  semanticOpaqueBindingReadMayHaveChanged,
} from "./javascriptSemanticOpaqueEffects.js";
import type { JavaScriptOpenReceiverFact } from "./javascriptSemanticReceiverFacts.js";
import * as t from "@babel/types";

import {
  semanticMethodDefinitionExpression,
  semanticBranchMayBeSkipped,
  semanticPriorStatementMayExit,
  semanticIterationCardinality,
} from "./javascriptSemanticEvaluationOrder.js";

import {
  failedJavaScriptSemanticIr,
  type JavaScriptModuleOrigin,
  type JavaScriptSemanticDefinition,
  type JavaScriptSemanticIr,
  type JavaScriptSemanticReference,
} from "./javascriptSemanticIr.js";
import {
  collectSemanticModuleLink,
  collectSemanticCallable,
  collectSemanticReferences,
  collectSemanticReferencesSteps,
  immutableSemanticBindings,
  immutableSemanticScopes,
  semanticReferenceRole,
} from "./javascriptSemanticProjection.js";
import {
  isObjectPrototypeSetter,
  readExactJavaScriptLiteral,
  semanticObjectPatternKeys,
  runtimeFunctionParameters,
  semanticStaticPropertyKey,
  semanticWriteTargets,
  semanticWriteSiteTarget,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticScopeState,
  type JavaScriptBindingIndex,
  type JavaScriptSemanticReferenceEffectsAtSite,
  currentSemanticScope,
  semanticPrototypeOwners,
  type SemanticPrototypeOwner,
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  resolveSemanticBindingFromScope,
  semanticBindingLookupFromScope,
  semanticBindingLookupAt,
  semanticBindingId,
  semanticScopeId,
  semanticStableInitializer,
  semanticVariableScope,
} from "./javascriptSemanticState.js";
import {
  completeSemanticSteps,
  isErasedJavaScriptValueChild,
  traverseJavaScriptAstSteps,
  traverseJavaScriptValueAstSteps,
} from "./javascriptSemanticTraversal.js";
import {
  semanticRequireOrigin,
  assignmentValueSources,
  semanticRequireOriginCandidate,
  observePossibleCommonJsDelegateWrite,
  invalidateSemanticRequireDelegateWrites,
} from "./javascriptSemanticRequireOrigin.js";
import {
  semanticBundledRequireOrigin,
  semanticBundledRequireOriginCandidate,
} from "./javascriptBundledRequireOrigin.js";
import { collectSemanticMemberMutationsSteps } from "./javascriptSemanticMemberMutations.js";
import {
  isUnshadowedGlobal,
  semanticBindingAtRead,
  semanticEffectTiming,
  semanticEffectTimingWithinActivation,
} from "./javascriptSemanticMutationInitializers.js";
import {
  createAmbientPathResolver,
  indexJavaScriptAmbientWritesSteps,
  isUnmodifiedGlobalReference,
} from "./javascriptSemanticAmbientWrites.js";
import {
  hasUncertainTypeOnlyModuleSideEffect,
  isTypeOnlyImportDeclaration,
  isTypeOnlyImportSpecifier,
  semanticImportEqualsSpecifier,
} from "./javascriptModuleDeclaration.js";
import {
  collectSemanticReturns,
  resolveSemanticModuleCallables,
} from "./javascriptSemanticReturns.js";
import { collectJavaScriptDerivedSemanticsSteps } from "./javascriptSemanticDerivedAnalysis.js";
import {
  evaluateSemanticExpression,
  evaluateSemanticProvenance,
  evaluateSemanticSelectedBranches,
  clearSemanticValueCaches,
  semanticValueDefinitelyDefined,
} from "./javascriptSemanticValues.js";
import { semanticKnownSymbolKey } from "./javascriptSemanticPropertyKeys.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronExportPath,
  electronMemberPath,
  ELECTRON_MODULE,
  type JavaScriptIntrinsicInvocation,
} from "./javascriptElectronMemberWrites.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticCoverage,
  RETURNED_REFERENCE_WIDENING_LIMITATION,
} from "./javascriptSemanticCoverage.js";
import { semanticResourceLimitReason } from "./javascriptSemanticResourceLimits.js";
import {
  javaScriptRuntimeContext,
  javaScriptProgramStrictness,
  parseJavaScriptSource,
  type ParsedJavaScriptSource,
} from "./javascriptSourceParser.js";

import { isJavaScriptRpcClientFactory } from "./javascriptRpcEndpoints.js";
import {
  expandJavaScriptInvocationArguments,
  javaScriptTaggedTemplateArguments,
} from "./javascriptIntrinsicInvocation.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { semanticAliasSelectionChoices } from "./javascriptSemanticAliasSelections.js";
import { semanticCopiedReferencePath } from "./javascriptSemanticCopiedReferencePaths.js";
import {
  semanticArrayPropertyReferences,
  semanticObjectAccessorReferences,
  semanticObjectOwnDataPropertyReferences,
  semanticObjectPropertyReferences,
} from "./javascriptSemanticObjectReferences.js";
import { unwrapUnmodifiedObjectFreezeArgument } from "./javascriptSemanticObjectFreeze.js";
import {
  semanticCapturedSelectionsAfterPropertyRead,
  semanticNormalizeCapturedSelections,
  semanticProjectedSourceFactsAtRead,
  semanticShiftCapturedSelections,
  type SemanticCapturedSelection,
} from "./javascriptSemanticProjectedSources.js";
import {
  SemanticPropertyPathCoverage,
  semanticArrayIndex,
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  semanticKnownArrayIterationAt,
  semanticReferenceIterationUnknown,
  semanticReferenceSourcesInactive,
  semanticSelectedReferenceSlot,
} from "./javascriptSemanticReferenceSources.js";
import {
  createSemanticReturnedReferences,
  type SemanticReturnedReferenceResult,
} from "./javascriptSemanticReturnedReferences.js";
import { indexCommonJsExportReceiversSteps } from "./javascriptCommonJsExportReceivers.js";
import { createSemanticElectronAppPathChangeQuery } from "./javascriptElectronAppPathChanges.js";
import type { JavaScriptModuleResolutionMode } from "./javascriptModuleResolutionMode.js";

interface BindPatternBudget {
  remaining: number;
  nextNodeId: number;
  readonly nodeIds: WeakMap<t.Node, number>;
  readonly saturatedStates: Set<string>;
}

interface BindPatternInput {
  readonly budget?: BindPatternBudget;
  readonly iterationSources?: JavaScriptSemanticBindingState["initializers"][number]["iterationSources"];
  readonly pattern: t.Node;
  readonly entryBody?: t.BlockStatement;
  readonly initializer: t.Node | null;
  readonly scope: JavaScriptSemanticScopeState;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly mutable: boolean;
  readonly declarationKind?: "var" | "let" | "const" | "using" | "await using";
  readonly kind?: JavaScriptSemanticDefinition["kind"];
  readonly projection?: readonly (string | number | null)[];
  readonly referenceOnly?: boolean;
  readonly assignmentReference?: true;
  readonly copyKind?: "object-rest" | "array-rest";
  readonly copyProjectionOffset?: number;
  readonly copyExcludedKeys?: readonly string[];
  readonly copyStartIndex?: number;
  readonly fallbackSources?: readonly {
    readonly node: t.Node;
    readonly projection: readonly (string | number | null)[];
    readonly iterationSources?: NonNullable<
      JavaScriptSemanticBindingState["initializers"][number]["iterationSources"]
    >;
  }[];
  readonly requiredSources?: readonly {
    readonly node: t.Node;
    readonly projection: readonly (string | number | null)[];
    readonly iterationSources?: NonNullable<
      JavaScriptSemanticBindingState["initializers"][number]["iterationSources"]
    >;
  }[];
}

interface AddBindingInput {
  readonly iterationSources?: JavaScriptSemanticBindingState["initializers"][number]["iterationSources"];
  readonly state: JavaScriptSemanticAnalysisState;
  readonly scope: JavaScriptSemanticScopeState;
  readonly name: string;
  readonly kind: JavaScriptSemanticDefinition["kind"];
  readonly mutable: boolean;
  readonly declarationKind?: "var" | "let" | "const" | "using" | "await using";
  readonly definitionNode: t.Node;
  readonly initializer: t.Node | null;
  readonly directOrigin?: JavaScriptModuleOrigin;
  readonly runtimeImport?: boolean;
  readonly projection?: readonly (string | number | null)[];
}

/** Recover lexical bindings, aliases, constants, and module links. */
export const analyzeJavaScriptSemantics = (
  source: string,
  precision?: JavaScriptSemanticPrecisionInput,
): JavaScriptSemanticIr => {
  const file = parseJavaScriptSource(source);
  return file === null
    ? failedJavaScriptSemanticIr()
    : analyzeParsedJavaScriptSemantics(file, "import", precision);
};

/** Recover lexical references, optionally for one name, without evaluating values or provenance. */
export const analyzeParsedJavaScriptReferences = (
  file: Pick<ParsedJavaScriptSource, "program">,
  name?: string,
): readonly JavaScriptSemanticReference[] => {
  const state = createState(file.program);
  completeSemanticSteps(collectDefinitionsSteps(file.program, state));
  return collectSemanticReferences(file.program, state, name);
};

const indexedAmbientWriteStates =
  new WeakSet<JavaScriptSemanticAnalysisState>();
const indexedMemberMutationStates =
  new WeakSet<JavaScriptSemanticAnalysisState>();

function* indexSemanticAmbientWritesSteps(
  state: JavaScriptSemanticAnalysisState,
): Generator<void, void> {
  if (indexedAmbientWriteStates.has(state)) return;
  yield* indexJavaScriptAmbientWritesSteps(
    state.program,
    state,
    createSemanticOpaqueGlobalObserver(state, {
      createAmbientPathResolver,
      createSemanticModuleInterop,
    }),
    (node) => observePossibleCommonJsDelegateWrite(node, state),
  );
  if (state.opaqueEffects.globalSites.length > 0)
    clearSemanticValueCaches(state);
  indexedAmbientWriteStates.add(state);
}

/** Index alias-aware mutation facts only for consumers that request them. */
function* indexSemanticMemberMutationFactsSteps(
  state: JavaScriptSemanticAnalysisState,
): Generator<void, void> {
  if (indexedMemberMutationStates.has(state)) return;
  yield* indexSemanticAmbientWritesSteps(state);
  yield* collectSemanticMemberMutationsSteps(
    state.program,
    state,
    (site, reference, path) =>
      referenceEffectsMayHaveChanged(state, site, reference, path),
  );
  state.memberMutationFactsComplete = true;
  indexedMemberMutationStates.add(state);
  invalidateSemanticRequireDelegateWrites(state);
}

/** One owner projects source-site effects for complete reports or early exit. */
const visitSemanticReferenceEffectsAtSite = (
  state: JavaScriptSemanticAnalysisState,
  site: t.Node,
  referenceNode: t.Node,
  visit: (
    effect: JavaScriptSemanticReferenceEffectsAtSite["effects"][number],
  ) => boolean,
  requestedPath?: JavaScriptSemanticPropertyPath,
  effectTiming: typeof semanticEffectTiming = semanticEffectTiming,
): Omit<JavaScriptSemanticReferenceEffectsAtSite, "effects"> => {
  const { root, path: inferredPath } = semanticReferenceRoot(referenceNode);
  const memberEffectsIndexed = indexedMemberMutationStates.has(state);
  if (!t.isIdentifier(root))
    return {
      bindingId: null,
      resolution: "unknown",
      memberEffectsIndexed,
    };
  const lookup = semanticBindingLookupAt(state, root, root.name);
  const binding = "binding" in lookup ? lookup.binding : undefined;
  const blocked = lookup.kind !== "binding" && lookup.kind !== "ambient";
  const resolution =
    lookup.kind === "binding" ? "resolved" : blocked ? "unknown" : "unbound";
  const path = requestedPath ?? inferredPath;
  const metadata: Omit<JavaScriptSemanticReferenceEffectsAtSite, "effects"> = {
    bindingId: binding?.bindingId ?? null,
    resolution,
    memberEffectsIndexed,
  };
  const retain = (
    kind: JavaScriptSemanticReferenceEffectsAtSite["effects"][number]["kind"],
    node: t.Node | undefined,
    effectPath?: JavaScriptSemanticPropertyPath,
  ): boolean => {
    if (effectPath !== undefined && !semanticPathsOverlap(path, effectPath))
      return true;
    return visit({
      kind,
      ...(effectPath === undefined ? {} : { path: effectPath }),
      timing: effectTiming(site, node, state),
    });
  };
  if (binding !== undefined) {
    if (semanticBindingCanBeRebound(binding))
      for (const node of semanticOpaqueBindingEffects(binding, state))
        if (!retain("binding-write", node)) return metadata;
    for (const node of semanticOpaqueBindingEffects(
      binding,
      state,
      "reference",
    ))
      if (!retain("escape", node, [])) return metadata;
    for (const node of state.bindingWrites.get(binding.bindingId) ?? [])
      if (!retain("binding-write", node)) return metadata;
    // The mutation producer also queries its growing facts during convergence.
    // Completion stays explicit in metadata; callers cannot infer readiness.
    for (const effect of binding.memberWrites)
      if (!retain("member-write", effect.node, effect.path)) return metadata;
    for (const effect of binding.escapedPaths)
      if (!retain("escape", effect.node, effect.path)) return metadata;
  } else if (lookup.kind === "ambient" || lookup.kind === "uncertain-ambient") {
    for (const node of state.ambientBindingWrites.get(root.name) ?? [])
      if (!retain("ambient-write", node)) return metadata;
    const ambientRoots = createAmbientPathResolver(state, false)(root).paths;
    for (const ambientRoot of ambientRoots) {
      const selectedPath = [...ambientRoot, ...path];
      for (const [kind, effects] of [
        ["member-write", state.ambientWriteEffects],
        ["escape", state.ambientEscapeEffects],
      ] as const)
        for (const effect of effects)
          if (
            semanticPathsOverlap(selectedPath, effect.path) &&
            !retain(kind, effect.node, effect.path.slice(ambientRoot.length))
          )
            return metadata;
    }
  }
  return metadata;
};

/** Query current producer facts; public consumers additionally require completion. */
const referenceEffectsMayHaveChanged = (
  state: JavaScriptSemanticAnalysisState,
  site: t.Node,
  referenceNode: t.Node,
  propertyPath?: JavaScriptSemanticPropertyPath,
): boolean => {
  let changed = false;
  const metadata = visitSemanticReferenceEffectsAtSite(
    state,
    site,
    referenceNode,
    (effect) => {
      changed = effect.timing !== "after";
      return !changed;
    },
    propertyPath,
  );
  return metadata.resolution !== "resolved" || changed;
};

/** Preserve the complete diagnostic contract for consumers needing every effect. */
const semanticReferenceEffectsAtSite = (
  state: JavaScriptSemanticAnalysisState,
  site: t.Node,
  referenceNode: t.Node,
  requestedPath?: JavaScriptSemanticPropertyPath,
  effectTiming: typeof semanticEffectTiming = semanticEffectTiming,
): JavaScriptSemanticReferenceEffectsAtSite => {
  const effects: JavaScriptSemanticReferenceEffectsAtSite["effects"][number][] =
    [];
  const metadata = visitSemanticReferenceEffectsAtSite(
    state,
    site,
    referenceNode,
    (effect) => {
      effects.push(effect);
      return true;
    },
    requestedPath,
    effectTiming,
  );
  return { ...metadata, effects };
};

const semanticReferenceRoot = (
  node: t.Node,
): { readonly root: t.Node; readonly path: JavaScriptSemanticPropertyPath } => {
  const path: (string | number | null)[] = [];
  let current = unwrapJavaScriptExpression(node).node;
  while (
    t.isMemberExpression(current) ||
    t.isOptionalMemberExpression(current)
  ) {
    const key = semanticStaticPropertyKey(current.property, current.computed);
    path.unshift(key ?? null);
    current = unwrapJavaScriptExpression(current.object).node;
  }
  return { root: current, path };
};

const semanticPathsOverlap = (
  left: JavaScriptSemanticPropertyPath,
  right: JavaScriptSemanticPropertyPath,
): boolean => {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const leftKey = left[index];
    const rightKey = right[index];
    if (leftKey === undefined || rightKey === undefined) return true;
    const leftMatchesRight =
      typeof rightKey === "string" || typeof rightKey === "number"
        ? semanticPropertyPathKeyMatches(leftKey, String(rightKey))
        : true;
    const rightMatchesLeft =
      typeof leftKey === "string" || typeof leftKey === "number"
        ? semanticPropertyPathKeyMatches(rightKey, String(leftKey))
        : true;
    if (!leftMatchesRight && !rightMatchesLeft) return false;
  }
  return true;
};

/** Share the lexical index with bounded, demand-driven boundary analyses. */
export function* indexJavaScriptBindingsSteps(
  program: t.Program,
  precision?: JavaScriptSemanticPrecisionInput,
): Generator<void, JavaScriptSemanticAnalysisState> {
  const state = createState(program, "import", precision);
  yield* collectDefinitionsSteps(program, state);
  yield* indexSemanticAmbientWritesSteps(state);
  return state;
}

/** Recover semantics from an already parsed JavaScript artifact. */
export const analyzeParsedJavaScriptSemantics = (
  file: ParsedJavaScriptSource,
  staticImportResolutionMode: JavaScriptModuleResolutionMode = "import",
  precision?: JavaScriptSemanticPrecisionInput,
): JavaScriptSemanticIr =>
  completeSemanticSteps(
    analyzeParsedJavaScriptSemanticsSteps(
      file,
      staticImportResolutionMode,
      undefined,
      precision,
    ),
  );

/**
 * Recover semantics from a parsed artifact with a yield between analysis
 * phases, so a caller can serve control messages within one large file.
 * Each phase completes before the next starts; results equal the synchronous
 * form.
 */
export function* analyzeParsedJavaScriptSemanticsSteps(
  file: ParsedJavaScriptSource,
  staticImportResolutionMode: JavaScriptModuleResolutionMode = "import",
  expressionNodeBudget?: number,
  precision?: JavaScriptSemanticPrecisionInput,
): Generator<void, JavaScriptSemanticIr> {
  const state = createState(
    file.program,
    staticImportResolutionMode,
    precision,
  );
  yield* collectDefinitionsSteps(file.program, state);
  yield* indexSemanticAmbientWritesSteps(state);
  yield* indexSemanticMemberMutationFactsSteps(state);
  const commonJsReceivers = yield* indexCommonJsExportReceiversSteps(state);
  yield* traverseJavaScriptAstSteps(file.program, {
    enter: (node) => collectSemanticModuleLink(node, state, commonJsReceivers),
  });
  yield;
  const references = yield* collectSemanticReferencesSteps(file.program, state);
  const parserPartial = file.errors.length > 0;
  const bindings = immutableSemanticBindings(state);
  yield;
  const callables = collectSemanticReturns(state, parserPartial);
  yield;
  const moduleLinks = resolveSemanticModuleCallables(
    state,
    callables,
    bindings,
  );
  const derived = yield* collectJavaScriptDerivedSemanticsSteps(
    file.program,
    state,
    callables,
    references,
    parserPartial,
    expressionNodeBudget,
  );
  const coverage = semanticCoverage(
    parserPartial,
    [
      ...new Set([...state.valueResourceLimits, ...state.getterResourceLimits]),
    ].sort(),
    [...state.returnedReferenceWidenings].map(range),
    state.precision,
  );
  return {
    schema: "JavaScriptSemanticIR",
    scopes: immutableSemanticScopes(state),
    bindings,
    callables,
    references,
    moduleLinks,
    ...derived,
    coverage: derived.expressionFlowsTruncated
      ? { ...coverage, status: "partial", omittedCount: null }
      : coverage,
    limitations: [
      ...(derived.expressionFlowsTruncated
        ? [
            "The offered semantic node capacity bounded expression dependencies; omitted influence remains unknown.",
          ]
        : []),
      ...(state.valueResourceLimits.has("alias-selections")
        ? [semanticResourceLimitReason("alias-selections", state.precision)]
        : []),
      ...(state.returnedReferenceWidenings.size > 0
        ? [RETURNED_REFERENCE_WIDENING_LIMITATION]
        : []),
      ...[...state.getterResourceLimits]
        .sort()
        .map((limit) => semanticResourceLimitReason(limit, state.precision)),
      ...(parserPartial
        ? [
            "The parser recovered from syntax errors; affected bindings are partial.",
          ]
        : []),
      ...(hasUncertainTypeOnlyModuleSideEffect(file.program)
        ? [
            "Compiler options are unavailable; inline type-only imports or re-exports may preserve a module side-effect dependency.",
          ]
        : []),
      "Values and aliases were recovered from inert syntax only; no JavaScript was executed.",
      "Return sites include only direct callable returns; nested callable returns remain separate.",
      "Local call, argument, return, and closure relations are static candidates and do not prove runtime invocation.",
      "Promise ownership covers explicit unshadowed Promise construction, static factories, aggregation, chaining, and await syntax only.",
      "Cross-function mutation and dynamic property resolution remain unknown.",
    ],
  };
}

/**
 * Receiver identity facts for the overloaded `.open` syntax, plus
 * `configuration` for `.get` reads of a `getConfiguration(...)` result.
 */
export type { JavaScriptOpenReceiverFact } from "./javascriptSemanticReceiverFacts.js";

/** Lexical receiver identities that select static endpoint interpretations. */
export interface JavaScriptReceiverFacts {
  readonly openReceivers: ReadonlyMap<number, JavaScriptOpenReceiverFact>;
  readonly rpcClientRoots: ReadonlySet<t.Node>;
}

export interface JavaScriptReceiverIndex extends JavaScriptBindingIndex {
  readonly receivers: JavaScriptReceiverFacts;
}

/**
 * Index bindings and classify receivers from one definitions pass. Receiver
 * facts read the definitions-only phase. Consumers request ambient writes and
 * lexical references only when needed; each optional index is built once.
 */
export function* indexJavaScriptBindingsWithReceiversSteps(
  program: t.Program,
  hostContext?: "commonjs-wrapper",
  precision?: JavaScriptSemanticPrecisionInput,
): Generator<void, JavaScriptReceiverIndex> {
  const state = createState(program, "import", precision);
  if (hostContext === "commonjs-wrapper") {
    const scope = currentSemanticScope(state.scopes);
    const binding: JavaScriptSemanticBindingState = {
      ...createBinding(scope, "require", "parameter", false),
      hostOrigin: "commonjs-wrapper",
    };
    scope.bindings.set(binding.name, binding);
    state.bindingsById.set(binding.bindingId, binding);
  }
  yield* collectDefinitionsSteps(program, state);
  const receivers = yield* classifyDefinitionReceiversSteps(program, state);
  let references: readonly JavaScriptSemanticReference[] | undefined;
  return {
    sourceType: program.sourceType,
    bindings: state,
    receivers,
    *indexAmbientWritesSteps() {
      yield* indexSemanticAmbientWritesSteps(state);
    },
    *indexMemberMutationFactsSteps() {
      yield* indexSemanticMemberMutationFactsSteps(state);
    },
    bindingForReferenceAt(referenceNode) {
      const { root } = semanticReferenceRoot(referenceNode);
      return t.isIdentifier(root)
        ? resolveSemanticBindingState(state, root, root.name)
        : undefined;
    },
    effectsForReferenceAt(site, referenceNode, propertyPath) {
      return semanticReferenceEffectsAtSite(
        state,
        site,
        referenceNode,
        propertyPath,
      );
    },
    effectsForReferenceWithinActivationAt(site, referenceNode, propertyPath) {
      return semanticReferenceEffectsAtSite(
        state,
        site,
        referenceNode,
        propertyPath,
        semanticEffectTimingWithinActivation,
      );
    },
    referenceMayHaveChangedAt(site, referenceNode, propertyPath) {
      if (!indexedMemberMutationStates.has(state)) return true;
      return referenceEffectsMayHaveChanged(
        state,
        site,
        referenceNode,
        propertyPath,
      );
    },
    *referencesSteps() {
      references ??= yield* collectSemanticReferencesSteps(program, state);
      return references;
    },
  };
}

function* classifyDefinitionReceiversSteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, JavaScriptReceiverFacts> {
  const facts = new Map<number, JavaScriptOpenReceiverFact>();
  const extensionStateReads: number[] = [];
  const roots = new Set<t.Node>();
  const clients = new Map<string, boolean>();
  const classifyRpcRoot = (node: t.Node): void => {
    if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node))
      return;
    const root = node.object;
    if (!t.isIdentifier(root)) return;
    const binding = resolveSemanticBindingState(state, root, root.name);
    if (binding === undefined) return;
    let client = clients.get(binding.bindingId);
    if (client === undefined) {
      const initializer = semanticStableInitializer(binding, state);
      client =
        initializer !== undefined &&
        initializer.projection.length === 0 &&
        isJavaScriptRpcClientFactory(initializer.node);
      clients.set(binding.bindingId, client);
    }
    if (client) roots.add(root);
  };
  const classifyOpenReceiver = (node: t.Node): void => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
    const callee = unwrapJavaScriptExpression(node.callee).node;
    if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
      return;
    const object = unwrapJavaScriptExpression(callee.object).node;
    const method = semanticStaticPropertyKey(callee.property, callee.computed);
    if (method === "get") {
      if (isConfigurationReceiver(state, object))
        facts.set(node.start ?? -1, "configuration");
      else if (isExtensionStateMember(object))
        extensionStateReads.push(node.start ?? -1);
      return;
    }
    if (method !== "open" || !t.isIdentifier(object)) return;
    const receiver = object.name;
    const binding = resolveSemanticBindingState(state, node, receiver);
    if (binding === undefined) {
      if (semanticResolutionBlocked(state, node, receiver)) return;
      const fact = openGlobalFact(receiver);
      if (fact !== undefined) facts.set(node.start ?? -1, fact);
      return;
    }
    // A lexically bound receiver overrides ambient browser globals. Mark an
    // otherwise unresolved local as local so name-based window.open
    // heuristics do not hide its XHR-like overloads.
    facts.set(node.start ?? -1, "local");
    if (receiver === "indexedDB" || receiver === "caches") {
      facts.set(
        node.start ?? -1,
        receiver === "indexedDB" ? "local-indexed-db" : "local-cache-storage",
      );
      return;
    }
    if (binding.mutable || binding.initializers.length !== 1) return;
    const initializerSource = binding.initializers[0]?.node;
    if (initializerSource === undefined) return;
    const initializer = unwrapJavaScriptExpression(initializerSource).node;
    if (!t.isIdentifier(initializer)) return;
    const initializerBinding = resolveSemanticBindingState(
      state,
      initializer,
      initializer.name,
    );
    if (initializerBinding !== undefined) {
      if (initializer.name === "indexedDB" || initializer.name === "caches") {
        const localFact =
          initializer.name === "indexedDB"
            ? "local-indexed-db"
            : "local-cache-storage";
        facts.set(node.start ?? -1, localFact);
        if (
          initializerBinding.mutable ||
          initializerBinding.initializers.length !== 1
        )
          return;
        const nestedSource = initializerBinding.initializers[0]?.node;
        if (nestedSource === undefined) return;
        const nested = unwrapJavaScriptExpression(nestedSource).node;
        if (t.isIdentifier(nested)) {
          const nestedFact = resolveGlobalAliasFact(
            state,
            initializer,
            nested.name,
          );
          if (nestedFact !== undefined) facts.set(node.start ?? -1, nestedFact);
        }
      } else if (initializer.name === "window") {
        facts.set(node.start ?? -1, "local");
      }
      return;
    }
    const aliasFact = resolveGlobalAliasFact(
      state,
      initializer,
      initializer.name,
    );
    if (aliasFact !== undefined) facts.set(node.start ?? -1, aliasFact);
  };
  yield* traverseJavaScriptValueAstSteps(program, state.erasedSyntaxNodes, {
    enter: (node) => {
      classifyRpcRoot(node);
      classifyOpenReceiver(node);
    },
  });
  if (extensionStateReads.length > 0 && importsVsCodeModule(state))
    for (const start of extensionStateReads)
      facts.set(start, "extension-state");
  return { openReceivers: facts, rpcClientRoots: roots };
}

/** VS Code passes extension state through ExtensionContext, not an import. */
const isExtensionStateMember = (receiver: t.Node): boolean =>
  (t.isMemberExpression(receiver) || t.isOptionalMemberExpression(receiver)) &&
  (() => {
    const key = semanticStaticPropertyKey(receiver.property, receiver.computed);
    return key === "globalState" || key === "workspaceState";
  })();

/** Require module evidence before treating a familiar member as VS Code state. */
const importsVsCodeModule = (state: JavaScriptSemanticAnalysisState): boolean =>
  [...state.bindingsById.values()].some(
    (binding) =>
      binding.directOrigins.some(({ specifier }) => specifier === "vscode") ||
      semanticRequireOrigin(
        semanticStableInitializer(binding, state)?.node,
        state,
      )?.origin.specifier === "vscode",
  );

/**
 * Whether a call spells VS Code's `workspace.getConfiguration(section)`, whose
 * result `.get` reads setting keys rather than request paths. The `workspace`
 * member is required: a bare or differently scoped `getConfiguration` may be
 * an application's own HTTP client factory. Minifiers keep property names, so
 * bundled `x.workspace.getConfiguration` still matches.
 */
const isConfigurationAccessorCall = (
  state: JavaScriptSemanticAnalysisState,
  node: t.Node,
): boolean => {
  node = unwrapJavaScriptExpression(node).node;
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
    return false;
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (
    (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) ||
    semanticStaticPropertyKey(callee.property, callee.computed) !==
      "getConfiguration"
  )
    return false;
  const host = unwrapJavaScriptExpression(callee.object).node;
  const matchesSpelling = t.isIdentifier(host)
    ? host.name === "workspace"
    : (t.isMemberExpression(host) || t.isOptionalMemberExpression(host)) &&
      semanticStaticPropertyKey(host.property, host.computed) === "workspace";
  if (!matchesSpelling) return false;
  const root = t.isIdentifier(host)
    ? host
    : t.isMemberExpression(host) || t.isOptionalMemberExpression(host)
      ? unwrapJavaScriptExpression(host.object).node
      : undefined;
  if (!t.isIdentifier(root)) return false;
  const binding = resolveSemanticBindingState(state, root, root.name);
  if (binding === undefined)
    return !semanticResolutionBlocked(state, root, root.name);
  const initializer = semanticStableInitializer(binding, state);
  const origins = [
    ...binding.directOrigins,
    ...(initializer === undefined
      ? []
      : [semanticRequireOrigin(initializer.node, state)?.origin]),
  ];
  return origins.some(
    (origin) =>
      origin?.specifier === "vscode" &&
      (t.isIdentifier(host)
        ? origin.importedPath.at(-1) === "workspace" ||
          initializer?.projection.at(-1) === "workspace"
        : origin.importedPath.length === 0 ||
          (origin.importedPath.length === 1 &&
            (origin.importedPath[0] === "*" ||
              origin.importedPath[0] === "default"))),
  );
};

/**
 * Whether a `.get` receiver is a configuration accessor result, either inline
 * or through a binding whose only visible write is one unconditional
 * initializer. Minifiers emit `let` for such bindings, so declaration kind
 * alone does not decide.
 */
const isConfigurationReceiver = (
  state: JavaScriptSemanticAnalysisState,
  receiver: t.Node,
): boolean => {
  if (isConfigurationAccessorCall(state, receiver)) return true;
  if (!t.isIdentifier(receiver)) return false;
  const binding = resolveSemanticBindingState(state, receiver, receiver.name);
  const initializer = semanticStableInitializer(binding, state);
  return (
    initializer !== undefined &&
    initializer.projection.length === 0 &&
    isConfigurationAccessorCall(state, initializer.node)
  );
};

const openGlobalFact = (
  name: string,
): JavaScriptOpenReceiverFact | undefined => {
  if (
    name === "window" ||
    name === "self" ||
    name === "globalThis" ||
    name === "top" ||
    name === "parent" ||
    name === "opener" ||
    name === "frames" ||
    name === "document"
  )
    return "window";
  if (name === "indexedDB") return "indexed-db";
  if (name === "caches") return "cache-storage";
  return undefined;
};

const resolveGlobalAliasFact = (
  state: JavaScriptSemanticAnalysisState,
  node: t.Node,
  name: string,
): JavaScriptOpenReceiverFact | undefined => {
  if (
    resolveSemanticBindingState(state, node, name) !== undefined ||
    semanticResolutionBlocked(state, node, name)
  )
    return undefined;
  return openGlobalFact(name);
};

/** Shared lexical identity and visible-write proof for direct and wrapped calls. */
export interface JavaScriptElectronIdentity {
  /** Proven export paths keyed by call/construction root offset; absence is unknown. */
  readonly bindings: ReadonlyMap<number, readonly string[]>;
  /** Conditional export paths whose require loader is not established. */
  readonly candidateBindings: ReadonlyMap<number, readonly string[]>;
  readonly intactExport: (path: readonly (string | null)[]) => boolean;
  readonly exportPath: (root: t.Node) => readonly string[] | undefined;
  readonly candidateExportPath: (root: t.Node) => readonly string[] | undefined;
  readonly invocationPath: (
    node: t.CallExpression | t.OptionalCallExpression,
  ) => readonly string[] | undefined;
  readonly mayChangeAppPath: (node: t.Node) => boolean;
  readonly candidateMayChangeAppPath: (node: t.Node) => boolean;
}

export function* indexJavaScriptElectronIdentitySteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, JavaScriptElectronIdentity> {
  const facts = new Map<number, readonly string[]>();
  const candidateFacts = new Map<number, readonly string[]>();
  let hasCandidateElectronSource = false;
  const interop = createSemanticModuleInterop(state);
  const writes = new SemanticPropertyPathCoverage();
  let collectedWrites = false;
  const exportsByBinding = new Map<string, readonly string[] | null>();
  const candidatesByBinding = new Map<string, readonly string[] | null>();
  const originAvailableAtRead = (
    binding: JavaScriptSemanticBindingState,
    read: t.Node,
  ): boolean => {
    if (
      binding.directOrigins.length > 0 ||
      semanticStableInitializer(binding, state) === undefined
    )
      return true;
    const access = semanticBindingAtRead(binding, read, state);
    // An unresolved activation can still carry a possible identity, while an
    // ordered read before its initializer cannot refer to that value.
    return access.status !== "ordered" || access.hasDefiniteInitializer;
  };
  const rootOrigin = (root: t.Node): readonly string[] | undefined => {
    if (t.isIdentifier(root)) {
      if (semanticResolutionBlocked(state, root, root.name)) return undefined;
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (binding === undefined || !originAvailableAtRead(binding, root))
        return undefined;
      let exported = exportsByBinding.get(binding.bindingId);
      if (exported === undefined) {
        exported = electronExport(binding, state, interop);
        exportsByBinding.set(binding.bindingId, exported);
      }
      return collectedWrites && interop.invalidated(binding)
        ? undefined
        : (exported ?? undefined);
    }
    const wrapped = interop.callOrigin(root);
    const origin =
      wrapped === undefined
        ? electronRequireOrigin(root, state)?.origin
        : collectedWrites && interop.invalidatedCall(root)
          ? undefined
          : wrapped.origin;
    return origin !== undefined && ELECTRON_MODULE.test(origin.specifier)
      ? electronExportPath(origin.importedPath)
      : undefined;
  };
  const rootExport = (root: t.Node): readonly string[] | undefined => {
    // Possible origins must still cover writes through uncertain aliases.
    // Admit positive reads separately, without caching their temporal validity.
    if (state.opaqueEffects.byScope.size > 0 && t.isIdentifier(root)) {
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (
        binding !== undefined &&
        (semanticOpaqueBindingReadMayHaveChanged(binding, root, state) ||
          interop.aliasMayHaveChanged(binding))
      )
        return undefined;
    }
    return rootOrigin(root);
  };
  const candidateRootExport = (root: t.Node): readonly string[] | undefined => {
    if (t.isIdentifier(root)) {
      if (semanticResolutionBlocked(state, root, root.name)) return undefined;
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (
        binding === undefined ||
        (collectedWrites && interop.invalidated(binding))
      )
        return undefined;
      if (binding.directOrigins.length === 0) {
        if (semanticStableInitializer(binding, state) === undefined)
          return undefined;
        if (!originAvailableAtRead(binding, root)) return undefined;
      }
      if (
        state.opaqueEffects.byScope.size > 0 &&
        (semanticOpaqueBindingReadMayHaveChanged(binding, root, state) ||
          interop.aliasMayHaveChanged(binding))
      )
        return undefined;
      let candidate = candidatesByBinding.get(binding.bindingId);
      if (candidate === undefined) {
        const provenance = evaluateSemanticProvenance(binding, state);
        const initializer = semanticStableInitializer(binding, state);
        const bundled =
          initializer === undefined
            ? undefined
            : semanticBundledRequireOriginCandidate(initializer.node, state)
                ?.origin;
        const origin =
          bundled?.loaderAuthority === "candidate" &&
          initializer?.projection.every(
            (key): key is string => typeof key === "string",
          )
            ? {
                ...bundled,
                importedPath: [
                  ...bundled.importedPath,
                  ...initializer.projection,
                ],
              }
            : provenance.status === "ambiguous" &&
                provenance.origins.length === 1
              ? provenance.origins[0]
              : undefined;
        candidate =
          origin?.loaderAuthority === "candidate" &&
          ELECTRON_MODULE.test(origin.specifier)
            ? electronExportPath(origin.importedPath)
            : null;
        candidatesByBinding.set(binding.bindingId, candidate);
      }
      return candidate ?? undefined;
    }
    const origin = (
      semanticRequireOriginCandidate(root, state) ??
      semanticBundledRequireOriginCandidate(root, state)
    )?.origin;
    return origin?.loaderAuthority === "candidate" &&
      ELECTRON_MODULE.test(origin.specifier)
      ? electronExportPath(origin.importedPath)
      : undefined;
  };
  const returnQueries: ElectronMemberWriteReturnQueries = {
    direct: createSemanticReturnedReferences(state, "direct-call", {
      includeResultMetadata: true,
    }),
    awaited: createSemanticReturnedReferences(state, "awaited-call", {
      includeResultMetadata: true,
    }),
    potential: createSemanticReturnedReferences(state, "potential-reference", {
      includeResultMetadata: true,
    }),
  };
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    state.erasedSyntaxNodes,
    (node, kind) => {
      if (kind === "opaque-call") return [interop.opaqueMutationPath(node)];
      const { root, members } = electronMemberPath(node);
      const exportedPaths =
        kind === "binding"
          ? []
          : electronMemberWriteExports(
              root,
              members,
              state,
              interop,
              returnQueries,
              rootOrigin,
              candidateRootExport,
              exportsByBinding,
            );
      if (exportedPaths.length > 0)
        return exportedPaths.map((exported) => ["electron", ...exported]);
      const path =
        interop.intrinsicPath(root) ??
        (kind === "member" ? interop.boundIntrinsic(root)?.path : undefined);
      return path === undefined ? [] : [[...path, ...members]];
    },
    interop.intrinsicInvocation,
    interop.staticString,
    interop.isFreshObject,
    (node, path) => {
      if (path[0] === "electron") writes.retain(path);
      else interop.retainWrite(node, path);
    },
  );
  collectedWrites = true;
  const intactExport = (path: readonly (string | null)[]): boolean =>
    ELECTRON_MODULE.test(path[0] ?? "") &&
    !writes.covers(["electron", ...path.slice(1)]);
  yield* traverseJavaScriptValueAstSteps(program, state.erasedSyntaxNodes, {
    enter: (node) => {
      if (
        !t.isCallExpression(node) &&
        !t.isOptionalCallExpression(node) &&
        !t.isNewExpression(node)
      )
        return;
      if (
        (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
        t.isIdentifier(node.callee, { name: "require" })
      ) {
        const origin = semanticRequireOriginCandidate(node, state)?.origin;
        if (
          origin?.loaderAuthority === "candidate" &&
          ELECTRON_MODULE.test(origin.specifier)
        )
          hasCandidateElectronSource = true;
      }
      const { root, members } = electronMemberPath(node.callee);
      const exported = rootExport(root);
      if (
        exported !== undefined &&
        intactExport(["electron", ...exported, ...members])
      )
        facts.set(root.start ?? -1, exported);
      else {
        const candidate = candidateRootExport(root);
        if (
          candidate !== undefined &&
          intactExport(["electron", ...candidate, ...members])
        )
          candidateFacts.set(root.start ?? -1, candidate);
      }
    },
  });
  const invocationPath = (
    node: t.CallExpression | t.OptionalCallExpression,
  ): readonly string[] | undefined => {
    const invocation = interop.intrinsicInvocation(node, (callee) => {
      const { root, members } = electronMemberPath(callee);
      const exported = rootExport(root);
      if (
        exported !== undefined &&
        members.every((member): member is string => member !== null) &&
        intactExport(["electron", ...exported, ...members])
      )
        return ["electron", ...exported, ...members];
      return interop.intrinsicPath(callee);
    });
    return invocation?.path[0] === "electron"
      ? invocation.path.slice(1)
      : undefined;
  };
  return {
    bindings: facts,
    candidateBindings: candidateFacts,
    intactExport,
    exportPath: rootExport,
    candidateExportPath: candidateRootExport,
    invocationPath,
    mayChangeAppPath: createSemanticElectronAppPathChangeQuery(
      state,
      rootOrigin,
      interop,
    ),
    candidateMayChangeAppPath: hasCandidateElectronSource
      ? createSemanticElectronAppPathChangeQuery(
          state,
          candidateRootExport,
          interop,
        )
      : () => false,
  };
}

interface ElectronMemberWriteReturnQueries {
  readonly direct: ReturnType<typeof createSemanticReturnedReferences>;
  readonly awaited: ReturnType<typeof createSemanticReturnedReferences>;
  readonly potential: ReturnType<typeof createSemanticReturnedReferences>;
}

interface InvocationParameterSource {
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
  readonly capturedSelections?: readonly SemanticCapturedSelection[];
  readonly restElementIndex?: number | null;
  readonly copyKind?: "object-rest" | "array-rest";
  readonly copyProjectionOffset?: number;
  readonly copyExcludedKeys?: readonly string[];
  readonly copyStartIndex?: number;
}

interface ElectronMemberWriteCallFrame {
  readonly id: number;
  readonly callSite: t.Node;
  readonly callReadAt: t.Node;
  readonly depth: number;
  readonly callables: ReadonlySet<t.Function>;
  readonly parameterSources: ReadonlyMap<
    string,
    readonly InvocationParameterSource[]
  >;
  readonly inactiveDefaultNodes: ReadonlySet<t.Node>;
  readonly receiverCallables: ReadonlySet<t.Function>;
  readonly receiverSources: readonly t.Expression[];
  readonly hasOpaqueArguments?: boolean;
  readonly parentFrame?: ElectronMemberWriteCallFrame | undefined;
}

interface SemanticDescriptorRead {
  readonly depth: number;
  readonly kind: "value" | "get" | "set";
}

interface ElectronMemberWriteCandidate {
  readonly node: t.Node;
  readonly suffix: JavaScriptSemanticPropertyPath;
  readonly readAt?: t.Node | undefined;
  readonly capturedSelections?:
    | readonly SemanticCapturedSelection[]
    | undefined;
  readonly descriptorReads?: readonly SemanticDescriptorRead[] | undefined;
  readonly awaitDepths?: readonly number[] | undefined;
  readonly iteratedDepths?: readonly number[] | undefined;
  readonly iteratedElementDepths?: readonly number[] | undefined;
  readonly callFrame?: ElectronMemberWriteCallFrame | undefined;
}

const descriptorReadAtDepth = (
  reads: readonly SemanticDescriptorRead[] | undefined,
  depth: number,
): SemanticDescriptorRead | undefined =>
  reads?.find((entry) => entry.depth === depth);

const withoutDescriptorReadAtDepth = (
  reads: readonly SemanticDescriptorRead[] | undefined,
  depth: number,
): readonly SemanticDescriptorRead[] | undefined => {
  if (reads === undefined) return undefined;
  const filtered = reads.filter((entry) => entry.depth !== depth);
  return filtered.length > 0 ? filtered : undefined;
};

const withDescriptorReadAtDepth = (
  reads: readonly SemanticDescriptorRead[] | undefined,
  depth: number,
  kind: "value" | "get" | "set",
): readonly SemanticDescriptorRead[] =>
  [
    ...(reads?.filter((entry) => entry.depth !== depth) ?? []),
    { depth, kind },
  ].sort((left, right) => left.depth - right.depth);

const MAX_MEMBER_WRITE_CALL_FRAME_DEPTH = 8;

const enclosingActivationFunction = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Function | undefined => {
  let cursor = state.parentsByNode.get(node);
  let child: t.Node = node;
  while (cursor !== undefined) {
    if (
      t.isFunction(cursor) &&
      !semanticMethodDefinitionExpression(cursor, child)
    )
      return cursor;
    child = cursor;
    cursor = state.parentsByNode.get(cursor);
  }
  return undefined;
};

const memberSelectionCaptureSite = (
  memberNode: t.Node,
  callFrame: ElectronMemberWriteCallFrame | undefined,
  rootActivation: t.Function | undefined,
  state: JavaScriptSemanticAnalysisState,
): t.Node | undefined => {
  const fn = enclosingActivationFunction(memberNode, state);
  if (fn === undefined) return memberNode;
  if (fn.async || fn.generator) return undefined;
  let matchingFrame: ElectronMemberWriteCallFrame | undefined;
  for (let frame = callFrame; frame !== undefined; frame = frame.parentFrame) {
    if (frame.callables.has(fn)) {
      matchingFrame = frame;
      break;
    }
  }
  if (matchingFrame === undefined)
    return fn === rootActivation ? memberNode : undefined;
  let currentFrame = matchingFrame;
  while (true) {
    const callerFn = enclosingActivationFunction(currentFrame.callSite, state);
    if (callerFn === undefined) return currentFrame.callSite;
    if (callerFn.async || callerFn.generator) return undefined;
    let outerFrame: ElectronMemberWriteCallFrame | undefined;
    for (
      let cursor = currentFrame.parentFrame;
      cursor !== undefined;
      cursor = cursor.parentFrame
    ) {
      if (cursor.callables.has(callerFn)) {
        outerFrame = cursor;
        break;
      }
    }
    if (outerFrame === undefined)
      return callerFn === rootActivation ? currentFrame.callSite : undefined;
    currentFrame = outerFrame;
  }
};

const normalizeCandidateCaptures = (
  captures: readonly SemanticCapturedSelection[] | undefined,
  context: {
    readonly callFrame: ElectronMemberWriteCallFrame | undefined;
    readonly rootActivation: t.Function | undefined;
    readonly suffixLength: number;
    readonly state: JavaScriptSemanticAnalysisState;
  },
): readonly SemanticCapturedSelection[] | undefined => {
  if (captures === undefined || captures.length === 0) return undefined;
  const resolved: SemanticCapturedSelection[] = [];
  for (const capture of captures) {
    const at = memberSelectionCaptureSite(
      capture.at,
      context.callFrame,
      context.rootActivation,
      context.state,
    );
    if (at !== undefined) resolved.push({ ...capture, at });
  }
  return semanticNormalizeCapturedSelections(resolved, context.suffixLength);
};

const maySelectArrayElementSegment = (
  segment: JavaScriptSemanticPropertyPath[number],
): boolean =>
  semanticAliasSelectionChoices(segment).some(
    (choice) =>
      choice === null ||
      typeof choice === "number" ||
      semanticArrayIndex(String(choice)) !== null,
  );

const selectMappedParameterSuffixes = (
  argSource: InvocationParameterSource,
  fullSuffix: JavaScriptSemanticPropertyPath,
): readonly JavaScriptSemanticPropertyPath[] => {
  if (argSource.restElementIndex !== undefined) {
    if (fullSuffix.length === 0) return [];
    const [firstSegment, ...remainingSuffix] = fullSuffix;
    if (
      firstSegment === undefined ||
      !maySelectArrayElementSegment(firstSegment)
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
    return [[...argSource.projection, ...remainingSuffix]];
  }
  if (argSource.copyProjectionOffset !== undefined) {
    const [key, ...remaining] = fullSuffix;
    const suffixes: JavaScriptSemanticPropertyPath[] = [];
    for (const choice of key === undefined
      ? [undefined]
      : semanticAliasSelectionChoices(key)) {
      const copied = semanticCopiedReferencePath(
        argSource,
        choice === undefined ? [] : [choice],
        "identity",
      );
      if (copied !== null) suffixes.push([...copied, ...remaining]);
    }
    return suffixes;
  }
  return [[...argSource.projection, ...fullSuffix]];
};

interface ParameterCopyMetadata {
  readonly copyKind: "object-rest" | "array-rest";
  readonly copyProjectionOffset: number;
  readonly copyExcludedKeys?: readonly string[];
  readonly copyStartIndex?: number;
}

const buildPrefixCaptures = (
  captureAt: t.Node | undefined,
  prefixLength: number,
  copy?: ParameterCopyMetadata,
): readonly SemanticCapturedSelection[] | undefined => {
  if (captureAt === undefined || prefixLength === 0) return undefined;
  const captures: SemanticCapturedSelection[] = [];
  for (let idx = 0; idx < prefixLength; idx += 1) {
    captures.push({
      at: captureAt,
      depth: idx + 1,
      ...(copy?.copyKind === "object-rest" && idx === copy.copyProjectionOffset
        ? { ownEnumerable: true }
        : {}),
    });
  }
  return captures;
};

const bindParameterPatternSources = (
  pattern: t.Node,
  argNode: t.Node,
  prefix: JavaScriptSemanticPropertyPath,
  state: JavaScriptSemanticAnalysisState,
  mapped: Map<string, InvocationParameterSource[]>,
  copy?: ParameterCopyMetadata,
  captureAt?: t.Node,
): void => {
  const target = unwrapJavaScriptExpression(pattern).node;
  if (t.isAssignmentPattern(target)) {
    bindParameterPatternSources(
      target.left,
      argNode,
      prefix,
      state,
      mapped,
      copy,
      captureAt,
    );
    return;
  }
  if (t.isIdentifier(target)) {
    const binding = resolveSemanticBindingState(state, target, target.name);
    if (binding !== undefined) {
      const list = mapped.get(binding.bindingId) ?? [];
      const capturedSelections = buildPrefixCaptures(
        captureAt,
        prefix.length,
        copy,
      );
      list.push({
        node: argNode,
        projection: prefix,
        ...(capturedSelections === undefined ? {} : { capturedSelections }),
        ...(copy === undefined ? {} : copy),
      });
      mapped.set(binding.bindingId, list);
    }
    return;
  }
  if (t.isObjectPattern(target)) {
    for (const prop of target.properties) {
      if (t.isRestElement(prop))
        bindParameterPatternSources(
          prop.argument,
          argNode,
          copy === undefined
            ? [...prefix, null]
            : [...prefix, { excludedKeys: semanticObjectPatternKeys(target) }],
          state,
          mapped,
          copy ?? {
            copyKind: "object-rest",
            copyProjectionOffset: prefix.length,
            copyExcludedKeys: semanticObjectPatternKeys(target),
          },
          captureAt,
        );
      else
        bindParameterPatternSources(
          prop.value,
          argNode,
          [...prefix, semanticStaticPropertyKey(prop.key, prop.computed)],
          state,
          mapped,
          copy,
          captureAt,
        );
    }
  } else if (t.isArrayPattern(target)) {
    target.elements.forEach((elem, idx) => {
      if (elem === null) return;
      if (t.isRestElement(elem))
        bindParameterPatternSources(
          elem.argument,
          argNode,
          copy === undefined
            ? [...prefix, null]
            : [...prefix, { excludedKeys: [], startIndex: idx }],
          state,
          mapped,
          copy ?? {
            copyKind: "array-rest",
            copyProjectionOffset: prefix.length,
            copyStartIndex: idx,
          },
          captureAt,
        );
      else
        bindParameterPatternSources(
          elem,
          argNode,
          [...prefix, idx],
          state,
          mapped,
          copy,
          captureAt,
        );
    });
  }
};

const bindRestParameterSources = (
  pattern: t.Node,
  expanded: readonly (t.Expression | t.SpreadElement | t.ArgumentPlaceholder)[],
  restStartIndex: number,
  firstSpread: number,
  state: JavaScriptSemanticAnalysisState,
  mapped: Map<string, InvocationParameterSource[]>,
  captureAt?: t.Node,
): void => {
  const target = unwrapJavaScriptExpression(pattern).node;
  if (t.isIdentifier(target)) {
    const binding = resolveSemanticBindingState(state, target, target.name);
    if (binding === undefined) return;
    const list = mapped.get(binding.bindingId) ?? [];
    const definiteEnd =
      firstSpread < 0
        ? expanded.length
        : Math.min(firstSpread, expanded.length);
    for (let argIdx = restStartIndex; argIdx < definiteEnd; argIdx += 1) {
      const arg = expanded[argIdx];
      if (arg !== undefined && t.isExpression(arg))
        list.push({
          node: arg,
          projection: [],
          restElementIndex: argIdx - restStartIndex,
        });
    }
    if (firstSpread >= 0) {
      for (const arg of expanded.slice(firstSpread)) {
        if (t.isSpreadElement(arg))
          list.push({
            node: arg.argument,
            projection: [null],
            ...(captureAt === undefined
              ? {}
              : { capturedSelections: [{ at: captureAt, depth: 1 }] }),
            restElementIndex: null,
          });
        else if (t.isExpression(arg))
          list.push({
            node: arg,
            projection: [],
            restElementIndex: null,
          });
      }
    }
    mapped.set(binding.bindingId, list);
    return;
  }
  if (t.isArrayPattern(target)) {
    target.elements.forEach((elem, elemIdx) => {
      if (elem === null) return;
      const argIndex = restStartIndex + elemIdx;
      if (t.isRestElement(elem)) {
        bindRestParameterSources(
          elem.argument,
          expanded,
          argIndex,
          firstSpread,
          state,
          mapped,
          captureAt,
        );
        return;
      }
      if (firstSpread < 0 || argIndex < firstSpread) {
        const arg = expanded[argIndex];
        if (arg !== undefined && t.isExpression(arg))
          bindParameterPatternSources(
            elem,
            arg,
            [],
            state,
            mapped,
            undefined,
            captureAt,
          );
        return;
      }
      for (const arg of expanded.slice(firstSpread)) {
        if (t.isSpreadElement(arg))
          bindParameterPatternSources(
            elem,
            arg.argument,
            [null],
            state,
            mapped,
            undefined,
            captureAt,
          );
        else if (t.isExpression(arg))
          bindParameterPatternSources(
            elem,
            arg,
            [],
            state,
            mapped,
            undefined,
            captureAt,
          );
      }
    });
    return;
  }
  if (t.isObjectPattern(target)) {
    for (const prop of target.properties) {
      if (t.isRestElement(prop)) {
        bindRestParameterSources(
          prop.argument,
          expanded,
          restStartIndex,
          firstSpread,
          state,
          mapped,
          captureAt,
        );
        continue;
      }
      const key = semanticStaticPropertyKey(prop.key, prop.computed);
      if (key === null) {
        for (const arg of expanded.slice(
          firstSpread >= 0
            ? Math.min(restStartIndex, firstSpread)
            : restStartIndex,
        )) {
          if (t.isSpreadElement(arg))
            bindParameterPatternSources(
              prop.value,
              arg.argument,
              [null],
              state,
              mapped,
              undefined,
              captureAt,
            );
          else if (t.isExpression(arg))
            bindParameterPatternSources(
              prop.value,
              arg,
              [],
              state,
              mapped,
              undefined,
              captureAt,
            );
        }
        continue;
      }
      const elemIdx = semanticArrayIndex(key);
      if (elemIdx === null) continue;
      const argIndex = restStartIndex + elemIdx;
      if (firstSpread < 0 || argIndex < firstSpread) {
        const arg = expanded[argIndex];
        if (arg !== undefined && t.isExpression(arg))
          bindParameterPatternSources(
            prop.value,
            arg,
            [],
            state,
            mapped,
            undefined,
            captureAt,
          );
      } else {
        for (const arg of expanded.slice(firstSpread)) {
          if (t.isSpreadElement(arg))
            bindParameterPatternSources(
              prop.value,
              arg.argument,
              [null],
              state,
              mapped,
              undefined,
              captureAt,
            );
          else if (t.isExpression(arg))
            bindParameterPatternSources(
              prop.value,
              arg,
              [],
              state,
              mapped,
              undefined,
              captureAt,
            );
        }
      }
    }
  }
};

interface InvocationDefaultSlotSource {
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
  readonly iterationSources?: readonly InvocationDefaultSlotSource[];
}

type InvocationDefaultSlotState =
  | "omitted"
  | "unknown"
  | { readonly kind: "source"; readonly source: InvocationDefaultSlotSource };

const registerPatternBindings = (
  pattern: t.Node,
  state: JavaScriptSemanticAnalysisState,
  mapped: Map<string, InvocationParameterSource[]>,
): void => {
  const unwrapped = t.isTSParameterProperty(pattern)
    ? pattern.parameter
    : unwrapJavaScriptExpression(pattern).node;
  if (t.isIdentifier(unwrapped)) {
    const binding = resolveSemanticBindingState(
      state,
      unwrapped,
      unwrapped.name,
    );
    if (binding !== undefined && !mapped.has(binding.bindingId))
      mapped.set(binding.bindingId, []);
    return;
  }
  if (t.isAssignmentPattern(unwrapped)) {
    registerPatternBindings(unwrapped.left, state, mapped);
    return;
  }
  if (t.isRestElement(unwrapped)) {
    registerPatternBindings(unwrapped.argument, state, mapped);
    return;
  }
  if (t.isObjectPattern(unwrapped)) {
    for (const prop of unwrapped.properties)
      if (t.isRestElement(prop))
        registerPatternBindings(prop.argument, state, mapped);
      else registerPatternBindings(prop.value, state, mapped);
    return;
  }
  if (t.isArrayPattern(unwrapped)) {
    for (const elem of unwrapped.elements)
      if (elem !== null) registerPatternBindings(elem, state, mapped);
  }
};

const collectPatternDefaultNodes = (
  params: readonly t.Node[],
): readonly t.Node[] => {
  const defaults: t.Node[] = [];
  const visit = (pattern: t.Node): void => {
    const unwrapped = t.isTSParameterProperty(pattern)
      ? pattern.parameter
      : unwrapJavaScriptExpression(pattern).node;
    if (t.isAssignmentPattern(unwrapped)) {
      defaults.push(unwrapped.right);
      visit(unwrapped.left);
      return;
    }
    if (t.isRestElement(unwrapped)) {
      visit(unwrapped.argument);
      return;
    }
    if (t.isObjectPattern(unwrapped)) {
      for (const prop of unwrapped.properties)
        visit(t.isRestElement(prop) ? prop.argument : prop.value);
      return;
    }
    if (t.isArrayPattern(unwrapped)) {
      for (const elem of unwrapped.elements) if (elem !== null) visit(elem);
    }
  };
  for (const param of params) visit(param);
  return defaults;
};

const isDefinitelyUndefinedExpression = (
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

interface InvocationSlotContext {
  readonly callSite: t.Node;
  readonly callFrame?: ElectronMemberWriteCallFrame | undefined;
  readonly state: JavaScriptSemanticAnalysisState;
}

interface ResolvedInvocationSlotCandidate {
  readonly state: "omitted" | "source";
  readonly source?: InvocationDefaultSlotSource;
  readonly captureAt: t.Node;
}

const isSameInvocationEffect = (
  site: t.Node,
  effect: t.Node | undefined,
): boolean =>
  site === effect &&
  (t.isCallExpression(site) ||
    t.isOptionalCallExpression(site) ||
    t.isNewExpression(site) ||
    t.isTaggedTemplateExpression(site));

const hasBindingObjectEffectsBeforeSite = (
  binding: JavaScriptSemanticBindingState,
  site: t.Node,
  state: JavaScriptSemanticAnalysisState,
  options?: { readonly allowPlainDataMemberWrites?: boolean },
): boolean => {
  for (const node of semanticOpaqueBindingEffects(binding, state, "reference"))
    if (
      !isSameInvocationEffect(site, node) &&
      semanticEffectTiming(site, node, state) !== "after"
    )
      return true;
  for (const effect of binding.memberWrites) {
    if (
      options?.allowPlainDataMemberWrites &&
      t.isAssignmentExpression(effect.node, { operator: "=" })
    )
      continue;
    if (
      !isSameInvocationEffect(site, effect.node) &&
      semanticEffectTiming(site, effect.node, state) !== "after"
    )
      return true;
  }
  for (const effect of binding.escapedPaths)
    if (
      !isSameInvocationEffect(site, effect.node) &&
      semanticEffectTiming(site, effect.node, state) !== "after"
    )
      return true;
  return false;
};

const peelStaticMemberChain = (
  node: t.Node,
):
  | { readonly root: t.Node; readonly members: readonly string[] }
  | undefined => {
  const members: string[] = [];
  let cursor = unwrapJavaScriptExpression(node).node;
  while (t.isMemberExpression(cursor)) {
    if (!t.isNode(cursor.object)) return undefined;
    const key = semanticStaticPropertyKey(cursor.property, cursor.computed);
    if (key === null) return undefined;
    members.push(key);
    cursor = unwrapJavaScriptExpression(cursor.object).node;
  }
  members.reverse();
  return { root: cursor, members };
};

const substituteSlotIterationSources = (
  iterationSources: readonly InvocationDefaultSlotSource[] | undefined,
  binding: JavaScriptSemanticBindingState,
  argNode: t.Node,
  argProjection: JavaScriptSemanticPropertyPath,
  state: JavaScriptSemanticAnalysisState,
): readonly InvocationDefaultSlotSource[] | undefined => {
  if (iterationSources === undefined) return undefined;
  return iterationSources.map((iter) => {
    const peeled = peelStaticMemberChain(iter.node);
    if (
      peeled !== undefined &&
      t.isIdentifier(peeled.root) &&
      !semanticResolutionBlocked(state, peeled.root, peeled.root.name) &&
      resolveSemanticBindingState(state, peeled.root, peeled.root.name) ===
        binding
    ) {
      return {
        node: argNode,
        projection: [...argProjection, ...peeled.members, ...iter.projection],
      };
    }
    return iter;
  });
};

const expandParameterSlotTarget = (
  argNode: t.Node,
  argProjection: JavaScriptSemanticPropertyPath,
  peeledMembers: readonly string[],
  source: InvocationDefaultSlotSource,
  binding: JavaScriptSemanticBindingState,
  frame: ElectronMemberWriteCallFrame,
  state: JavaScriptSemanticAnalysisState,
  options: { readonly requireUnmutatedObject?: boolean } | undefined,
  depth: number,
): readonly ResolvedInvocationSlotCandidate[] | "opaque" => {
  if (argProjection.some((seg) => seg === null || typeof seg === "object"))
    return "opaque";
  const nextIter = substituteSlotIterationSources(
    source.iterationSources,
    binding,
    argNode,
    argProjection,
    state,
  );
  return resolveSlotSourcesInCallFrame(
    {
      node: argNode,
      projection: [...argProjection, ...peeledMembers, ...source.projection],
      ...(nextIter === undefined ? {} : { iterationSources: nextIter }),
    },
    frame.callSite,
    frame.parentFrame,
    state,
    options,
    depth + 1,
  );
};

const resolveSlotSourcesInCallFrame = (
  source: InvocationDefaultSlotSource,
  callSite: t.Node,
  callFrame: ElectronMemberWriteCallFrame | undefined,
  state: JavaScriptSemanticAnalysisState,
  options?: { readonly requireUnmutatedObject?: boolean },
  depth = 0,
): readonly ResolvedInvocationSlotCandidate[] | "opaque" => {
  if (depth > MAX_MEMBER_WRITE_CALL_FRAME_DEPTH) return "opaque";
  const peeled =
    callFrame === undefined ? undefined : peelStaticMemberChain(source.node);
  if (
    peeled !== undefined &&
    t.isIdentifier(peeled.root) &&
    !semanticResolutionBlocked(state, peeled.root, peeled.root.name)
  ) {
    const binding = resolveSemanticBindingState(
      state,
      peeled.root,
      peeled.root.name,
    );
    if (
      binding !== undefined &&
      !semanticBindingAtRead(binding, peeled.root, state).hasDefiniteInitializer
    ) {
      let frame: ElectronMemberWriteCallFrame | undefined;
      for (let cur = callFrame; cur !== undefined; cur = cur.parentFrame) {
        if (cur.parameterSources.has(binding.bindingId)) {
          frame = cur;
          break;
        }
      }
      if (frame !== undefined) {
        if (
          frame.hasOpaqueArguments ||
          binding.definitions.some(({ kind }) => kind === "assignment") ||
          semanticOpaqueBindingReadMayHaveChanged(binding, peeled.root, state)
        )
          return "opaque";
        const projectsMembers =
          peeled.members.length > 0 ||
          source.projection.length > 0 ||
          (source.iterationSources?.length ?? 0) > 0;
        if (
          (options?.requireUnmutatedObject || projectsMembers) &&
          hasBindingObjectEffectsBeforeSite(binding, callSite, state)
        )
          return "opaque";
        const activeReferenceDefaults: JavaScriptSemanticBindingState["referenceInitializers"][number][] =
          [];
        for (const init of binding.referenceInitializers) {
          if (
            frame.inactiveDefaultNodes.has(init.node) ||
            semanticReferenceSourcesInactive(init, state)
          )
            continue;
          if (init.copyKind !== undefined || init.assignment) return "opaque";
          activeReferenceDefaults.push(init);
        }
        const activeDefaults = [
          ...binding.initializers.filter(
            (init) =>
              !frame.inactiveDefaultNodes.has(init.node) &&
              !semanticReferenceSourcesInactive(init, state),
          ),
          ...activeReferenceDefaults,
        ];
        const mappedArgs = frame.parameterSources.get(binding.bindingId) ?? [];
        if (mappedArgs.length === 0 && activeDefaults.length === 0)
          return projectsMembers
            ? "opaque"
            : [{ state: "omitted", captureAt: frame.callSite }];
        const results: ResolvedInvocationSlotCandidate[] = [];
        for (const init of activeDefaults) {
          const expanded = expandParameterSlotTarget(
            init.node,
            init.projection,
            peeled.members,
            source,
            binding,
            frame,
            state,
            options,
            depth,
          );
          if (expanded === "opaque") return "opaque";
          results.push(...expanded);
        }
        for (const argSource of mappedArgs) {
          if (
            argSource.restElementIndex !== undefined ||
            argSource.copyProjectionOffset !== undefined
          )
            return "opaque";
          const expanded = expandParameterSlotTarget(
            argSource.node,
            argSource.projection,
            peeled.members,
            source,
            binding,
            frame,
            state,
            options,
            depth,
          );
          if (expanded === "opaque") return "opaque";
          results.push(...expanded);
        }
        return results;
      }
    }
  }
  const captureAt =
    enclosingActivationFunction(callSite, state) === undefined
      ? callSite
      : (memberSelectionCaptureSite(callSite, callFrame, undefined, state) ??
        callSite);
  return [{ state: "source", source, captureAt }];
};

const resolveSingleExpressionInCallFrame = (
  expr: t.Expression | undefined,
  callSite: t.Node,
  callFrame: ElectronMemberWriteCallFrame | undefined,
  state: JavaScriptSemanticAnalysisState,
): { readonly node: t.Expression; readonly captureAt: t.Node } | undefined => {
  if (expr === undefined) return undefined;
  const resolved = resolveSlotSourcesInCallFrame(
    { node: expr, projection: [] },
    callSite,
    callFrame,
    state,
    { requireUnmutatedObject: true },
  );
  if (
    resolved !== "opaque" &&
    resolved.length === 1 &&
    resolved[0]?.state === "source" &&
    resolved[0].source?.projection.length === 0 &&
    t.isExpression(resolved[0].source.node)
  ) {
    return {
      node: resolved[0].source.node,
      captureAt: resolved[0].captureAt,
    };
  }
  const captureAt =
    enclosingActivationFunction(callSite, state) === undefined
      ? callSite
      : (memberSelectionCaptureSite(callSite, callFrame, undefined, state) ??
        callSite);
  return { node: expr, captureAt };
};

const isInvocationSlotDefinitelyUndefined = (
  source: InvocationDefaultSlotSource,
  slotContext: InvocationSlotContext,
): boolean => {
  const { state, callSite, callFrame } = slotContext;
  const resolved = resolveSlotSourcesInCallFrame(
    source,
    callSite,
    callFrame,
    state,
  );
  if (resolved === "opaque" || resolved.length === 0) return false;
  return resolved.every((entry) => {
    if (entry.state === "omitted") return true;
    const candidate = entry.source!;
    if (
      candidate.projection.length === 0 &&
      isDefinitelyUndefinedExpression(candidate.node, state)
    )
      return true;
    if (
      state.prototypeEnumerationMayAffect ||
      state.prototypeMutationSites.length > 0 ||
      semanticReferenceIterationUnknown(candidate, state, entry.captureAt)
    )
      return false;
    return (
      semanticSelectedReferenceSlot(candidate, state, entry.captureAt)
        ?.presence === "absent"
    );
  });
};

const isInvocationSlotDefinitelyDefined = (
  source: InvocationDefaultSlotSource,
  slotContext: InvocationSlotContext,
): boolean => {
  const { state, callSite, callFrame } = slotContext;
  const resolved = resolveSlotSourcesInCallFrame(
    source,
    callSite,
    callFrame,
    state,
  );
  if (resolved === "opaque" || resolved.length === 0) return false;
  return resolved.every((entry) => {
    if (entry.state === "omitted") return false;
    const candidate = entry.source!;
    if (semanticReferenceIterationUnknown(candidate, state, entry.captureAt))
      return false;
    const slot = semanticSelectedReferenceSlot(
      candidate,
      state,
      entry.captureAt,
    );
    return (
      slot?.presence === "present" && semanticValueDefinitelyDefined(slot.value)
    );
  });
};

const MAX_PATTERN_DEFAULT_VISITS = 256;
const SYNTHETIC_ARRAY_FROM_INDEX = t.numericLiteral(0);

interface PatternDefaultActivationTracker {
  remainingVisits: number;
  nextNodeId: number;
  readonly nodeIds: WeakMap<t.Node, number>;
  readonly visitedStates: WeakMap<t.Node, Set<string>>;
  readonly saturated: WeakSet<t.Node>;
}

const createPatternDefaultActivationTracker =
  (): PatternDefaultActivationTracker => ({
    remainingVisits: MAX_PATTERN_DEFAULT_VISITS,
    nextNodeId: 1,
    nodeIds: new WeakMap(),
    visitedStates: new WeakMap(),
    saturated: new WeakSet(),
  });

const patternDefaultNodeId = (
  node: t.Node,
  tracker: PatternDefaultActivationTracker,
): number => {
  const existing = tracker.nodeIds.get(node);
  if (existing !== undefined) return existing;
  const assigned = tracker.nextNodeId;
  tracker.nextNodeId += 1;
  tracker.nodeIds.set(node, assigned);
  return assigned;
};

const patternDefaultSlotStateKey = (
  slotState: InvocationDefaultSlotState,
  tracker: PatternDefaultActivationTracker,
): string => {
  if (slotState === "omitted" || slotState === "unknown") return slotState;
  const { source } = slotState;
  return JSON.stringify([
    patternDefaultNodeId(source.node, tracker),
    source.projection,
    source.iterationSources?.map((iter) => [
      patternDefaultNodeId(iter.node, tracker),
      iter.projection,
    ]),
  ]);
};

const saturatePatternDefaults = (
  pattern: t.Node,
  active: Set<t.Node>,
  tracker: PatternDefaultActivationTracker,
): void => {
  const target = t.isTSParameterProperty(pattern)
    ? pattern.parameter
    : unwrapJavaScriptExpression(pattern).node;
  if (tracker.saturated.has(target)) return;
  tracker.saturated.add(target);
  if (t.isAssignmentPattern(target)) {
    active.add(target.right);
    saturatePatternDefaults(target.left, active, tracker);
    return;
  }
  if (t.isRestElement(target)) {
    saturatePatternDefaults(target.argument, active, tracker);
    return;
  }
  if (t.isObjectPattern(target)) {
    for (const prop of target.properties)
      saturatePatternDefaults(
        t.isRestElement(prop) ? prop.argument : prop.value,
        active,
        tracker,
      );
    return;
  }
  if (t.isArrayPattern(target)) {
    for (const elem of target.elements)
      if (elem !== null) saturatePatternDefaults(elem, active, tracker);
  }
};

const markActivePatternDefaults = (
  pattern: t.Node,
  slotState: InvocationDefaultSlotState,
  slotContext: InvocationSlotContext,
  active: Set<t.Node>,
  tracker: PatternDefaultActivationTracker = createPatternDefaultActivationTracker(),
): void => {
  const target = t.isTSParameterProperty(pattern)
    ? pattern.parameter
    : unwrapJavaScriptExpression(pattern).node;
  if (tracker.saturated.has(target)) return;
  const stateKey = patternDefaultSlotStateKey(slotState, tracker);
  let seenForTarget = tracker.visitedStates.get(target);
  if (seenForTarget === undefined) {
    seenForTarget = new Set();
    tracker.visitedStates.set(target, seenForTarget);
  } else if (seenForTarget.has(stateKey)) {
    return;
  }
  if (tracker.remainingVisits <= 0) {
    saturatePatternDefaults(target, active, tracker);
    return;
  }
  seenForTarget.add(stateKey);
  tracker.remainingVisits -= 1;
  if (t.isAssignmentPattern(target)) {
    const defaultSlot: InvocationDefaultSlotState = {
      kind: "source",
      source: { node: target.right, projection: [] },
    };
    if (slotState === "omitted") {
      active.add(target.right);
      markActivePatternDefaults(
        target.left,
        defaultSlot,
        slotContext,
        active,
        tracker,
      );
      return;
    }
    if (slotState === "unknown") {
      active.add(target.right);
      markActivePatternDefaults(
        target.left,
        "unknown",
        slotContext,
        active,
        tracker,
      );
      markActivePatternDefaults(
        target.left,
        defaultSlot,
        slotContext,
        active,
        tracker,
      );
      return;
    }
    if (isInvocationSlotDefinitelyUndefined(slotState.source, slotContext)) {
      active.add(target.right);
      markActivePatternDefaults(
        target.left,
        defaultSlot,
        slotContext,
        active,
        tracker,
      );
      return;
    }
    if (isInvocationSlotDefinitelyDefined(slotState.source, slotContext)) {
      markActivePatternDefaults(
        target.left,
        slotState,
        slotContext,
        active,
        tracker,
      );
      return;
    }
    active.add(target.right);
    markActivePatternDefaults(
      target.left,
      slotState,
      slotContext,
      active,
      tracker,
    );
    markActivePatternDefaults(
      target.left,
      defaultSlot,
      slotContext,
      active,
      tracker,
    );
    return;
  }
  if (t.isObjectPattern(target)) {
    for (const prop of target.properties) {
      if (t.isRestElement(prop)) {
        markActivePatternDefaults(
          prop.argument,
          "unknown",
          slotContext,
          active,
          tracker,
        );
        continue;
      }
      const key = semanticStaticPropertyKey(prop.key, prop.computed);
      const childSlot: InvocationDefaultSlotState =
        key !== null && typeof slotState === "object"
          ? {
              kind: "source",
              source: {
                ...slotState.source,
                projection: [...slotState.source.projection, key],
              },
            }
          : "unknown";
      markActivePatternDefaults(
        prop.value,
        childSlot,
        slotContext,
        active,
        tracker,
      );
    }
    return;
  }
  if (t.isArrayPattern(target)) {
    const iter =
      typeof slotState === "object"
        ? [
            ...(slotState.source.iterationSources ?? []),
            {
              node: slotState.source.node,
              projection: slotState.source.projection,
            },
          ]
        : undefined;
    target.elements.forEach((elem, idx) => {
      if (elem === null) return;
      if (t.isRestElement(elem)) {
        markActivePatternDefaults(
          elem.argument,
          "unknown",
          slotContext,
          active,
          tracker,
        );
        return;
      }
      const childSlot: InvocationDefaultSlotState =
        typeof slotState === "object"
          ? {
              kind: "source",
              source: {
                node: slotState.source.node,
                projection: [...slotState.source.projection, idx],
                ...(iter === undefined ? {} : { iterationSources: iter }),
              },
            }
          : "unknown";
      markActivePatternDefaults(elem, childSlot, slotContext, active, tracker);
    });
  }
};

const markActiveRestDefaults = (
  pattern: t.Node,
  expanded: readonly (t.Expression | t.SpreadElement | t.ArgumentPlaceholder)[],
  restStartIndex: number,
  firstSpread: number,
  slotContext: InvocationSlotContext,
  active: Set<t.Node>,
  tracker: PatternDefaultActivationTracker = createPatternDefaultActivationTracker(),
): void => {
  const target = unwrapJavaScriptExpression(pattern).node;
  if (t.isArrayPattern(target)) {
    target.elements.forEach((elem, elemIdx) => {
      if (elem === null) return;
      const argIndex = restStartIndex + elemIdx;
      if (t.isRestElement(elem)) {
        markActiveRestDefaults(
          elem.argument,
          expanded,
          argIndex,
          firstSpread,
          slotContext,
          active,
          tracker,
        );
        return;
      }
      if (firstSpread < 0 || argIndex < firstSpread) {
        const arg = expanded[argIndex];
        if (arg === undefined)
          markActivePatternDefaults(
            elem,
            "omitted",
            slotContext,
            active,
            tracker,
          );
        else if (t.isExpression(arg))
          markActivePatternDefaults(
            elem,
            { kind: "source", source: { node: arg, projection: [] } },
            slotContext,
            active,
            tracker,
          );
        else
          markActivePatternDefaults(
            elem,
            "unknown",
            slotContext,
            active,
            tracker,
          );
        return;
      }
      markActivePatternDefaults(elem, "unknown", slotContext, active, tracker);
    });
    return;
  }
  if (t.isObjectPattern(target))
    markActivePatternDefaults(target, "unknown", slotContext, active, tracker);
};

const markActiveTupleRestDefaults = (
  pattern: t.Node,
  slotStates: readonly InvocationDefaultSlotState[],
  offset: number,
  slotContext: InvocationSlotContext,
  active: Set<t.Node>,
  tracker: PatternDefaultActivationTracker,
): void => {
  const target = unwrapJavaScriptExpression(pattern).node;
  if (t.isArrayPattern(target)) {
    target.elements.forEach((elem, elemIdx) => {
      if (elem === null) return;
      const argIndex = offset + elemIdx;
      if (t.isRestElement(elem)) {
        markActiveTupleRestDefaults(
          elem.argument,
          slotStates,
          argIndex,
          slotContext,
          active,
          tracker,
        );
        return;
      }
      markActivePatternDefaults(
        elem,
        slotStates[argIndex] ?? "omitted",
        slotContext,
        active,
        tracker,
      );
    });
    return;
  }
  if (t.isObjectPattern(target))
    markActivePatternDefaults(target, "unknown", slotContext, active, tracker);
};

const bindArrayFromMapperParameters = (
  iterable: t.Expression | undefined,
  inputSegments: readonly JavaScriptSemanticPropertyPath[number][],
  positionalInput: boolean,
  knownLength: number | undefined,
  callables: ReadonlySet<t.Function>,
  slotContext: InvocationSlotContext,
): {
  readonly parameterSources: Map<string, InvocationParameterSource[]>;
  readonly inactiveDefaultNodes: ReadonlySet<t.Node>;
} => {
  const { state } = slotContext;
  const mapParams = new Map<string, InvocationParameterSource[]>();
  const inactiveDefaults = new Set<t.Node>();
  const indexSlotState: InvocationDefaultSlotState = {
    kind: "source",
    source: { node: SYNTHETIC_ARRAY_FROM_INDEX, projection: [] },
  };
  for (const callable of callables) {
    const params = runtimeFunctionParameters(callable);
    for (const param of params)
      registerPatternBindings(param, state, mapParams);
    const allDefaults = collectPatternDefaultNodes(params);
    if (allDefaults.length > 0) {
      const activeDefaults = new Set<t.Node>();
      const tracker = createPatternDefaultActivationTracker();
      const firstArgStates: InvocationDefaultSlotState[] = [];
      if (iterable === undefined || !positionalInput) {
        firstArgStates.push("unknown");
      } else {
        for (const seg of inputSegments) {
          if (typeof seg === "number") {
            firstArgStates.push({
              kind: "source",
              source: { node: iterable, projection: [seg] },
            });
          } else if (
            seg !== null &&
            typeof seg === "object" &&
            knownLength !== undefined &&
            knownLength <= 32
          ) {
            for (let idx = seg.startIndex ?? 0; idx < knownLength; idx += 1) {
              if (!seg.excludedKeys.includes(String(idx)))
                firstArgStates.push({
                  kind: "source",
                  source: { node: iterable, projection: [idx] },
                });
            }
          } else {
            firstArgStates.push("unknown");
          }
        }
      }
      if (firstArgStates.length > 0) {
        params.forEach((param, paramIndex) => {
          if (t.isRestElement(param)) {
            if (paramIndex === 0) {
              for (const elemState of firstArgStates)
                markActiveTupleRestDefaults(
                  param.argument,
                  [elemState, indexSlotState],
                  0,
                  slotContext,
                  activeDefaults,
                  tracker,
                );
            } else if (paramIndex === 1) {
              markActiveTupleRestDefaults(
                param.argument,
                [indexSlotState],
                0,
                slotContext,
                activeDefaults,
                tracker,
              );
            } else {
              markActiveTupleRestDefaults(
                param.argument,
                [],
                0,
                slotContext,
                activeDefaults,
                tracker,
              );
            }
            return;
          }
          if (paramIndex === 0) {
            for (const elemState of firstArgStates)
              markActivePatternDefaults(
                param,
                elemState,
                slotContext,
                activeDefaults,
                tracker,
              );
            return;
          }
          if (paramIndex === 1) {
            markActivePatternDefaults(
              param,
              indexSlotState,
              slotContext,
              activeDefaults,
              tracker,
            );
            return;
          }
          markActivePatternDefaults(
            param,
            "omitted",
            slotContext,
            activeDefaults,
            tracker,
          );
        });
      }
      for (const defaultNode of allDefaults)
        if (!activeDefaults.has(defaultNode)) inactiveDefaults.add(defaultNode);
    }
    if (iterable === undefined) continue;
    const [firstParam] = params;
    if (firstParam === undefined) continue;
    if (!t.isRestElement(firstParam)) {
      for (const seg of inputSegments)
        bindParameterPatternSources(
          firstParam,
          iterable,
          [seg],
          state,
          mapParams,
          undefined,
          slotContext.callSite,
        );
      continue;
    }
    const restTarget = unwrapJavaScriptExpression(firstParam.argument).node;
    if (t.isIdentifier(restTarget)) {
      const restBinding = resolveSemanticBindingState(
        state,
        restTarget,
        restTarget.name,
      );
      if (restBinding !== undefined) {
        const list = mapParams.get(restBinding.bindingId) ?? [];
        for (const seg of inputSegments)
          list.push({
            node: iterable,
            projection: [seg],
            capturedSelections: [{ at: slotContext.callSite, depth: 1 }],
            restElementIndex: 0,
          });
        mapParams.set(restBinding.bindingId, list);
      }
    } else if (t.isArrayPattern(restTarget)) {
      const firstElem = restTarget.elements[0];
      if (firstElem !== null && firstElem !== undefined) {
        if (t.isRestElement(firstElem)) {
          const inner = unwrapJavaScriptExpression(firstElem.argument).node;
          if (t.isIdentifier(inner)) {
            const innerBinding = resolveSemanticBindingState(
              state,
              inner,
              inner.name,
            );
            if (innerBinding !== undefined) {
              const list = mapParams.get(innerBinding.bindingId) ?? [];
              for (const seg of inputSegments)
                list.push({
                  node: iterable,
                  projection: [seg],
                  capturedSelections: [{ at: slotContext.callSite, depth: 1 }],
                  restElementIndex: 0,
                });
              mapParams.set(innerBinding.bindingId, list);
            }
          }
        } else {
          for (const seg of inputSegments)
            bindParameterPatternSources(
              firstElem,
              iterable,
              [seg],
              state,
              mapParams,
              undefined,
              slotContext.callSite,
            );
        }
      }
    } else if (t.isObjectPattern(restTarget)) {
      for (const prop of restTarget.properties) {
        if (t.isRestElement(prop)) continue;
        const key = semanticStaticPropertyKey(prop.key, prop.computed);
        if (key === null || semanticArrayIndex(key) === 0)
          for (const seg of inputSegments)
            bindParameterPatternSources(
              prop.value,
              iterable,
              [seg],
              state,
              mapParams,
              undefined,
              slotContext.callSite,
            );
      }
    }
  }
  return {
    parameterSources: mapParams,
    inactiveDefaultNodes: inactiveDefaults,
  };
};

const nonArrowReceiverCallables = (
  callables: ReadonlySet<t.Function>,
): ReadonlySet<t.Function> => {
  const receivers = new Set<t.Function>();
  for (const callable of callables)
    if (!t.isArrowFunctionExpression(callable)) receivers.add(callable);
  return receivers;
};

const enclosingNonArrowFunction = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Function | undefined => {
  let cursor = state.parentsByNode.get(node);
  while (cursor !== undefined) {
    if (t.isFunction(cursor) && !t.isArrowFunctionExpression(cursor))
      return cursor;
    cursor = state.parentsByNode.get(cursor);
  }
  return undefined;
};

const mapInvocationParameterSources = (
  returned: SemanticReturnedReferenceResult,
  fallbackArguments:
    | readonly t.CallExpression["arguments"][number][]
    | undefined,
  slotContext: InvocationSlotContext,
): {
  readonly parameterSources: ReadonlyMap<
    string,
    readonly InvocationParameterSource[]
  >;
  readonly inactiveDefaultNodes: ReadonlySet<t.Node>;
  readonly receiverSources: readonly t.Expression[];
  readonly hasOpaqueArguments: boolean;
} => {
  const { callSite, state } = slotContext;
  const mapped = new Map<string, InvocationParameterSource[]>();
  const inactiveDefaults = new Set<t.Node>();
  const receiverSources: t.Expression[] = [];
  let hasOpaqueArguments = false;
  if (returned.callables.size === 0)
    return {
      parameterSources: mapped,
      inactiveDefaultNodes: inactiveDefaults,
      receiverSources,
      hasOpaqueArguments,
    };
  const fallbackExpanded =
    fallbackArguments === undefined
      ? undefined
      : expandJavaScriptInvocationArguments(fallbackArguments, (array) =>
          semanticKnownArrayIterationAt(array, state),
        );
  for (const callable of returned.callables) {
    const callableWidened = returned.widenedCallables?.has(callable) === true;
    if (callableWidened) hasOpaqueArguments = true;
    const contexts =
      returned.callableInvocations?.get(callable) ??
      (fallbackExpanded === undefined
        ? []
        : [{ receiver: undefined, arguments: fallbackExpanded }]);
    const params = runtimeFunctionParameters(callable);
    for (const param of params) registerPatternBindings(param, state, mapped);
    const allDefaults = collectPatternDefaultNodes(params);
    const activeDefaults = new Set<t.Node>();
    const defaultTracker = createPatternDefaultActivationTracker();
    let callableArgsComplete = !callableWidened && contexts.length > 0;
    for (const context of contexts) {
      if (context.receiver !== undefined && t.isExpression(context.receiver))
        receiverSources.push(context.receiver);
      if (context.receiverUnknown) hasOpaqueArguments = true;
      const expanded = context.arguments;
      if (expanded === undefined) {
        hasOpaqueArguments = true;
        callableArgsComplete = false;
        continue;
      }
      const firstSpread = expanded.findIndex((arg) => t.isSpreadElement(arg));
      params.forEach((param, index) => {
        if (t.isRestElement(param)) {
          if (expanded.length > 0)
            bindRestParameterSources(
              param.argument,
              expanded,
              index,
              firstSpread,
              state,
              mapped,
              callSite,
            );
          if (allDefaults.length > 0 && callableArgsComplete)
            markActiveRestDefaults(
              param.argument,
              expanded,
              index,
              firstSpread,
              slotContext,
              activeDefaults,
              defaultTracker,
            );
          return;
        }
        if (firstSpread < 0 || index < firstSpread) {
          const arg = expanded[index];
          if (arg !== undefined && t.isExpression(arg))
            bindParameterPatternSources(
              param,
              arg,
              [],
              state,
              mapped,
              undefined,
              callSite,
            );
          if (allDefaults.length > 0 && callableArgsComplete) {
            if (arg === undefined)
              markActivePatternDefaults(
                param,
                "omitted",
                slotContext,
                activeDefaults,
                defaultTracker,
              );
            else if (t.isExpression(arg))
              markActivePatternDefaults(
                param,
                { kind: "source", source: { node: arg, projection: [] } },
                slotContext,
                activeDefaults,
                defaultTracker,
              );
            else
              markActivePatternDefaults(
                param,
                "unknown",
                slotContext,
                activeDefaults,
                defaultTracker,
              );
          }
          return;
        }
        for (const arg of expanded.slice(firstSpread)) {
          if (t.isSpreadElement(arg))
            bindParameterPatternSources(
              param,
              arg.argument,
              [null],
              state,
              mapped,
              undefined,
              callSite,
            );
          else if (t.isExpression(arg))
            bindParameterPatternSources(
              param,
              arg,
              [],
              state,
              mapped,
              undefined,
              callSite,
            );
        }
        if (allDefaults.length > 0 && callableArgsComplete)
          markActivePatternDefaults(
            param,
            "unknown",
            slotContext,
            activeDefaults,
            defaultTracker,
          );
      });
    }
    if (callableArgsComplete) {
      for (const defaultNode of allDefaults)
        if (!activeDefaults.has(defaultNode)) inactiveDefaults.add(defaultNode);
    }
  }
  return {
    parameterSources: mapped,
    inactiveDefaultNodes: inactiveDefaults,
    receiverSources,
    hasOpaqueArguments,
  };
};

const enqueueOpaqueInvocationArguments = (
  args: readonly (t.Expression | t.SpreadElement | t.ArgumentPlaceholder)[],
  current: ElectronMemberWriteCandidate,
  pending: ElectronMemberWriteCandidate[],
): void => {
  for (const arg of args) {
    const target = t.isSpreadElement(arg)
      ? arg.argument
      : t.isExpression(arg)
        ? arg
        : undefined;
    if (target === undefined) continue;
    pending.push(
      {
        node: target,
        suffix: current.suffix,
        readAt: current.readAt,
        awaitDepths: current.awaitDepths,
        iteratedDepths: current.iteratedDepths,
        iteratedElementDepths: current.iteratedElementDepths,
        callFrame: current.callFrame,
      },
      {
        node: target,
        suffix: [null, ...current.suffix],
        readAt: current.readAt,
        callFrame: current.callFrame,
      },
      {
        node: target,
        suffix: [],
        readAt: current.readAt,
        callFrame: current.callFrame,
      },
    );
  }
};

interface NextCallFrameSpec {
  readonly allocateId: () => number;
  readonly callSite: t.Node;
  readonly callReadAt: t.Node;
  readonly parentFrame: ElectronMemberWriteCallFrame | undefined;
  readonly callables: ReadonlySet<t.Function>;
  readonly parameterSources: ReadonlyMap<
    string,
    readonly InvocationParameterSource[]
  >;
  readonly inactiveDefaultNodes: ReadonlySet<t.Node>;
  readonly receiverCallables: ReadonlySet<t.Function>;
  readonly receiverSources: readonly t.Expression[];
  readonly hasOpaqueArguments?: boolean;
}

const createNextCallFrame = (
  spec: NextCallFrameSpec,
): {
  readonly frame: ElectronMemberWriteCallFrame | undefined;
  readonly overflowed: boolean;
} => {
  const {
    allocateId,
    callSite,
    callReadAt,
    parentFrame,
    callables,
    parameterSources,
    inactiveDefaultNodes,
    receiverCallables,
    receiverSources,
    hasOpaqueArguments,
  } = spec;
  if (
    callables.size === 0 &&
    parameterSources.size === 0 &&
    inactiveDefaultNodes.size === 0 &&
    (receiverCallables.size === 0 || receiverSources.length === 0)
  )
    return { frame: parentFrame, overflowed: false };
  const depth = (parentFrame?.depth ?? 0) + 1;
  if (depth > MAX_MEMBER_WRITE_CALL_FRAME_DEPTH)
    return { frame: parentFrame, overflowed: true };
  for (
    let cursor = parentFrame;
    cursor !== undefined;
    cursor = cursor.parentFrame
  )
    if (cursor.callSite === callSite)
      return { frame: parentFrame, overflowed: true };
  return {
    frame: {
      id: allocateId(),
      callSite,
      callReadAt,
      depth,
      callables,
      parameterSources,
      inactiveDefaultNodes,
      receiverCallables,
      receiverSources,
      ...(hasOpaqueArguments ? { hasOpaqueArguments: true } : {}),
      parentFrame,
    },
    overflowed: false,
  };
};

interface KnownIntrinsicMemberWriteContext {
  readonly callNode: t.CallExpression | t.OptionalCallExpression;
  readonly intrinsic: JavaScriptIntrinsicInvocation;
  readonly current: ElectronMemberWriteCandidate;
  readonly capturedSelections: readonly SemanticCapturedSelection[] | undefined;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly interop: ReturnType<typeof createSemanticModuleInterop>;
  readonly returnQueries: ElectronMemberWriteReturnQueries;
  readonly pending: ElectronMemberWriteCandidate[];
}

const hasStandardArrayConstructorReceiver = (
  intrinsic: JavaScriptIntrinsicInvocation,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (intrinsic.receiver === undefined) return true;
  const receiver = unwrapJavaScriptExpression(intrinsic.receiver).node;
  return (
    readExactJavaScriptLiteral(receiver).found ||
    isDefinitelyUndefinedExpression(receiver, state) ||
    isUnshadowedGlobal(receiver, state, "Array")
  );
};

interface StaticPropertyDescriptorFacts {
  readonly hasValue: boolean;
  readonly hasGet: boolean;
  readonly hasSet: boolean;
  readonly hasNullPrototype: boolean;
  readonly valueNode?: t.Node | undefined;
  readonly getNode?: t.Node | undefined;
  readonly setNode?: t.Node | undefined;
  readonly enumerableValue?: boolean | undefined;
}

const inspectStaticPropertyDescriptorObject = (
  descObj: t.ObjectExpression,
  respectDefaultNonEnumerable: boolean,
): StaticPropertyDescriptorFacts | undefined => {
  let hasValue = false;
  let hasGet = false;
  let hasSet = false;
  let hasNullPrototype = false;
  let valueNode: t.Node | undefined;
  let getNode: t.Node | undefined;
  let setNode: t.Node | undefined;
  let enumerableValue: boolean | undefined = respectDefaultNonEnumerable
    ? false
    : true;
  for (const prop of descObj.properties) {
    if (
      t.isSpreadElement(prop) ||
      (t.isObjectMethod(prop) && prop.kind !== "method")
    )
      return undefined;
    const key = semanticStaticPropertyKey(prop.key, prop.computed);
    if (key === null) return undefined;
    if (isObjectPrototypeSetter(prop, key)) {
      if (
        t.isObjectProperty(prop) &&
        t.isNullLiteral(unwrapJavaScriptExpression(prop.value).node)
      ) {
        hasNullPrototype = true;
        continue;
      }
      return undefined;
    }
    const propVal: t.Node = t.isObjectProperty(prop) ? prop.value : prop;
    if (key === "value") {
      hasValue = true;
      valueNode = propVal;
    } else if (key === "get") {
      hasGet = true;
      getNode = propVal;
    } else if (key === "set") {
      hasSet = true;
      setNode = propVal;
    } else if (key === "enumerable") {
      const lit = t.isObjectProperty(prop)
        ? readExactJavaScriptLiteral(prop.value)
        : { found: false as const };
      enumerableValue = lit.found ? Boolean(lit.value) : undefined;
    }
  }
  return {
    hasValue,
    hasGet,
    hasSet,
    hasNullPrototype,
    valueNode,
    getNode,
    setNode,
    enumerableValue,
  };
};

const descriptorOverwritesTargetSlot = (
  facts: StaticPropertyDescriptorFacts,
  activeDescriptor: SemanticDescriptorRead | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (!facts.hasNullPrototype && hasAmbientObjectPrototypeMutation(state))
    return false;
  if (activeDescriptor === undefined || activeDescriptor.kind === "get")
    return facts.hasValue || facts.hasGet;
  if (activeDescriptor.kind === "value")
    return facts.hasValue || facts.hasGet || facts.hasSet;
  return facts.hasValue || facts.hasSet;
};

const resolveStaticDescriptorFactsForArg = (
  descArg: t.Expression | t.SpreadElement | t.ArgumentPlaceholder | undefined,
  ctx: KnownIntrinsicMemberWriteContext,
  respectDefaultNonEnumerable: boolean,
): StaticPropertyDescriptorFacts | undefined => {
  if (descArg === undefined || t.isSpreadElement(descArg)) return undefined;
  const resolved = t.isExpression(descArg)
    ? resolveSingleExpressionInCallFrame(
        descArg,
        ctx.callNode,
        ctx.current.callFrame,
        ctx.state,
      )
    : undefined;
  const descObj = resolveUnmutatedObjectExpression(
    resolved?.node ?? descArg,
    ctx.state,
    resolved?.captureAt ?? ctx.callNode,
  );
  return descObj === undefined
    ? undefined
    : inspectStaticPropertyDescriptorObject(
        descObj,
        respectDefaultNonEnumerable,
      );
};

const enqueueDescriptorValueMemberWriteSources = (
  ctx: KnownIntrinsicMemberWriteContext,
  descArg: t.Expression | t.SpreadElement | t.ArgumentPlaceholder | undefined,
  remainingSuffix: JavaScriptSemanticPropertyPath,
  respectDefaultNonEnumerable: boolean,
): void => {
  if (
    descArg === undefined ||
    (!t.isSpreadElement(descArg) &&
      isDefinitelyUndefinedExpression(descArg, ctx.state))
  )
    return;
  const activeDepth = remainingSuffix.length + 1;
  const activeDescriptor = descriptorReadAtDepth(
    ctx.current.descriptorReads,
    activeDepth,
  );
  const nextDescriptorReads = withoutDescriptorReadAtDepth(
    ctx.current.descriptorReads,
    activeDepth,
  );
  const facts = resolveStaticDescriptorFactsForArg(
    descArg,
    ctx,
    respectDefaultNonEnumerable,
  );
  if (
    facts !== undefined &&
    (facts.hasNullPrototype || !hasAmbientObjectPrototypeMutation(ctx.state))
  ) {
    if (activeDescriptor !== undefined) {
      const selectedNode =
        activeDescriptor.kind === "get"
          ? facts.hasGet
            ? facts.getNode
            : undefined
          : activeDescriptor.kind === "set"
            ? facts.hasSet
              ? facts.setNode
              : undefined
            : facts.hasGet || facts.hasSet
              ? undefined
              : facts.valueNode;
      if (
        selectedNode !== undefined &&
        !isDefinitelyUndefinedExpression(selectedNode, ctx.state)
      )
        ctx.pending.push({
          ...ctx.current,
          node: selectedNode,
          suffix: remainingSuffix,
          readAt: ctx.current.readAt ?? ctx.callNode,
          capturedSelections: semanticShiftCapturedSelections(
            ctx.capturedSelections,
            -1,
          ),
          descriptorReads: nextDescriptorReads,
        });
      return;
    }
    if (!facts.hasGet && !facts.hasSet) {
      const requiresOwnEnumerable =
        ctx.capturedSelections?.some(
          (capture) => capture.depth === 1 && capture.ownEnumerable,
        ) === true;
      if (requiresOwnEnumerable && facts.enumerableValue === false) return;
      if (facts.valueNode !== undefined)
        ctx.pending.push({
          ...ctx.current,
          node: facts.valueNode,
          suffix: remainingSuffix,
          readAt: ctx.current.readAt ?? ctx.callNode,
          capturedSelections: semanticShiftCapturedSelections(
            ctx.capturedSelections,
            -1,
          ),
          descriptorReads: nextDescriptorReads,
        });
      return;
    }
  }
  if (t.isExpression(descArg) || t.isSpreadElement(descArg))
    enqueueOpaqueInvocationArguments(
      [descArg],
      {
        ...ctx.current,
        suffix: remainingSuffix,
        descriptorReads: nextDescriptorReads,
      },
      ctx.pending,
    );
};

const enqueueDescriptorMapMemberWriteSources = (
  ctx: KnownIntrinsicMemberWriteContext,
  propsArg: t.Expression | t.SpreadElement | t.ArgumentPlaceholder | undefined,
  firstSeg: JavaScriptSemanticPropertyPath[number],
  remainingSuffix: JavaScriptSemanticPropertyPath,
): {
  readonly shadowed: ReadonlySet<string>;
  readonly overwritten: ReadonlySet<string>;
} => {
  const empty = {
    shadowed: new Set<string>(),
    overwritten: new Set<string>(),
  };
  if (
    propsArg === undefined ||
    (!t.isSpreadElement(propsArg) &&
      isDefinitelyUndefinedExpression(propsArg, ctx.state))
  )
    return empty;
  if (!t.isSpreadElement(propsArg)) {
    const resolvedProps = t.isExpression(propsArg)
      ? resolveSingleExpressionInCallFrame(
          propsArg,
          ctx.callNode,
          ctx.current.callFrame,
          ctx.state,
        )
      : undefined;
    const propsObj = resolveUnmutatedObjectExpression(
      resolvedProps?.node ?? propsArg,
      ctx.state,
      resolvedProps?.captureAt ?? ctx.callNode,
    );
    if (propsObj !== undefined) {
      const entries = new Map<string, t.ObjectProperty>();
      let staticEntries = true;
      for (const prop of propsObj.properties) {
        if (!t.isObjectProperty(prop)) {
          staticEntries = false;
          break;
        }
        const key = semanticStaticPropertyKey(prop.key, prop.computed);
        if (key === null) {
          staticEntries = false;
          break;
        }
        if (isObjectPrototypeSetter(prop, key)) {
          if (t.isNullLiteral(unwrapJavaScriptExpression(prop.value).node))
            continue;
          staticEntries = false;
          break;
        }
        entries.set(key, prop);
      }
      if (staticEntries) {
        const activeDescriptor = descriptorReadAtDepth(
          ctx.current.descriptorReads,
          remainingSuffix.length + 1,
        );
        const shadowed = new Set<string>();
        const overwritten = new Set<string>();
        for (const [key, prop] of entries) {
          shadowed.add(key);
          if (t.isExpression(prop.value)) {
            const facts = resolveStaticDescriptorFactsForArg(
              prop.value,
              ctx,
              true,
            );
            if (
              facts !== undefined &&
              descriptorOverwritesTargetSlot(facts, activeDescriptor, ctx.state)
            )
              overwritten.add(key);
            if (semanticPropertyPathKeyMatches(firstSeg, key))
              enqueueDescriptorValueMemberWriteSources(
                ctx,
                prop.value,
                remainingSuffix,
                true,
              );
          }
        }
        return { shadowed, overwritten };
      }
    }
  }
  if (t.isExpression(propsArg) || t.isSpreadElement(propsArg))
    enqueueOpaqueInvocationArguments(
      [propsArg],
      {
        ...ctx.current,
        suffix: remainingSuffix,
        descriptorReads: withoutDescriptorReadAtDepth(
          ctx.current.descriptorReads,
          remainingSuffix.length + 1,
        ),
      },
      ctx.pending,
    );
  return empty;
};

const enqueuePrototypeLinkMemberWriteSources = (
  ctx: KnownIntrinsicMemberWriteContext,
  proto: t.Expression | t.SpreadElement | t.ArgumentPlaceholder | undefined,
  shadowedKeys: ReadonlySet<string>,
): boolean => {
  if (proto === undefined) return true;
  if (t.isSpreadElement(proto) || !t.isExpression(proto)) return false;
  if (t.isNullLiteral(unwrapJavaScriptExpression(proto).node)) return true;
  if (
    descriptorReadAtDepth(
      ctx.current.descriptorReads,
      ctx.current.suffix.length,
    ) !== undefined ||
    ctx.capturedSelections?.some(
      (capture) => capture.depth === 1 && capture.ownEnumerable,
    )
  )
    return true;
  const [firstSeg, ...remainingSuffix] = ctx.current.suffix;
  for (const choice of semanticAliasSelectionChoices(firstSeg!)) {
    if (typeof choice === "string" && shadowedKeys.has(choice)) continue;
    ctx.pending.push({
      ...ctx.current,
      node: proto,
      suffix: [choice, ...remainingSuffix],
      capturedSelections: ctx.capturedSelections,
    });
    if (
      (choice === null || choice === "__proto__") &&
      !shadowedKeys.has("__proto__")
    )
      ctx.pending.push({
        ...ctx.current,
        node: proto,
        suffix: remainingSuffix,
        readAt: ctx.current.readAt ?? ctx.callNode,
        capturedSelections: semanticShiftCapturedSelections(
          ctx.capturedSelections,
          -1,
        ),
      });
  }
  return true;
};

const enqueueArrayOfMemberWriteSources = (
  ctx: KnownIntrinsicMemberWriteContext,
): boolean => {
  if (!hasStandardArrayConstructorReceiver(ctx.intrinsic, ctx.state))
    return false;
  if (
    ctx.current.suffix.length === 0 ||
    !maySelectArrayElementSegment(ctx.current.suffix[0]!)
  )
    return true;
  const activeDescriptor = descriptorReadAtDepth(
    ctx.current.descriptorReads,
    ctx.current.suffix.length,
  );
  if (activeDescriptor?.kind === "get" || activeDescriptor?.kind === "set")
    return true;
  const nextDescriptorReads = withoutDescriptorReadAtDepth(
    ctx.current.descriptorReads,
    ctx.current.suffix.length,
  );
  const callArgs = ctx.intrinsic.arguments;
  if (callArgs === undefined) return false;
  const elements: (t.Expression | t.SpreadElement)[] = [];
  for (const arg of callArgs) {
    if (!t.isExpression(arg) && !t.isSpreadElement(arg)) return false;
    elements.push(arg);
  }
  const synthetic = t.arrayExpression(elements);
  const [key, ...remaining] = ctx.current.suffix;
  const filteredAwaitDepths = ctx.current.awaitDepths?.filter(
    (depth) => depth !== ctx.current.suffix.length,
  );
  for (const choice of semanticAliasSelectionChoices(key!)) {
    for (const source of semanticArrayPropertyReferences(synthetic, [choice])) {
      const nextSuffix = [...source.path, ...remaining];
      const isSpreadSource = source.iterableFallbackPath !== undefined;
      ctx.pending.push({
        node: source.node,
        suffix: nextSuffix,
        readAt: ctx.current.readAt ?? ctx.callNode,
        capturedSelections: semanticCapturedSelectionsAfterPropertyRead(
          ctx.capturedSelections,
          source.capturedSelectionAt === undefined
            ? source
            : { ...source, capturedSelectionAt: ctx.callNode },
        ),
        descriptorReads: nextDescriptorReads,
        iteratedDepths: isSpreadSource
          ? [
              ...new Set([
                ...(ctx.current.iteratedDepths ?? []),
                nextSuffix.length,
              ]),
            ].sort((left, right) => left - right)
          : ctx.current.iteratedDepths,
        iteratedElementDepths: isSpreadSource
          ? [
              ...new Set([
                ...(ctx.current.iteratedElementDepths ?? []),
                nextSuffix.length,
              ]),
            ].sort((left, right) => left - right)
          : ctx.current.iteratedElementDepths,
        callFrame: ctx.current.callFrame,
        ...(filteredAwaitDepths === undefined ||
        filteredAwaitDepths.length === 0
          ? {}
          : { awaitDepths: filteredAwaitDepths }),
      });
    }
  }
  return true;
};

const enqueueIndexedOwnEnumerableTargetSources = (input: {
  readonly callNode: t.Node;
  readonly target: t.Expression;
  readonly indexSegment: JavaScriptSemanticPropertyPath[number];
  readonly remainingSuffix: JavaScriptSemanticPropertyPath;
  readonly current: ElectronMemberWriteCandidate;
  readonly targetCapturedSelections: readonly SemanticCapturedSelection[];
  readonly descriptorReads: readonly SemanticDescriptorRead[] | undefined;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly pending: ElectronMemberWriteCandidate[];
}): void => {
  const {
    callNode,
    target,
    indexSegment,
    remainingSuffix,
    current,
    targetCapturedSelections,
    descriptorReads,
    state,
    pending,
  } = input;
  const readAt = current.readAt ?? callNode;
  const pushTargetSegment = (
    seg: JavaScriptSemanticPropertyPath[number],
  ): void => {
    pending.push({
      ...current,
      node: target,
      suffix: [seg, ...remainingSuffix],
      readAt,
      capturedSelections: targetCapturedSelections,
      descriptorReads,
    });
  };
  const resolvedTarget = resolveSingleExpressionInCallFrame(
    target,
    callNode,
    current.callFrame,
    state,
  );
  const effectiveNode = resolvedTarget?.node ?? target;
  const effectiveCaptureAt = resolvedTarget?.captureAt ?? callNode;
  const staticKeys = staticObjectValuesKeys(
    effectiveNode,
    state,
    effectiveCaptureAt,
  );
  if (staticKeys !== undefined) {
    for (const seg of selectArrayFromInputSegments(
      indexSegment,
      staticKeys.length,
      state.precision.alias_selections,
    )) {
      if (typeof seg === "number") {
        const key = staticKeys[seg];
        if (key !== undefined) pushTargetSegment(key);
      } else if (
        seg !== null &&
        typeof seg === "object" &&
        staticKeys.length <= state.precision.alias_selections
      ) {
        for (let idx = seg.startIndex ?? 0; idx < staticKeys.length; idx += 1) {
          if (!seg.excludedKeys.includes(String(idx)))
            pushTargetSegment(staticKeys[idx]!);
        }
      } else if (
        seg === null &&
        staticKeys.length <= state.precision.alias_selections
      ) {
        for (const key of staticKeys) pushTargetSegment(key);
      } else {
        pushTargetSegment(null);
      }
    }
    return;
  }
  const denseLen = denseKnownArrayLengthAt(
    effectiveNode,
    state,
    effectiveCaptureAt,
  );
  if (denseLen !== undefined) {
    for (const seg of selectArrayFromInputSegments(
      indexSegment,
      denseLen,
      state.precision.alias_selections,
    ))
      pushTargetSegment(seg);
    return;
  }
  pushTargetSegment(null);
};

const enqueueObjectEntriesMemberWriteSources = (
  ctx: KnownIntrinsicMemberWriteContext,
): boolean => {
  if (ctx.current.suffix.length <= 1) return true;
  if (
    !maySelectArrayElementSegment(ctx.current.suffix[0]!) ||
    !semanticPropertyPathKeyMatches(ctx.current.suffix[1]!, "1")
  )
    return true;
  const outerDesc = descriptorReadAtDepth(
    ctx.current.descriptorReads,
    ctx.current.suffix.length,
  );
  const tupleDesc = descriptorReadAtDepth(
    ctx.current.descriptorReads,
    ctx.current.suffix.length - 1,
  );
  if (
    outerDesc?.kind === "get" ||
    outerDesc?.kind === "set" ||
    tupleDesc?.kind === "get" ||
    tupleDesc?.kind === "set"
  )
    return true;
  const callArgs = ctx.intrinsic.arguments;
  if (callArgs === undefined) return false;
  const [target] = callArgs;
  if (target === undefined) return true;
  if (!t.isExpression(target)) return false;
  const nextReads = withoutDescriptorReadAtDepth(
    withoutDescriptorReadAtDepth(
      ctx.current.descriptorReads,
      ctx.current.suffix.length,
    ),
    ctx.current.suffix.length - 1,
  );
  enqueueIndexedOwnEnumerableTargetSources({
    callNode: ctx.callNode,
    target,
    indexSegment: ctx.current.suffix[0]!,
    remainingSuffix: ctx.current.suffix.slice(2),
    current: ctx.current,
    targetCapturedSelections: [
      ...(semanticShiftCapturedSelections(ctx.capturedSelections, -1) ?? []),
      { at: ctx.callNode, depth: 1, ownEnumerable: true },
    ],
    descriptorReads: nextReads,
    state: ctx.state,
    pending: ctx.pending,
  });
  return true;
};

type StaticFromEntriesTupleKey =
  | { readonly kind: "string"; readonly key: string }
  | { readonly kind: "symbol" }
  | { readonly kind: "unknown" };

const classifyFromEntriesKeyExpression = (
  keyExpr: t.Expression,
  ctx: KnownIntrinsicMemberWriteContext,
): StaticFromEntriesTupleKey => {
  if (isDefinitelyUndefinedExpression(keyExpr, ctx.state))
    return { kind: "string", key: "undefined" };
  const literal = readExactJavaScriptLiteral(keyExpr);
  if (literal.found) return { kind: "string", key: String(literal.value) };
  const staticStr = ctx.interop.staticString(keyExpr);
  if (staticStr !== undefined) return { kind: "string", key: staticStr };
  if (semanticKnownSymbolKey(keyExpr, ctx.state)) return { kind: "symbol" };
  return { kind: "unknown" };
};

const staticFromEntriesTupleKeys = (
  effectiveIterable: t.Node,
  effectiveCaptureAt: t.Node,
  ctx: KnownIntrinsicMemberWriteContext,
): readonly StaticFromEntriesTupleKey[] | undefined => {
  const unwrapped = unwrapJavaScriptExpression(effectiveIterable).node;
  if (t.isCallExpression(unwrapped) || t.isOptionalCallExpression(unwrapped)) {
    const inv = ctx.interop.intrinsicInvocation(unwrapped);
    const [entriesTarget] = inv?.arguments ?? [];
    if (
      inv?.kind === "known" &&
      inv.path.join(".") === "intrinsic.Object.entries" &&
      entriesTarget !== undefined &&
      t.isExpression(entriesTarget)
    ) {
      const resolvedEntriesTarget = resolveSingleExpressionInCallFrame(
        entriesTarget,
        unwrapped,
        ctx.current.callFrame,
        ctx.state,
      );
      const keys = staticObjectValuesKeys(
        resolvedEntriesTarget?.node ?? entriesTarget,
        ctx.state,
        resolvedEntriesTarget?.captureAt ?? unwrapped,
      );
      if (
        keys !== undefined &&
        keys.length <= ctx.state.precision.alias_selections
      )
        return keys.map((key) => ({ kind: "string", key }));
    }
  }
  if (
    !semanticKnownArrayIterationAt(
      effectiveIterable,
      ctx.state,
      effectiveCaptureAt,
    )
  )
    return undefined;
  const arrExpr = resolveUnmutatedArrayExpression(
    effectiveIterable,
    ctx.state,
    effectiveCaptureAt,
  );
  if (
    arrExpr === undefined ||
    arrExpr.elements.length > ctx.state.precision.alias_selections ||
    arrExpr.elements.some((el) => el === null || t.isSpreadElement(el))
  )
    return undefined;
  return arrExpr.elements.map((elem) => {
    const tuple =
      elem === null
        ? undefined
        : resolveUnmutatedArrayExpression(elem, ctx.state, effectiveCaptureAt);
    const firstElem = tuple?.elements[0];
    if (
      tuple === undefined ||
      firstElem === undefined ||
      firstElem === null ||
      t.isSpreadElement(firstElem)
    )
      return { kind: "unknown" };
    return classifyFromEntriesKeyExpression(firstElem, ctx);
  });
};

const selectFromEntriesMatchingIndices = (
  tupleKeys: readonly StaticFromEntriesTupleKey[],
  selectedProp: JavaScriptSemanticPropertyPath[number],
): readonly number[] => {
  const matched = new Set<number>();
  for (const choice of semanticAliasSelectionChoices(selectedProp)) {
    const overwritten = new Set<string>(
      choice !== null && typeof choice === "object" ? choice.excludedKeys : [],
    );
    for (let idx = tupleKeys.length - 1; idx >= 0; idx -= 1) {
      const entry = tupleKeys[idx]!;
      if (entry.kind === "string") {
        if (overwritten.has(entry.key)) continue;
        if (choice !== null && typeof choice !== "object") {
          if (entry.key !== String(choice)) continue;
          matched.add(idx);
          break;
        }
        overwritten.add(entry.key);
        matched.add(idx);
      } else if (entry.kind === "symbol") {
        if (choice === null || typeof choice === "object") matched.add(idx);
      } else {
        matched.add(idx);
      }
    }
  }
  return [...matched].sort((left, right) => left - right);
};

const enqueueObjectFromEntriesMemberWriteSources = (
  ctx: KnownIntrinsicMemberWriteContext,
): boolean => {
  if (ctx.current.suffix.length === 0) return true;
  const activeDescriptor = descriptorReadAtDepth(
    ctx.current.descriptorReads,
    ctx.current.suffix.length,
  );
  if (activeDescriptor?.kind === "get" || activeDescriptor?.kind === "set")
    return true;
  const callArgs = ctx.intrinsic.arguments;
  if (callArgs === undefined) return false;
  const [iterable] = callArgs;
  if (iterable === undefined) return true;
  if (!t.isExpression(iterable)) return false;
  const nextDescriptorReads = withoutDescriptorReadAtDepth(
    ctx.current.descriptorReads,
    ctx.current.suffix.length,
  );
  const remainingSuffix = ctx.current.suffix.slice(1);
  const nextCaptures: readonly SemanticCapturedSelection[] = [
    ...(semanticShiftCapturedSelections(ctx.capturedSelections, 1) ?? []),
    { at: ctx.callNode, depth: 1 },
    { at: ctx.callNode, depth: 2 },
  ];
  const resolvedIterable = resolveSingleExpressionInCallFrame(
    iterable,
    ctx.callNode,
    ctx.current.callFrame,
    ctx.state,
  );
  const effectiveIterable = resolvedIterable?.node ?? iterable;
  const effectiveCaptureAt = resolvedIterable?.captureAt ?? ctx.callNode;
  const tupleKeys = staticFromEntriesTupleKeys(
    effectiveIterable,
    effectiveCaptureAt,
    ctx,
  );
  if (tupleKeys !== undefined) {
    for (const idx of selectFromEntriesMatchingIndices(
      tupleKeys,
      ctx.current.suffix[0]!,
    )) {
      ctx.pending.push({
        ...ctx.current,
        node: iterable,
        suffix: [idx, 1, ...remainingSuffix],
        readAt: ctx.current.readAt ?? ctx.callNode,
        capturedSelections: nextCaptures,
        descriptorReads: nextDescriptorReads,
      });
    }
    return true;
  }
  ctx.pending.push({
    ...ctx.current,
    node: iterable,
    suffix: [null, 1, ...remainingSuffix],
    readAt: ctx.current.readAt ?? ctx.callNode,
    capturedSelections: nextCaptures,
    descriptorReads: nextDescriptorReads,
  });
  if (
    !semanticKnownArrayIterationAt(
      effectiveIterable,
      ctx.state,
      effectiveCaptureAt,
    )
  )
    enqueueOpaqueInvocationArguments(
      [iterable],
      {
        ...ctx.current,
        suffix: remainingSuffix,
        descriptorReads: nextDescriptorReads,
      },
      ctx.pending,
    );
  return true;
};

const definePropertyTargetAllowsSlotOverwrite = (
  expr: t.Node,
  staticKeys: ReadonlySet<string>,
  ctx: {
    readonly state: JavaScriptSemanticAnalysisState;
    readonly interop: ReturnType<typeof createSemanticModuleInterop>;
    readonly captureAt: t.Node;
  },
  visited: ReadonlySet<t.Node> = new Set(),
): boolean => {
  const unfrozen =
    unwrapUnmodifiedObjectFreezeArgument(expr, ctx.state) ?? expr;
  const node = unwrapJavaScriptExpression(unfrozen).node;
  if (visited.has(node)) return false;
  const nextVisited = new Set(visited);
  nextVisited.add(node);
  if (t.isObjectExpression(node)) return true;
  if (t.isArrayExpression(node)) return !staticKeys.has("length");
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    const inv = ctx.interop.intrinsicInvocation(node);
    if (
      inv?.kind === "known" &&
      inv.path[0] === "intrinsic" &&
      inv.path[1] === "Object"
    ) {
      const method = inv.path[2];
      if (
        method === "create" ||
        method === "fromEntries" ||
        method === "groupBy"
      )
        return true;
      if (
        method === "assign" ||
        method === "defineProperty" ||
        method === "defineProperties" ||
        method === "setPrototypeOf"
      ) {
        const [innerTarget] = inv.arguments ?? [];
        return (
          innerTarget !== undefined &&
          t.isExpression(innerTarget) &&
          definePropertyTargetAllowsSlotOverwrite(
            innerTarget,
            staticKeys,
            { ...ctx, captureAt: node },
            nextVisited,
          )
        );
      }
    }
    return false;
  }
  if (t.isConditionalExpression(node) || t.isLogicalExpression(node)) {
    const branches = evaluateSemanticSelectedBranches(node, ctx.state);
    return (
      branches.length > 0 &&
      branches.every((branch) =>
        definePropertyTargetAllowsSlotOverwrite(
          branch,
          staticKeys,
          ctx,
          nextVisited,
        ),
      )
    );
  }
  if (t.isSequenceExpression(node)) {
    const last = node.expressions.at(-1);
    return (
      last !== undefined &&
      definePropertyTargetAllowsSlotOverwrite(
        last,
        staticKeys,
        ctx,
        nextVisited,
      )
    );
  }
  if (
    t.isIdentifier(node) &&
    !semanticResolutionBlocked(ctx.state, node, node.name)
  ) {
    const binding = resolveSemanticBindingState(ctx.state, node, node.name);
    if (
      binding !== undefined &&
      !binding.mutable &&
      !semanticBindingCanBeRebound(binding) &&
      binding.initializers.length === 1 &&
      binding.referenceInitializers.length === 0 &&
      binding.initializers[0]?.projection.length === 0 &&
      semanticBindingAtRead(binding, node, ctx.state).hasDefiniteInitializer &&
      !hasBindingObjectEffectsBeforeSite(binding, ctx.captureAt, ctx.state, {
        allowPlainDataMemberWrites: true,
      })
    )
      return definePropertyTargetAllowsSlotOverwrite(
        binding.initializers[0].node,
        staticKeys,
        ctx,
        nextVisited,
      );
  }
  return false;
};

const enqueueFilteredMutatorTarget = (
  ctx: KnownIntrinsicMemberWriteContext,
  target: t.Expression,
  overwrittenKeys: ReadonlySet<string>,
): void => {
  if (overwrittenKeys.size === 0) {
    ctx.pending.push({
      ...ctx.current,
      node: target,
      capturedSelections: ctx.capturedSelections,
    });
    return;
  }
  const [firstSeg, ...remainingSuffix] = ctx.current.suffix;
  const sortedOverwritten = [...overwrittenKeys].sort(compareUnicodeCodePoints);
  for (const choice of semanticAliasSelectionChoices(firstSeg!)) {
    if (choice !== null && typeof choice !== "object") {
      if (overwrittenKeys.has(String(choice))) continue;
      ctx.pending.push({
        ...ctx.current,
        node: target,
        suffix: [choice, ...remainingSuffix],
        capturedSelections: ctx.capturedSelections,
      });
      continue;
    }
    const filteredChoice =
      choice === null
        ? { excludedKeys: sortedOverwritten }
        : {
            ...choice,
            excludedKeys: [
              ...new Set([...choice.excludedKeys, ...sortedOverwritten]),
            ].sort(compareUnicodeCodePoints),
          };
    ctx.pending.push({
      ...ctx.current,
      node: target,
      suffix: [filteredChoice, ...remainingSuffix],
      capturedSelections: ctx.capturedSelections,
    });
  }
};

const enqueueObjectMutatorIntrinsicMemberWriteSources = (
  ctx: KnownIntrinsicMemberWriteContext,
): boolean => {
  const [, obj, method] = ctx.intrinsic.path;
  const callArgs = ctx.intrinsic.arguments;
  if (obj !== "Object") return false;
  if (
    method !== "defineProperty" &&
    method !== "defineProperties" &&
    method !== "setPrototypeOf"
  )
    return false;
  if (callArgs === undefined) return false;
  const [target] = callArgs;
  if (target === undefined) return true;
  if (!t.isExpression(target)) return false;
  if (ctx.current.suffix.length === 0) {
    ctx.pending.push({
      ...ctx.current,
      node: target,
      capturedSelections: ctx.capturedSelections,
    });
    return true;
  }
  if (method === "setPrototypeOf") {
    ctx.pending.push({
      ...ctx.current,
      node: target,
      capturedSelections: ctx.capturedSelections,
    });
    return enqueuePrototypeLinkMemberWriteSources(
      ctx,
      callArgs[1],
      new Set<string>(),
    );
  }
  const resolvedTarget = resolveSingleExpressionInCallFrame(
    target,
    ctx.callNode,
    ctx.current.callFrame,
    ctx.state,
  );
  const targetCtx = {
    state: ctx.state,
    interop: ctx.interop,
    captureAt: resolvedTarget?.captureAt ?? ctx.callNode,
  };
  const [firstSeg, ...remainingSuffix] = ctx.current.suffix;
  if (method === "defineProperty") {
    const keyArg = callArgs[1];
    if (keyArg !== undefined && t.isSpreadElement(keyArg)) return false;
    const staticKey = resolveDescriptorPropertyKeySegment(keyArg, ctx);
    if (
      staticKey === null ||
      semanticPropertyPathKeyMatches(firstSeg!, staticKey)
    )
      enqueueDescriptorValueMemberWriteSources(
        ctx,
        callArgs[2],
        remainingSuffix,
        true,
      );
    const activeDescriptor = descriptorReadAtDepth(
      ctx.current.descriptorReads,
      ctx.current.suffix.length,
    );
    const facts = resolveStaticDescriptorFactsForArg(callArgs[2], ctx, true);
    const candidateKeys =
      staticKey !== null &&
      facts !== undefined &&
      descriptorOverwritesTargetSlot(facts, activeDescriptor, ctx.state)
        ? new Set([staticKey])
        : new Set<string>();
    const overwrittenKeys =
      candidateKeys.size > 0 &&
      definePropertyTargetAllowsSlotOverwrite(
        resolvedTarget?.node ?? target,
        candidateKeys,
        targetCtx,
      )
        ? candidateKeys
        : new Set<string>();
    enqueueFilteredMutatorTarget(ctx, target, overwrittenKeys);
    return true;
  }
  const { overwritten } = enqueueDescriptorMapMemberWriteSources(
    ctx,
    callArgs[1],
    firstSeg!,
    remainingSuffix,
  );
  const overwrittenKeys =
    overwritten.size > 0 &&
    definePropertyTargetAllowsSlotOverwrite(
      resolvedTarget?.node ?? target,
      overwritten,
      targetCtx,
    )
      ? overwritten
      : new Set<string>();
  enqueueFilteredMutatorTarget(ctx, target, overwrittenKeys);
  return true;
};

const isPlainGetterFreeObjectTarget = (
  target: t.Expression,
  ctx: KnownIntrinsicMemberWriteContext,
): boolean => {
  const resolved = resolveSingleExpressionInCallFrame(
    target,
    ctx.callNode,
    ctx.current.callFrame,
    ctx.state,
  );
  const obj = resolveUnmutatedObjectExpression(
    resolved?.node ?? target,
    ctx.state,
    resolved?.captureAt ?? ctx.callNode,
  );
  if (obj === undefined) return false;
  let hasNullProto = false;
  for (const prop of obj.properties) {
    if (t.isSpreadElement(prop)) return false;
    const name = semanticStaticPropertyKey(prop.key, prop.computed);
    if (isObjectPrototypeSetter(prop, name)) {
      if (
        t.isObjectProperty(prop) &&
        t.isNullLiteral(unwrapJavaScriptExpression(prop.value).node)
      ) {
        hasNullProto = true;
        continue;
      }
      return false;
    }
    if (t.isObjectMethod(prop) && prop.kind === "get") return false;
  }
  return hasNullProto || !hasAmbientObjectPrototypeMutation(ctx.state);
};

const enqueueReflectGetMemberWriteSources = (
  ctx: KnownIntrinsicMemberWriteContext,
): boolean => {
  const callArgs = ctx.intrinsic.arguments;
  if (callArgs === undefined) return false;
  const [target, keyArg, receiverArg] = callArgs;
  if (target === undefined) return true;
  if (!t.isExpression(target)) return false;
  if (keyArg !== undefined && t.isSpreadElement(keyArg)) return false;
  const implicitRead = ctx.state.implicitPropertyReads.get(ctx.callNode)?.[0];
  if (implicitRead !== undefined && implicitRead.node === ctx.callNode)
    return false;
  if (callArgs.length >= 3 && receiverArg !== undefined) {
    if (!t.isExpression(receiverArg)) return false;
    const sameReceiver =
      unwrapJavaScriptExpression(receiverArg).node ===
      unwrapJavaScriptExpression(target).node;
    if (!sameReceiver && !isPlainGetterFreeObjectTarget(target, ctx))
      return false;
  }
  const recordedKey = implicitRead?.projection[0] ?? null;
  const keySeg =
    recordedKey !== null
      ? String(recordedKey)
      : resolveDescriptorPropertyKeySegment(keyArg, ctx);
  const targetNode =
    implicitRead !== undefined && t.isExpression(implicitRead.node)
      ? implicitRead.node
      : target;
  ctx.pending.push({
    ...ctx.current,
    node: targetNode,
    suffix: [keySeg, ...ctx.current.suffix],
    readAt: ctx.current.readAt ?? ctx.callNode,
    capturedSelections: [
      ...(semanticShiftCapturedSelections(ctx.capturedSelections, 1) ?? []),
      { at: ctx.callNode, depth: 1 },
    ],
  });
  return true;
};

type GroupByEvalPrimitive =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined;

type GroupByEvalValue =
  | { readonly kind: "primitive"; readonly value: GroupByEvalPrimitive }
  | { readonly kind: "symbol" }
  | { readonly kind: "node"; readonly node: t.Expression };

const evaluateGroupByBinary = (
  operator: t.BinaryExpression["operator"],
  left: GroupByEvalPrimitive,
  right: GroupByEvalPrimitive,
): GroupByEvalValue | undefined => {
  if (operator === "===") return { kind: "primitive", value: left === right };
  if (operator === "!==") return { kind: "primitive", value: left !== right };
  if (operator === "==") return { kind: "primitive", value: left == right };
  if (operator === "!=") return { kind: "primitive", value: left != right };
  if (operator === "+") {
    if (typeof left === "string" || typeof right === "string")
      return { kind: "primitive", value: `${String(left)}${String(right)}` };
    if (typeof left === "bigint" && typeof right === "bigint")
      return { kind: "primitive", value: left + right };
    if (typeof left !== "bigint" && typeof right !== "bigint")
      return { kind: "primitive", value: Number(left) + Number(right) };
    return undefined;
  }
  if (typeof left === "bigint" || typeof right === "bigint") return undefined;
  const lNum = Number(left);
  const rNum = Number(right);
  switch (operator) {
    case "-":
      return { kind: "primitive", value: lNum - rNum };
    case "*":
      return { kind: "primitive", value: lNum * rNum };
    case "/":
      return { kind: "primitive", value: lNum / rNum };
    case "%":
      return { kind: "primitive", value: lNum % rNum };
    case "<":
      return {
        kind: "primitive",
        value:
          typeof left === "string" && typeof right === "string"
            ? left < right
            : lNum < rNum,
      };
    case "<=":
      return {
        kind: "primitive",
        value:
          typeof left === "string" && typeof right === "string"
            ? left <= right
            : lNum <= rNum,
      };
    case ">":
      return {
        kind: "primitive",
        value:
          typeof left === "string" && typeof right === "string"
            ? left > right
            : lNum > rNum,
      };
    case ">=":
      return {
        kind: "primitive",
        value:
          typeof left === "string" && typeof right === "string"
            ? left >= right
            : lNum >= rNum,
      };
    case "&":
      return { kind: "primitive", value: lNum & rNum };
    case "|":
      return { kind: "primitive", value: lNum | rNum };
    case "^":
      return { kind: "primitive", value: lNum ^ rNum };
    case "<<":
      return { kind: "primitive", value: lNum << rNum };
    case ">>":
      return { kind: "primitive", value: lNum >> rNum };
    case ">>>":
      return { kind: "primitive", value: lNum >>> rNum };
    default:
      return undefined;
  }
};

const evaluateGroupByMemberRead = (
  member: t.MemberExpression | t.OptionalMemberExpression,
  env: ReadonlyMap<string, GroupByEvalValue>,
  ctx: KnownIntrinsicMemberWriteContext,
  depth: number,
): GroupByEvalValue | undefined => {
  if (!t.isExpression(member.object)) return undefined;
  const propKey = member.computed
    ? (() => {
        const keyVal = evaluateGroupByExpression(
          member.property,
          env,
          ctx,
          depth + 1,
        );
        return keyVal?.kind === "primitive" ? String(keyVal.value) : null;
      })()
    : semanticStaticPropertyKey(member.property, false);
  if (propKey === null) return undefined;
  const objVal = evaluateGroupByExpression(member.object, env, ctx, depth + 1);
  if (objVal?.kind === "primitive") {
    if (
      (objVal.value === null || objVal.value === undefined) &&
      t.isOptionalMemberExpression(member) &&
      member.optional
    )
      return { kind: "primitive", value: undefined };
    if (typeof objVal.value === "string" && propKey === "length")
      return { kind: "primitive", value: objVal.value.length };
    return undefined;
  }
  const targetExpr = objVal?.kind === "node" ? objVal.node : member.object;
  const objLit = resolveUnmutatedObjectExpression(
    targetExpr,
    ctx.state,
    ctx.callNode,
  );
  if (objLit === undefined) return undefined;
  let matched: t.Node | undefined;
  let found = false;
  for (const prop of objLit.properties) {
    if (t.isSpreadElement(prop)) return undefined;
    const key = semanticStaticPropertyKey(prop.key, prop.computed);
    if (key === null) return undefined;
    if (isObjectPrototypeSetter(prop, key)) continue;
    if (key === propKey) {
      if (!t.isObjectProperty(prop)) return undefined;
      matched = prop.value;
      found = true;
    }
  }
  if (!found)
    return hasAmbientObjectPrototypeMutation(ctx.state)
      ? undefined
      : { kind: "primitive", value: undefined };
  return matched === undefined
    ? undefined
    : evaluateGroupByExpression(matched, env, ctx, depth + 1);
};

const evaluateGroupByUnary = (
  expr: t.UnaryExpression,
  env: ReadonlyMap<string, GroupByEvalValue>,
  ctx: KnownIntrinsicMemberWriteContext,
  depth: number,
): GroupByEvalValue | undefined => {
  const arg = evaluateGroupByExpression(expr.argument, env, ctx, depth + 1);
  if (expr.operator === "void" && arg !== undefined)
    return { kind: "primitive", value: undefined };
  if (arg?.kind === "symbol" && expr.operator === "typeof")
    return { kind: "primitive", value: "symbol" };
  if (arg?.kind !== "primitive") return undefined;
  if (expr.operator === "!") return { kind: "primitive", value: !arg.value };
  if (expr.operator === "+" && typeof arg.value !== "bigint")
    return { kind: "primitive", value: Number(arg.value) };
  if (expr.operator === "-")
    return {
      kind: "primitive",
      value: typeof arg.value === "bigint" ? -arg.value : -Number(arg.value),
    };
  if (expr.operator === "~" && typeof arg.value !== "bigint")
    return { kind: "primitive", value: ~Number(arg.value) };
  if (expr.operator === "typeof")
    return { kind: "primitive", value: typeof arg.value };
  return undefined;
};

const evaluateGroupByExpression = (
  rawExpr: t.Node,
  env: ReadonlyMap<string, GroupByEvalValue>,
  ctx: KnownIntrinsicMemberWriteContext,
  depth: number,
): GroupByEvalValue | undefined => {
  if (depth > 12) return undefined;
  const expr = unwrapJavaScriptExpression(rawExpr).node;
  const literal = readExactJavaScriptLiteral(expr);
  if (literal.found) return { kind: "primitive", value: literal.value };
  if (isDefinitelyUndefinedExpression(expr, ctx.state))
    return { kind: "primitive", value: undefined };
  if (semanticKnownSymbolKey(expr, ctx.state)) return { kind: "symbol" };
  if (t.isIdentifier(expr)) {
    const local = env.get(expr.name);
    if (local !== undefined) {
      return local.kind === "node"
        ? (evaluateGroupByExpression(local.node, new Map(), ctx, depth + 1) ??
            local)
        : local;
    }
    const frameResolved = resolveSingleExpressionInCallFrame(
      expr,
      ctx.callNode,
      ctx.current.callFrame,
      ctx.state,
    );
    if (frameResolved !== undefined && frameResolved.node !== expr)
      return evaluateGroupByExpression(
        frameResolved.node,
        new Map(),
        ctx,
        depth + 1,
      );
    const evaluated = evaluateSemanticExpression(expr, ctx.state, ctx.callNode);
    return evaluated.status === "literal"
      ? { kind: "primitive", value: evaluated.value }
      : undefined;
  }
  if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr))
    return evaluateGroupByMemberRead(expr, env, ctx, depth);
  if (t.isTemplateLiteral(expr)) {
    let acc = "";
    for (let idx = 0; idx < expr.quasis.length; idx += 1) {
      acc += expr.quasis[idx]?.value.cooked ?? "";
      const sub = expr.expressions[idx];
      if (sub !== undefined) {
        const val = evaluateGroupByExpression(sub, env, ctx, depth + 1);
        if (val?.kind !== "primitive") return undefined;
        acc += String(val.value);
      }
    }
    return { kind: "primitive", value: acc };
  }
  if (t.isUnaryExpression(expr))
    return evaluateGroupByUnary(expr, env, ctx, depth);
  if (t.isBinaryExpression(expr)) {
    const left = evaluateGroupByExpression(expr.left, env, ctx, depth + 1);
    const right = evaluateGroupByExpression(expr.right, env, ctx, depth + 1);
    if (left?.kind !== "primitive" || right?.kind !== "primitive")
      return undefined;
    return evaluateGroupByBinary(expr.operator, left.value, right.value);
  }
  if (t.isConditionalExpression(expr)) {
    const test = evaluateGroupByExpression(expr.test, env, ctx, depth + 1);
    if (test?.kind !== "primitive") return undefined;
    return evaluateGroupByExpression(
      test.value ? expr.consequent : expr.alternate,
      env,
      ctx,
      depth + 1,
    );
  }
  if (t.isLogicalExpression(expr)) {
    const left = evaluateGroupByExpression(expr.left, env, ctx, depth + 1);
    if (left?.kind !== "primitive") return undefined;
    const useRight =
      expr.operator === "&&"
        ? Boolean(left.value)
        : expr.operator === "||"
          ? !left.value
          : left.value === null || left.value === undefined;
    return useRight
      ? evaluateGroupByExpression(expr.right, env, ctx, depth + 1)
      : left;
  }
  if (t.isSequenceExpression(expr)) {
    const last = expr.expressions.at(-1);
    return last === undefined
      ? undefined
      : evaluateGroupByExpression(last, env, ctx, depth + 1);
  }
  return undefined;
};

const evaluateGroupByStatements = (
  stmts: readonly t.Statement[],
  env: Map<string, GroupByEvalValue>,
  ctx: KnownIntrinsicMemberWriteContext,
  depth: number,
):
  | { readonly returned: true; readonly value: GroupByEvalValue | undefined }
  | { readonly returned: false }
  | undefined => {
  if (depth > 12) return undefined;
  for (const stmt of stmts) {
    if (t.isEmptyStatement(stmt)) continue;
    if (t.isBlockStatement(stmt)) {
      const inner = evaluateGroupByStatements(
        stmt.body,
        new Map(env),
        ctx,
        depth + 1,
      );
      if (inner === undefined || inner.returned) return inner;
      continue;
    }
    if (t.isReturnStatement(stmt)) {
      return {
        returned: true,
        value:
          stmt.argument == null
            ? { kind: "primitive", value: undefined }
            : evaluateGroupByExpression(stmt.argument, env, ctx, depth + 1),
      };
    }
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (!t.isIdentifier(decl.id)) return undefined;
        const initVal: GroupByEvalValue | undefined =
          decl.init == null
            ? { kind: "primitive", value: undefined }
            : evaluateGroupByExpression(decl.init, env, ctx, depth + 1);
        if (initVal === undefined) return undefined;
        env.set(decl.id.name, initVal);
      }
      continue;
    }
    if (t.isIfStatement(stmt)) {
      const cond = evaluateGroupByExpression(stmt.test, env, ctx, depth + 1);
      if (cond?.kind !== "primitive") return undefined;
      const chosen = cond.value ? stmt.consequent : stmt.alternate;
      if (chosen != null) {
        const res = evaluateGroupByStatements([chosen], env, ctx, depth + 1);
        if (res === undefined || res.returned) return res;
      }
      continue;
    }
    return undefined;
  }
  return { returned: false };
};

const bindGroupByCallableParameters = (
  callable: t.Function,
  elemExpr: t.Expression | undefined,
  index: number,
  ctx: KnownIntrinsicMemberWriteContext,
): Map<string, GroupByEvalValue> | undefined => {
  const env = new Map<string, GroupByEvalValue>();
  const rawArgs: (GroupByEvalValue | undefined)[] = [
    elemExpr === undefined
      ? { kind: "primitive", value: undefined }
      : { kind: "node", node: elemExpr },
    { kind: "primitive", value: index },
  ];
  const params = runtimeFunctionParameters(callable);
  for (let idx = 0; idx < params.length; idx += 1) {
    let param: t.Node = params[idx]!;
    if (t.isRestElement(param)) return undefined;
    let slotVal: GroupByEvalValue = rawArgs[idx] ?? {
      kind: "primitive",
      value: undefined,
    };
    if (t.isAssignmentPattern(param)) {
      const isUndef =
        (slotVal.kind === "primitive" && slotVal.value === undefined) ||
        (slotVal.kind === "node" &&
          isDefinitelyUndefinedExpression(slotVal.node, ctx.state));
      if (isUndef) {
        const defVal = evaluateGroupByExpression(param.right, env, ctx, 0);
        if (defVal === undefined) return undefined;
        slotVal = defVal;
      }
      param = param.left;
    }
    if (t.isIdentifier(param)) {
      env.set(param.name, slotVal);
      continue;
    }
    if (t.isObjectPattern(param) && slotVal.kind === "node") {
      for (const prop of param.properties) {
        if (t.isRestElement(prop) || !t.isIdentifier(prop.value))
          return undefined;
        const key = semanticStaticPropertyKey(prop.key, prop.computed);
        if (key === null) return undefined;
        const propVal = evaluateGroupByMemberRead(
          t.memberExpression(slotVal.node, t.stringLiteral(key), true),
          env,
          ctx,
          0,
        );
        if (propVal === undefined) return undefined;
        env.set(prop.value.name, propVal);
      }
      continue;
    }
    return undefined;
  }
  return env;
};

const partitionStaticGroupByIndices = (
  effectiveItems: t.Node,
  effectiveCaptureAt: t.Node,
  callbackArg: t.Expression,
  ctx: KnownIntrinsicMemberWriteContext,
):
  | {
      readonly groups: ReadonlyMap<string, readonly number[]>;
      readonly hasSymbolKeys: boolean;
    }
  | undefined => {
  if (
    !semanticKnownArrayIterationAt(
      effectiveItems,
      ctx.state,
      effectiveCaptureAt,
    )
  )
    return undefined;
  const arrExpr = resolveUnmutatedArrayExpression(
    effectiveItems,
    ctx.state,
    effectiveCaptureAt,
  );
  if (
    arrExpr === undefined ||
    arrExpr.elements.length > ctx.state.precision.alias_selections ||
    arrExpr.elements.some((el) => el !== null && t.isSpreadElement(el))
  )
    return undefined;
  const cbReturned = ctx.returnQueries.direct(
    callbackArg,
    undefined,
    ctx.current.callFrame,
  );
  if (
    cbReturned.unresolvedCallable ||
    cbReturned.unresolvedInvocation ||
    cbReturned.callables.size !== 1
  )
    return undefined;
  const [callable] = [...cbReturned.callables];
  if (callable === undefined || callable.async || callable.generator)
    return undefined;
  const groups = new Map<string, number[]>();
  let hasSymbolKeys = false;
  for (let idx = 0; idx < arrExpr.elements.length; idx += 1) {
    const elem = arrExpr.elements[idx];
    const elemExpr =
      elem !== null && elem !== undefined && t.isExpression(elem)
        ? elem
        : undefined;
    const env = bindGroupByCallableParameters(callable, elemExpr, idx, ctx);
    if (env === undefined) return undefined;
    let result: GroupByEvalValue | undefined;
    if (t.isBlockStatement(callable.body)) {
      const stmtRes = evaluateGroupByStatements(
        callable.body.body,
        env,
        ctx,
        0,
      );
      if (stmtRes === undefined) return undefined;
      result = stmtRes.returned
        ? stmtRes.value
        : { kind: "primitive", value: undefined };
    } else {
      result = evaluateGroupByExpression(callable.body, env, ctx, 0);
    }
    if (result === undefined || result.kind === "node") return undefined;
    if (result.kind === "symbol") {
      hasSymbolKeys = true;
      continue;
    }
    const key = String(result.value);
    const list = groups.get(key) ?? [];
    list.push(idx);
    groups.set(key, list);
  }
  return { groups, hasSymbolKeys };
};

const enqueueObjectGroupByMemberWriteSources = (
  ctx: KnownIntrinsicMemberWriteContext,
): boolean => {
  if (ctx.current.suffix.length <= 1) return true;
  if (!maySelectArrayElementSegment(ctx.current.suffix[1]!)) return true;
  const outerDesc = descriptorReadAtDepth(
    ctx.current.descriptorReads,
    ctx.current.suffix.length,
  );
  const elemDesc = descriptorReadAtDepth(
    ctx.current.descriptorReads,
    ctx.current.suffix.length - 1,
  );
  if (
    outerDesc?.kind === "get" ||
    outerDesc?.kind === "set" ||
    elemDesc?.kind === "get" ||
    elemDesc?.kind === "set"
  )
    return true;
  const callArgs = ctx.intrinsic.arguments;
  if (callArgs === undefined) return false;
  const [items, callbackArg] = callArgs;
  if (items === undefined || callbackArg === undefined) return true;
  if (!t.isExpression(items) || t.isSpreadElement(callbackArg)) return false;
  const nextDescriptorReads = withoutDescriptorReadAtDepth(
    withoutDescriptorReadAtDepth(
      ctx.current.descriptorReads,
      ctx.current.suffix.length,
    ),
    ctx.current.suffix.length - 1,
  );
  const nextCaptures: readonly SemanticCapturedSelection[] = [
    ...(semanticShiftCapturedSelections(ctx.capturedSelections, -1) ?? []),
    { at: ctx.callNode, depth: 1 },
  ];
  const resolvedItems = resolveSingleExpressionInCallFrame(
    items,
    ctx.callNode,
    ctx.current.callFrame,
    ctx.state,
  );
  const effectiveItems = resolvedItems?.node ?? items;
  const effectiveCaptureAt = resolvedItems?.captureAt ?? ctx.callNode;
  const partition = t.isExpression(callbackArg)
    ? partitionStaticGroupByIndices(
        effectiveItems,
        effectiveCaptureAt,
        callbackArg,
        ctx,
      )
    : undefined;
  const [groupSeg, elemSeg, ...remainingSuffix] = ctx.current.suffix;
  const groupMatchesWildcard = semanticAliasSelectionChoices(groupSeg!).some(
    (choice) => choice === null || typeof choice === "object",
  );
  if (
    partition !== undefined &&
    !(partition.hasSymbolKeys && groupMatchesWildcard)
  ) {
    const matchedIndices = new Set<number>();
    for (const [groupKey, groupIndices] of partition.groups) {
      if (
        !semanticAliasSelectionChoices(groupSeg!).some((choice) =>
          semanticPropertyPathKeyMatches(choice, groupKey),
        )
      )
        continue;
      for (const localSeg of selectArrayFromInputSegments(
        elemSeg!,
        groupIndices.length,
        ctx.state.precision.alias_selections,
      )) {
        if (typeof localSeg === "number") {
          const origIdx = groupIndices[localSeg];
          if (origIdx !== undefined) matchedIndices.add(origIdx);
        } else if (localSeg !== null && typeof localSeg === "object") {
          for (
            let li = localSeg.startIndex ?? 0;
            li < groupIndices.length;
            li += 1
          )
            if (!localSeg.excludedKeys.includes(String(li)))
              matchedIndices.add(groupIndices[li]!);
        } else {
          for (const origIdx of groupIndices) matchedIndices.add(origIdx);
        }
      }
    }
    for (const origIdx of [...matchedIndices].sort((a, b) => a - b)) {
      ctx.pending.push({
        ...ctx.current,
        node: items,
        suffix: [origIdx, ...remainingSuffix],
        readAt: ctx.current.readAt ?? ctx.callNode,
        capturedSelections: nextCaptures,
        descriptorReads: nextDescriptorReads,
      });
    }
    return true;
  }
  ctx.pending.push({
    ...ctx.current,
    node: items,
    suffix: [null, ...remainingSuffix],
    readAt: ctx.current.readAt ?? ctx.callNode,
    capturedSelections: nextCaptures,
    descriptorReads: nextDescriptorReads,
  });
  if (
    !semanticKnownArrayIterationAt(
      effectiveItems,
      ctx.state,
      effectiveCaptureAt,
    )
  )
    enqueueOpaqueInvocationArguments(
      [items],
      {
        ...ctx.current,
        suffix: remainingSuffix,
        descriptorReads: nextDescriptorReads,
      },
      ctx.pending,
    );
  return true;
};

const isScalarMetadataIntrinsic = (obj: string, method: string): boolean =>
  (obj === "Object" &&
    (method === "keys" ||
      method === "getOwnPropertyNames" ||
      method === "getOwnPropertySymbols" ||
      method === "is" ||
      method === "hasOwn" ||
      method === "isExtensible" ||
      method === "isFrozen" ||
      method === "isSealed")) ||
  (obj === "Array" && method === "isArray") ||
  (obj === "Reflect" &&
    (method === "defineProperty" ||
      method === "deleteProperty" ||
      method === "has" ||
      method === "isExtensible" ||
      method === "preventExtensions" ||
      method === "set" ||
      method === "setPrototypeOf" ||
      method === "ownKeys"));

const enqueueContainerIntrinsicMemberWriteSources = (
  ctx: KnownIntrinsicMemberWriteContext,
): boolean => {
  if (ctx.intrinsic.path.length !== 3 || ctx.intrinsic.path[0] !== "intrinsic")
    return false;
  const [, obj, method] = ctx.intrinsic.path;
  if (obj === undefined || method === undefined) return false;
  const callArgs = ctx.intrinsic.arguments;
  if (isScalarMetadataIntrinsic(obj, method)) return true;
  if ((obj === "Object" || obj === "Reflect") && method === "getPrototypeOf") {
    if (callArgs === undefined) return false;
    const [target] = callArgs;
    if (target === undefined) return true;
    if (!t.isExpression(target)) return false;
    ctx.pending.push({
      ...ctx.current,
      node: target,
      suffix: ["__proto__", ...ctx.current.suffix],
      readAt: ctx.current.readAt ?? ctx.callNode,
      capturedSelections: semanticShiftCapturedSelections(
        ctx.capturedSelections,
        1,
      ),
    });
    return true;
  }
  if (obj === "Reflect" && method === "get")
    return enqueueReflectGetMemberWriteSources(ctx);
  if (obj === "Object" && method === "create") {
    if (ctx.current.suffix.length === 0) return true;
    if (callArgs === undefined) return false;
    const [firstSeg, ...remainingSuffix] = ctx.current.suffix;
    const { shadowed } = enqueueDescriptorMapMemberWriteSources(
      ctx,
      callArgs[1],
      firstSeg!,
      remainingSuffix,
    );
    return enqueuePrototypeLinkMemberWriteSources(ctx, callArgs[0], shadowed);
  }
  if (obj === "Array" && method === "of")
    return enqueueArrayOfMemberWriteSources(ctx);
  if (obj === "Array" && method === "fromAsync") {
    if (!hasStandardArrayConstructorReceiver(ctx.intrinsic, ctx.state))
      return false;
    return ctx.current.suffix.length === 0;
  }
  if (enqueueObjectMutatorIntrinsicMemberWriteSources(ctx)) return true;
  if (obj === "Object" && method === "entries")
    return enqueueObjectEntriesMemberWriteSources(ctx);
  if (obj === "Object" && method === "fromEntries")
    return enqueueObjectFromEntriesMemberWriteSources(ctx);
  if (obj === "Object" && method === "groupBy")
    return enqueueObjectGroupByMemberWriteSources(ctx);
  return enqueueDescriptorReaderIntrinsicMemberWriteSources(ctx);
};

const matchingDescriptorFieldKinds = (
  descProp: JavaScriptSemanticPropertyPath[number],
): readonly ("value" | "get" | "set")[] => {
  const kinds: ("value" | "get" | "set")[] = [];
  for (const kind of ["value", "get", "set"] as const) {
    if (semanticPropertyPathKeyMatches(descProp, kind)) kinds.push(kind);
  }
  return kinds;
};

const resolveDescriptorPropertyKeySegment = (
  keyArg: t.Expression | t.ArgumentPlaceholder | undefined,
  ctx: {
    readonly callNode: t.Node;
    readonly current: {
      readonly callFrame?: ElectronMemberWriteCallFrame | undefined;
    };
    readonly state: JavaScriptSemanticAnalysisState;
    readonly interop: ReturnType<typeof createSemanticModuleInterop>;
  },
): string | null => {
  if (keyArg === undefined) return "undefined";
  if (t.isArgumentPlaceholder(keyArg)) return null;
  const resolved =
    resolveSingleExpressionInCallFrame(
      keyArg,
      ctx.callNode,
      ctx.current.callFrame,
      ctx.state,
    )?.node ?? keyArg;
  if (isDefinitelyUndefinedExpression(resolved, ctx.state)) return "undefined";
  const literal = readExactJavaScriptLiteral(resolved);
  if (literal.found) return String(literal.value);
  return ctx.interop.staticString(resolved) ?? null;
};

const enqueueDescriptorReaderIntrinsicMemberWriteSources = (
  ctx: KnownIntrinsicMemberWriteContext,
): boolean => {
  const [, obj, method] = ctx.intrinsic.path;
  const callArgs = ctx.intrinsic.arguments;
  if (
    (obj === "Object" || obj === "Reflect") &&
    method === "getOwnPropertyDescriptor"
  ) {
    if (ctx.current.suffix.length === 0) return true;
    const outerDesc = descriptorReadAtDepth(
      ctx.current.descriptorReads,
      ctx.current.suffix.length,
    );
    if (outerDesc?.kind === "get" || outerDesc?.kind === "set") return true;
    const [descProp, ...rest] = ctx.current.suffix;
    const matchedKinds = matchingDescriptorFieldKinds(descProp!);
    if (matchedKinds.length === 0) return true;
    if (callArgs === undefined) return false;
    const [target, keyArg] = callArgs;
    if (target === undefined) return true;
    if (!t.isExpression(target)) return false;
    if (keyArg !== undefined && t.isSpreadElement(keyArg)) return false;
    const keySeg = resolveDescriptorPropertyKeySegment(keyArg, ctx);
    const baseReads = withoutDescriptorReadAtDepth(
      ctx.current.descriptorReads,
      ctx.current.suffix.length,
    );
    for (const kind of matchedKinds) {
      ctx.pending.push({
        ...ctx.current,
        node: target,
        suffix: [keySeg, ...rest],
        readAt: ctx.current.readAt ?? ctx.callNode,
        capturedSelections: [
          ...(ctx.capturedSelections ?? []),
          { at: ctx.callNode, depth: 1 },
        ],
        descriptorReads: withDescriptorReadAtDepth(
          baseReads,
          rest.length + 1,
          kind,
        ),
      });
    }
    return true;
  }
  if (obj === "Object" && method === "getOwnPropertyDescriptors") {
    if (ctx.current.suffix.length <= 1) return true;
    const outerMapDesc = descriptorReadAtDepth(
      ctx.current.descriptorReads,
      ctx.current.suffix.length,
    );
    const innerEntryDesc = descriptorReadAtDepth(
      ctx.current.descriptorReads,
      ctx.current.suffix.length - 1,
    );
    if (
      outerMapDesc?.kind === "get" ||
      outerMapDesc?.kind === "set" ||
      innerEntryDesc?.kind === "get" ||
      innerEntryDesc?.kind === "set"
    )
      return true;
    const [propSeg, descProp, ...rest] = ctx.current.suffix;
    const matchedKinds = matchingDescriptorFieldKinds(descProp!);
    if (matchedKinds.length === 0) return true;
    if (callArgs === undefined) return false;
    const [target] = callArgs;
    if (target === undefined) return true;
    if (!t.isExpression(target)) return false;
    const baseReads = withoutDescriptorReadAtDepth(
      withoutDescriptorReadAtDepth(
        ctx.current.descriptorReads,
        ctx.current.suffix.length,
      ),
      ctx.current.suffix.length - 1,
    );
    for (const kind of matchedKinds) {
      ctx.pending.push({
        ...ctx.current,
        node: target,
        suffix: [propSeg!, ...rest],
        readAt: ctx.current.readAt ?? ctx.callNode,
        capturedSelections: [
          ...(semanticShiftCapturedSelections(ctx.capturedSelections, -1) ??
            []),
          { at: ctx.callNode, depth: 1 },
        ],
        descriptorReads: withDescriptorReadAtDepth(
          baseReads,
          rest.length + 1,
          kind,
        ),
      });
    }
    return true;
  }
  return false;
};

const enqueueNonIdentifierMemberWriteSources = (
  node: t.Node,
  current: ElectronMemberWriteCandidate,
  capturedSelections: readonly SemanticCapturedSelection[] | undefined,
  state: JavaScriptSemanticAnalysisState,
  interop: ReturnType<typeof createSemanticModuleInterop>,
  returnQueries: ElectronMemberWriteReturnQueries,
  allocateFrameId: () => number,
  addPath: (candidate: JavaScriptSemanticPropertyPath) => void,
  pending: ElectronMemberWriteCandidate[],
): void => {
  if (t.isThisExpression(node)) {
    const owner = enclosingNonArrowFunction(node, state);
    if (owner !== undefined) {
      for (
        let frame = current.callFrame;
        frame !== undefined;
        frame = frame.parentFrame
      ) {
        if (!frame.receiverCallables.has(owner)) continue;
        for (const receiverSource of frame.receiverSources)
          pending.push({
            node: receiverSource,
            suffix: current.suffix,
            readAt: frame.callReadAt,
            capturedSelections,
            awaitDepths: current.awaitDepths,
            iteratedDepths: current.iteratedDepths,
            iteratedElementDepths: current.iteratedElementDepths,
            callFrame: frame.parentFrame,
          });
        break;
      }
    }
    return;
  }
  const directSource =
    interop.callOrigin(node)?.origin ??
    electronRequireOrigin(node, state)?.origin ??
    (
      semanticRequireOriginCandidate(node, state) ??
      semanticBundledRequireOriginCandidate(node, state)
    )?.origin;
  if (
    directSource !== undefined &&
    ELECTRON_MODULE.test(directSource.specifier)
  ) {
    addPath([
      ...electronExportPath(directSource.importedPath),
      ...current.suffix,
    ]);
    return;
  }
  const frozenTarget = unwrapUnmodifiedObjectFreezeArgument(node, state);
  if (frozenTarget !== undefined) {
    pending.push({ ...current, node: frozenTarget, capturedSelections });
    return;
  }
  if (t.isForOfStatement(node)) {
    const nextIteratedDepths = [
      ...new Set([
        ...(current.iteratedDepths ?? []),
        current.suffix.length + 1,
      ]),
    ].sort((left, right) => left - right);
    const nextIteratedElementDepths = [
      ...new Set([
        ...(current.iteratedElementDepths ?? []),
        current.suffix.length + 1,
      ]),
    ].sort((left, right) => left - right);
    pending.push({
      node: node.right,
      suffix: [null, ...current.suffix],
      readAt: current.readAt ?? node,
      capturedSelections: semanticShiftCapturedSelections(
        capturedSelections,
        1,
      ),
      iteratedDepths: nextIteratedDepths,
      iteratedElementDepths: nextIteratedElementDepths,
      callFrame: current.callFrame,
      ...(node.await
        ? {
            awaitDepths: [
              ...new Set([
                ...(current.awaitDepths ?? []),
                current.suffix.length,
              ]),
            ].sort((left, right) => left - right),
          }
        : {}),
    });
    if (node.await || !semanticKnownArrayIterationAt(node.right, state)) {
      pending.push(
        {
          node: node.right,
          suffix: current.suffix,
          readAt: current.readAt ?? node,
          capturedSelections,
          iteratedDepths: [
            ...new Set([
              ...(current.iteratedDepths ?? []),
              current.suffix.length,
            ]),
          ].sort((left, right) => left - right),
          iteratedElementDepths: current.iteratedElementDepths,
          callFrame: current.callFrame,
        },
        {
          node: node.right,
          suffix: [],
          readAt: current.readAt ?? node,
          callFrame: current.callFrame,
        },
      );
    }
  } else if (
    t.isCallExpression(node) ||
    t.isOptionalCallExpression(node) ||
    t.isTaggedTemplateExpression(node)
  ) {
    const intrinsic = t.isTaggedTemplateExpression(node)
      ? undefined
      : interop.intrinsicInvocation(node);
    if (intrinsic?.kind === "known" && intrinsic.path.length === 3) {
      const [ns, obj, method] = intrinsic.path;
      const callArgs = intrinsic.arguments;
      if (
        ns === "intrinsic" &&
        obj === "Object" &&
        (method === "freeze" ||
          method === "seal" ||
          method === "preventExtensions") &&
        callArgs !== undefined
      ) {
        const [target] = callArgs;
        if (target === undefined) return;
        if (t.isExpression(target)) {
          pending.push({ ...current, node: target, capturedSelections });
          return;
        }
      }
      if (
        ns === "intrinsic" &&
        obj === "Object" &&
        method === "assign" &&
        callArgs !== undefined
      ) {
        if (callArgs.length === 0) return;
        const [target, ...sources] = callArgs;
        if (target === undefined) return;
        if (t.isSpreadElement(target)) {
          enqueueOpaqueInvocationArguments(callArgs, current, pending);
          return;
        }
        if (current.suffix.length === 0) {
          if (t.isExpression(target))
            pending.push({ ...current, node: target, capturedSelections });
          return;
        }
        const assignActiveDesc = descriptorReadAtDepth(
          current.descriptorReads,
          current.suffix.length,
        );
        const assignSourceReads = withoutDescriptorReadAtDepth(
          current.descriptorReads,
          current.suffix.length,
        );
        const resolvedAssignTarget = t.isExpression(target)
          ? resolveSingleExpressionInCallFrame(
              target,
              node,
              current.callFrame,
              state,
            )
          : undefined;
        const [firstSegment, ...remainingSuffix] = current.suffix;
        for (const choice of semanticAliasSelectionChoices(firstSegment!)) {
          if (
            assignActiveDesc?.kind === "get" ||
            assignActiveDesc?.kind === "set"
          ) {
            if (t.isExpression(target))
              pending.push({
                ...current,
                node: target,
                suffix: [choice, ...remainingSuffix],
                capturedSelections,
              });
            continue;
          }
          const canPrune = objectAssignTargetAllowsOverwrite(
            resolvedAssignTarget?.node ?? target,
            choice,
            state,
            interop,
            resolvedAssignTarget?.captureAt ?? node,
          );
          const overwritten = new Set<string>();
          let covered = false;
          const withExcluded = (
            segment: typeof choice,
          ): JavaScriptSemanticPropertyPath[number] => {
            if (overwritten.size === 0) return segment;
            if (segment === null)
              return {
                excludedKeys: [...overwritten].sort(compareUnicodeCodePoints),
              };
            if (typeof segment === "object")
              return {
                ...segment,
                excludedKeys: [
                  ...new Set([...segment.excludedKeys, ...overwritten]),
                ].sort(compareUnicodeCodePoints),
              };
            return segment;
          };
          for (let idx = sources.length - 1; idx >= 0; idx -= 1) {
            const src = sources[idx]!;
            const selectedChoice = withExcluded(choice);
            if (t.isSpreadElement(src)) {
              pending.push({
                node: src.argument,
                suffix: [null, selectedChoice, ...remainingSuffix],
                readAt: current.readAt ?? node,
                capturedSelections: [
                  ...(semanticShiftCapturedSelections(capturedSelections, 1) ??
                    []),
                  { at: src.argument, depth: 1 },
                  { at: node, depth: 2, ownEnumerable: true },
                ],
                descriptorReads: assignSourceReads,
                awaitDepths: current.awaitDepths,
                iteratedDepths: current.iteratedDepths,
                iteratedElementDepths: current.iteratedElementDepths,
                callFrame: current.callFrame,
              });
              if (!semanticKnownArrayIterationAt(src.argument, state))
                pending.push(
                  {
                    node: src.argument,
                    suffix: [selectedChoice, ...remainingSuffix],
                    readAt: current.readAt ?? node,
                    descriptorReads: assignSourceReads,
                    callFrame: current.callFrame,
                  },
                  {
                    node: src.argument,
                    suffix: [],
                    readAt: current.readAt ?? node,
                    callFrame: current.callFrame,
                  },
                );
              continue;
            }
            if (!t.isExpression(src)) continue;
            pending.push({
              ...current,
              node: src,
              suffix: [selectedChoice, ...remainingSuffix],
              readAt: current.readAt ?? node,
              capturedSelections: [
                ...(capturedSelections ?? []),
                { at: node, depth: 1, ownEnumerable: true },
              ],
              descriptorReads: assignSourceReads,
            });
            if (!canPrune) continue;
            const resolvedSrc = resolveSingleExpressionInCallFrame(
              src,
              node,
              current.callFrame,
              state,
            );
            const definedKeys = definiteObjectAssignSourceKeys(
              resolvedSrc?.node ?? src,
              state,
              interop,
              resolvedSrc?.captureAt ?? node,
            );
            if (choice !== null && typeof choice !== "object") {
              if (definedKeys.has(String(choice))) {
                covered = true;
                break;
              }
            } else {
              for (const definedKey of definedKeys) overwritten.add(definedKey);
            }
          }
          if (!covered && t.isExpression(target))
            pending.push({
              ...current,
              node: target,
              suffix: [withExcluded(choice), ...remainingSuffix],
              capturedSelections,
            });
        }
        return;
      }
      if (ns === "intrinsic" && obj === "Object" && method === "values") {
        if (current.suffix.length === 0) return;
        if (!maySelectArrayElementSegment(current.suffix[0]!)) return;
        const valuesDesc = descriptorReadAtDepth(
          current.descriptorReads,
          current.suffix.length,
        );
        if (valuesDesc?.kind === "get" || valuesDesc?.kind === "set") return;
        if (callArgs !== undefined) {
          const [target] = callArgs;
          if (target === undefined) return;
          if (t.isExpression(target)) {
            enqueueIndexedOwnEnumerableTargetSources({
              callNode: node,
              target,
              indexSegment: current.suffix[0]!,
              remainingSuffix: current.suffix.slice(1),
              current,
              targetCapturedSelections: [
                ...(capturedSelections ?? []),
                { at: node, depth: 1, ownEnumerable: true },
              ],
              descriptorReads: withoutDescriptorReadAtDepth(
                current.descriptorReads,
                current.suffix.length,
              ),
              state,
              pending,
            });
            return;
          }
        }
      }
      if (
        ns === "intrinsic" &&
        obj === "Array" &&
        method === "from" &&
        hasStandardArrayConstructorReceiver(intrinsic, state)
      ) {
        if (current.suffix.length === 0) return;
        if (!maySelectArrayElementSegment(current.suffix[0]!)) return;
        const arrayFromDesc = descriptorReadAtDepth(
          current.descriptorReads,
          current.suffix.length,
        );
        if (arrayFromDesc?.kind === "get" || arrayFromDesc?.kind === "set")
          return;
        const nextArrayFromReads = withoutDescriptorReadAtDepth(
          current.descriptorReads,
          current.suffix.length,
        );
        if (callArgs !== undefined) {
          const elementSuffix = current.suffix.slice(1);
          const readAt = current.readAt ?? node;
          const [iterable, mapFn, thisArg] = callArgs;
          const iterableExpr =
            iterable !== undefined && t.isExpression(iterable)
              ? iterable
              : undefined;
          const resolvedIterable = resolveSingleExpressionInCallFrame(
            iterableExpr,
            node,
            current.callFrame,
            state,
          );
          const effectiveIterableExpr = resolvedIterable?.node;
          const effectiveIterableCaptureAt =
            resolvedIterable?.captureAt ?? node;
          const knownArrayIter =
            effectiveIterableExpr !== undefined &&
            semanticKnownArrayIterationAt(
              effectiveIterableExpr,
              state,
              effectiveIterableCaptureAt,
            );
          const denseArrayLen =
            knownArrayIter && effectiveIterableExpr !== undefined
              ? denseKnownArrayLengthAt(
                  effectiveIterableExpr,
                  state,
                  effectiveIterableCaptureAt,
                )
              : undefined;
          const arrayLike =
            !knownArrayIter && effectiveIterableExpr !== undefined
              ? nonIterableArrayLikeFacts(
                  effectiveIterableExpr,
                  state,
                  effectiveIterableCaptureAt,
                )
              : undefined;
          const positional = knownArrayIter || arrayLike !== undefined;
          const knownLength = knownArrayIter
            ? denseArrayLen
            : arrayLike?.knownLength;
          const inputSegments = positional
            ? selectArrayFromInputSegments(
                current.suffix[0]!,
                knownLength,
                state.precision.alias_selections,
              )
            : [null];
          const slotContext: InvocationSlotContext = {
            callSite: node,
            callFrame: current.callFrame,
            state,
          };
          const enqueueDirectCopy = (): void => {
            if (iterable === undefined) return;
            if (t.isSpreadElement(iterable)) {
              pending.push(
                {
                  node: iterable.argument,
                  suffix: [null, null, ...elementSuffix],
                  readAt,
                  capturedSelections: [
                    ...(semanticShiftCapturedSelections(
                      capturedSelections,
                      1,
                    ) ?? []),
                    { at: iterable.argument, depth: 1 },
                    { at: node, depth: 2 },
                  ],
                  descriptorReads: nextArrayFromReads,
                  callFrame: current.callFrame,
                },
                {
                  node: iterable.argument,
                  suffix: [null, ...elementSuffix],
                  readAt,
                  capturedSelections: [
                    ...(capturedSelections ?? []),
                    { at: iterable.argument, depth: 1 },
                  ],
                  descriptorReads: nextArrayFromReads,
                  callFrame: current.callFrame,
                },
              );
              return;
            }
            if (!t.isExpression(iterable)) return;
            const iterableCapturedSelections: readonly SemanticCapturedSelection[] =
              [...(capturedSelections ?? []), { at: node, depth: 1 }];
            if (knownArrayIter) {
              for (const seg of inputSegments) {
                const nextSuffix = [seg, ...elementSuffix];
                pending.push({
                  ...current,
                  node: iterable,
                  suffix: nextSuffix,
                  readAt,
                  capturedSelections: iterableCapturedSelections,
                  descriptorReads: nextArrayFromReads,
                  iteratedDepths: [
                    ...new Set([
                      ...(current.iteratedDepths ?? []),
                      nextSuffix.length,
                    ]),
                  ].sort((left, right) => left - right),
                  iteratedElementDepths: [
                    ...new Set([
                      ...(current.iteratedElementDepths ?? []),
                      nextSuffix.length,
                    ]),
                  ].sort((left, right) => left - right),
                });
              }
              return;
            }
            if (arrayLike !== undefined) {
              for (const seg of inputSegments)
                pending.push({
                  ...current,
                  node: iterable,
                  suffix: [seg, ...elementSuffix],
                  readAt,
                  capturedSelections: iterableCapturedSelections,
                  descriptorReads: nextArrayFromReads,
                });
              return;
            }
            pending.push(
              {
                ...current,
                node: iterable,
                capturedSelections: iterableCapturedSelections,
                descriptorReads: nextArrayFromReads,
                iteratedDepths: [
                  ...new Set([
                    ...(current.iteratedDepths ?? []),
                    current.suffix.length,
                  ]),
                ].sort((left, right) => left - right),
                iteratedElementDepths: [
                  ...new Set([
                    ...(current.iteratedElementDepths ?? []),
                    current.suffix.length,
                  ]),
                ].sort((left, right) => left - right),
              },
              {
                node: iterable,
                suffix: [null, ...elementSuffix],
                readAt,
                capturedSelections: iterableCapturedSelections,
                descriptorReads: nextArrayFromReads,
                iteratedDepths: [
                  ...new Set([
                    ...(current.iteratedDepths ?? []),
                    elementSuffix.length + 1,
                  ]),
                ].sort((left, right) => left - right),
                iteratedElementDepths: [
                  ...new Set([
                    ...(current.iteratedElementDepths ?? []),
                    elementSuffix.length + 1,
                  ]),
                ].sort((left, right) => left - right),
                callFrame: current.callFrame,
              },
              {
                node: iterable,
                suffix: elementSuffix,
                readAt,
                capturedSelections: semanticShiftCapturedSelections(
                  capturedSelections,
                  -1,
                ),
                descriptorReads: nextArrayFromReads,
                iteratedDepths: [
                  ...new Set([
                    ...(current.iteratedDepths ?? []),
                    elementSuffix.length,
                  ]),
                ].sort((left, right) => left - right),
                iteratedElementDepths: current.iteratedElementDepths,
                callFrame: current.callFrame,
              },
            );
          };
          if (mapFn === undefined) {
            enqueueDirectCopy();
            return;
          }
          if (
            t.isSpreadElement(mapFn) ||
            (iterable !== undefined && t.isSpreadElement(iterable))
          ) {
            enqueueDirectCopy();
            enqueueOpaqueInvocationArguments(
              callArgs,
              {
                ...current,
                suffix: elementSuffix,
                descriptorReads: nextArrayFromReads,
              },
              pending,
            );
            return;
          }
          if (
            isInvocationSlotDefinitelyUndefined(
              { node: mapFn, projection: [] },
              slotContext,
            )
          ) {
            enqueueDirectCopy();
            return;
          }
          if (inputSegments.length === 0) return;
          const isElementIterated =
            current.iteratedDepths?.includes(elementSuffix.length) === true;
          const isElementIteratedItem =
            current.iteratedElementDepths?.includes(elementSuffix.length) ===
            true;
          const isElementAwaited =
            current.awaitDepths?.includes(elementSuffix.length) === true;
          const mapped = isElementIterated
            ? returnQueries.potential(mapFn, undefined, current.callFrame)
            : isElementAwaited
              ? returnQueries.awaited(mapFn, undefined, current.callFrame)
              : returnQueries.direct(mapFn, undefined, current.callFrame);
          if (mapped.unresolvedCallable || mapped.unresolvedInvocation)
            enqueueDirectCopy();
          const {
            parameterSources: mapParams,
            inactiveDefaultNodes: mapInactiveDefaults,
          } = bindArrayFromMapperParameters(
            iterableExpr,
            inputSegments,
            positional,
            knownLength,
            mapped.callables,
            slotContext,
          );
          const mapReceiverSources =
            thisArg !== undefined && t.isExpression(thisArg) ? [thisArg] : [];
          const { frame: mapCallFrame, overflowed: mapFrameOverflow } =
            createNextCallFrame({
              allocateId: allocateFrameId,
              callSite: node,
              callReadAt: current.readAt ?? node,
              parentFrame: current.callFrame,
              callables: mapped.callables,
              parameterSources: mapParams,
              inactiveDefaultNodes: mapInactiveDefaults,
              receiverCallables: nonArrowReceiverCallables(mapped.callables),
              receiverSources: mapReceiverSources,
            });
          const filteredMapAwaitDepths = isElementAwaited
            ? current.awaitDepths?.filter(
                (depth) => depth !== elementSuffix.length,
              )
            : current.awaitDepths;
          for (const ref of mapped.references) {
            const isGeneratorResult =
              ref.resultKind === "iterator" ||
              ref.resultKind === "async-iterator";
            if (isElementIterated && isGeneratorResult && ref.kind !== "yield")
              continue;
            const refElementSuffix =
              isElementIteratedItem &&
              isGeneratorResult &&
              elementSuffix.length > 0
                ? elementSuffix.slice(1)
                : elementSuffix;
            const refCaptures =
              !isGeneratorResult &&
              ref.resultKind !== "promise" &&
              ref.projection.length > 0
                ? buildPrefixCaptures(node, ref.projection.length)
                : undefined;
            pending.push({
              node: ref.node,
              suffix: [...ref.projection, ...refElementSuffix],
              readAt: current.readAt ?? node,
              capturedSelections: [
                ...(semanticShiftCapturedSelections(
                  capturedSelections,
                  ref.projection.length,
                ) ?? []),
                ...(refCaptures ?? []),
              ],
              descriptorReads: nextArrayFromReads,
              ...(filteredMapAwaitDepths === undefined ||
              filteredMapAwaitDepths.length === 0
                ? {}
                : { awaitDepths: filteredMapAwaitDepths }),
              iteratedDepths: current.iteratedDepths,
              iteratedElementDepths: current.iteratedElementDepths,
              callFrame: mapCallFrame,
            });
          }
          if (
            mapFrameOverflow ||
            mapped.unresolvedCallable ||
            mapped.unresolvedInvocation
          )
            enqueueOpaqueInvocationArguments(
              callArgs,
              {
                ...current,
                suffix: elementSuffix,
                descriptorReads: nextArrayFromReads,
              },
              pending,
            );
          return;
        }
      }
      if (
        !t.isTaggedTemplateExpression(node) &&
        enqueueContainerIntrinsicMemberWriteSources({
          callNode: node,
          intrinsic,
          current,
          capturedSelections,
          state,
          interop,
          returnQueries,
          pending,
        })
      )
        return;
    }
    const calleeNode = t.isTaggedTemplateExpression(node)
      ? node.tag
      : node.callee;
    const rawArguments = t.isTaggedTemplateExpression(node)
      ? javaScriptTaggedTemplateArguments(node)
      : node.arguments;
    const isIterated =
      current.iteratedDepths?.includes(current.suffix.length) === true;
    const isIteratedElement =
      current.iteratedElementDepths?.includes(current.suffix.length) === true;
    const isAwaited =
      current.awaitDepths?.includes(current.suffix.length) === true;
    const queryFn = isIterated
      ? returnQueries.potential
      : isAwaited
        ? returnQueries.awaited
        : returnQueries.direct;
    const baseReturned = queryFn(calleeNode, node, current.callFrame);
    const returned = baseReturned.unresolvedCallable
      ? (resolveDescriptorReaderCallableTargets({
          calleeNode,
          callSite: node,
          callFrame: current.callFrame,
          queryFn,
          interop,
          state,
        }) ?? baseReturned)
      : baseReturned;
    const {
      parameterSources,
      inactiveDefaultNodes,
      receiverSources,
      hasOpaqueArguments,
    } = mapInvocationParameterSources(returned, rawArguments, {
      callSite: node,
      callFrame: current.callFrame,
      state,
    });
    const { frame: nextCallFrame, overflowed: callFrameOverflow } =
      createNextCallFrame({
        allocateId: allocateFrameId,
        callSite: node,
        callReadAt: current.readAt ?? node,
        parentFrame: current.callFrame,
        callables: returned.callables,
        parameterSources,
        inactiveDefaultNodes,
        receiverCallables: nonArrowReceiverCallables(returned.callables),
        receiverSources,
        hasOpaqueArguments,
      });
    for (const ref of returned.references) {
      const isGeneratorResult =
        ref.resultKind === "iterator" || ref.resultKind === "async-iterator";
      if (isIterated && isGeneratorResult && ref.kind !== "yield") continue;
      const refResultSuffix =
        isIteratedElement && isGeneratorResult && current.suffix.length > 0
          ? current.suffix.slice(1)
          : current.suffix;
      const fullSuffix = [...ref.projection, ...refResultSuffix];
      const delegatedYield =
        isIterated &&
        isGeneratorResult &&
        ref.kind === "yield" &&
        ref.projection.length === 1 &&
        ref.projection[0] === null;
      const refCaptures =
        !isGeneratorResult &&
        ref.resultKind !== "promise" &&
        ref.projection.length > 0
          ? buildPrefixCaptures(node, ref.projection.length)
          : undefined;
      pending.push({
        node: ref.node,
        suffix: fullSuffix,
        readAt: current.readAt ?? node,
        capturedSelections: [
          ...(semanticShiftCapturedSelections(
            capturedSelections,
            ref.projection.length,
          ) ?? []),
          ...(refCaptures ?? []),
        ],
        descriptorReads: current.descriptorReads,
        awaitDepths: current.awaitDepths,
        iteratedDepths: delegatedYield
          ? [
              ...new Set([
                ...(current.iteratedDepths ?? []),
                fullSuffix.length,
              ]),
            ].sort((left, right) => left - right)
          : current.iteratedDepths,
        iteratedElementDepths: delegatedYield
          ? [
              ...new Set([
                ...(current.iteratedElementDepths ?? []),
                fullSuffix.length,
              ]),
            ].sort((left, right) => left - right)
          : current.iteratedElementDepths,
        callFrame: nextCallFrame,
      });
    }
    if (
      callFrameOverflow ||
      hasOpaqueArguments ||
      returned.unresolvedCallable ||
      returned.unresolvedInvocation ||
      (returned.callables.size === 0 && returned.references.length === 0)
    )
      enqueueOpaqueInvocationArguments(rawArguments ?? [], current, pending);
  } else if (t.isNewExpression(node)) {
    enqueueOpaqueInvocationArguments(node.arguments, current, pending);
  } else if (t.isAwaitExpression(node)) {
    pending.push({
      ...current,
      node: node.argument,
      capturedSelections,
      awaitDepths: [
        ...new Set([...(current.awaitDepths ?? []), current.suffix.length]),
      ].sort((left, right) => left - right),
    });
  } else if (t.isYieldExpression(node) && node.argument != null) {
    pending.push({ ...current, node: node.argument, capturedSelections });
  } else if (t.isConditionalExpression(node) || t.isLogicalExpression(node)) {
    for (const branch of evaluateSemanticSelectedBranches(node, state))
      pending.push({ ...current, node: branch, capturedSelections });
  } else if (t.isSequenceExpression(node)) {
    const last = node.expressions.at(-1);
    if (last !== undefined)
      pending.push({ ...current, node: last, capturedSelections });
  } else if (t.isAssignmentExpression(node)) {
    for (const source of assignmentValueSources(node))
      pending.push({ ...current, node: source, capturedSelections });
  } else if (
    (t.isObjectExpression(node) || t.isArrayExpression(node)) &&
    current.suffix.length > 0
  ) {
    const [key, ...remaining] = current.suffix;
    const activeDescriptor = descriptorReadAtDepth(
      current.descriptorReads,
      current.suffix.length,
    );
    const nextDescriptorReads = withoutDescriptorReadAtDepth(
      current.descriptorReads,
      current.suffix.length,
    );
    const filteredAwaitDepths = current.awaitDepths?.filter(
      (depth) => depth !== current.suffix.length,
    );
    for (const choice of semanticAliasSelectionChoices(key!)) {
      const sources = t.isObjectExpression(node)
        ? activeDescriptor === undefined
          ? semanticObjectPropertyReferences(node, [choice], state)
          : activeDescriptor.kind === "value"
            ? semanticObjectOwnDataPropertyReferences(node, [choice], state)
            : semanticObjectAccessorReferences(
                node,
                choice,
                state,
                activeDescriptor.kind,
                "own",
              )
        : activeDescriptor?.kind === "get" || activeDescriptor?.kind === "set"
          ? []
          : semanticArrayPropertyReferences(node, [choice]);
      for (const source of sources) {
        if (
          source.inherited &&
          (activeDescriptor !== undefined ||
            capturedSelections?.some(
              (capture) => capture.depth === 1 && capture.ownEnumerable,
            ))
        )
          continue;
        const nextSuffix = [...source.path, ...remaining];
        const isSpreadSource = source.iterableFallbackPath !== undefined;
        pending.push({
          node: source.node,
          suffix: nextSuffix,
          readAt: current.readAt,
          capturedSelections: semanticCapturedSelectionsAfterPropertyRead(
            capturedSelections,
            source,
          ),
          descriptorReads: nextDescriptorReads,
          iteratedDepths: isSpreadSource
            ? [
                ...new Set([
                  ...(current.iteratedDepths ?? []),
                  nextSuffix.length,
                ]),
              ].sort((left, right) => left - right)
            : current.iteratedDepths,
          iteratedElementDepths: isSpreadSource
            ? [
                ...new Set([
                  ...(current.iteratedElementDepths ?? []),
                  nextSuffix.length,
                ]),
              ].sort((left, right) => left - right)
            : current.iteratedElementDepths,
          callFrame: current.callFrame,
          ...(filteredAwaitDepths === undefined ||
          filteredAwaitDepths.length === 0
            ? {}
            : { awaitDepths: filteredAwaitDepths }),
        });
      }
    }
  }
};

const parseDescriptorReaderMemberCall = (
  descCall: t.CallExpression | t.OptionalCallExpression,
  inv: JavaScriptIntrinsicInvocation,
  members: readonly (string | null)[],
  ctx: {
    readonly callFrame: ElectronMemberWriteCallFrame | undefined;
    readonly interop: ReturnType<typeof createSemanticModuleInterop>;
    readonly state: JavaScriptSemanticAnalysisState;
  },
):
  | {
      readonly targetArg: t.Expression;
      readonly keySeg: string | null;
      readonly descField: "value" | "get" | "set";
    }
  | undefined => {
  const [, obj, method] = inv.path;
  let targetArg:
    | t.Expression
    | t.SpreadElement
    | t.ArgumentPlaceholder
    | undefined;
  let keySeg: string | null = null;
  let descField: string | null = null;
  if (
    (obj === "Object" || obj === "Reflect") &&
    method === "getOwnPropertyDescriptor" &&
    members.length === 1
  ) {
    targetArg = inv.arguments?.[0];
    const keyArg = inv.arguments?.[1];
    if (keyArg !== undefined && t.isSpreadElement(keyArg)) return undefined;
    keySeg = resolveDescriptorPropertyKeySegment(keyArg, {
      callNode: descCall,
      current: { callFrame: ctx.callFrame },
      state: ctx.state,
      interop: ctx.interop,
    });
    descField = members[0] ?? null;
  } else if (
    obj === "Object" &&
    method === "getOwnPropertyDescriptors" &&
    members.length === 2
  ) {
    targetArg = inv.arguments?.[0];
    keySeg = members[0] ?? null;
    descField = members[1] ?? null;
  }
  if (
    targetArg === undefined ||
    !t.isExpression(targetArg) ||
    (descField !== "value" && descField !== "get" && descField !== "set")
  )
    return undefined;
  return { targetArg, keySeg, descField };
};

const resolveDescriptorReaderCallableTargets = (input: {
  readonly calleeNode: t.Node;
  readonly callSite: t.Node;
  readonly callFrame: ElectronMemberWriteCallFrame | undefined;
  readonly queryFn: ElectronMemberWriteReturnQueries["direct"];
  readonly interop: ReturnType<typeof createSemanticModuleInterop>;
  readonly state: JavaScriptSemanticAnalysisState;
}): SemanticReturnedReferenceResult | undefined => {
  const { calleeNode, callSite, callFrame, queryFn, interop, state } = input;
  const { root, members } = electronMemberPath(calleeNode);
  if (members.length !== 1 && members.length !== 2) return undefined;
  const resolvedRoot = t.isExpression(root)
    ? (resolveSingleExpressionInCallFrame(root, callSite, callFrame, state)
        ?.node ?? root)
    : root;
  const descCall = unwrapJavaScriptExpression(resolvedRoot).node;
  if (!t.isCallExpression(descCall) && !t.isOptionalCallExpression(descCall))
    return undefined;
  const inv = interop.intrinsicInvocation(descCall);
  if (inv?.kind !== "known" || inv.path.length !== 3) return undefined;
  const parsed = parseDescriptorReaderMemberCall(descCall, inv, members, {
    callFrame,
    interop,
    state,
  });
  if (parsed === undefined) return undefined;
  const { targetArg, keySeg, descField } = parsed;
  const resolvedTarget = resolveSingleExpressionInCallFrame(
    targetArg,
    descCall,
    callFrame,
    state,
  );
  const targetObj = resolveUnmutatedObjectExpression(
    resolvedTarget?.node ?? targetArg,
    state,
    resolvedTarget?.captureAt ?? descCall,
  );
  if (targetObj === undefined) return undefined;
  const sources =
    descField === "value"
      ? semanticObjectOwnDataPropertyReferences(targetObj, [keySeg], state)
      : semanticObjectAccessorReferences(
          targetObj,
          keySeg,
          state,
          descField,
          "own",
        );
  if (sources.length === 0) return undefined;
  const callables = new Set<t.Function>();
  const references: SemanticReturnedReferenceResult["references"][number][] =
    [];
  let unresolvedCallable = false;
  let unresolvedInvocation = false;
  for (const source of sources) {
    if (source.path.length > 0) {
      unresolvedCallable = true;
      continue;
    }
    const sub = queryFn(
      source.node,
      t.isCallExpression(callSite) || t.isOptionalCallExpression(callSite)
        ? callSite
        : undefined,
      callFrame,
    );
    for (const fn of sub.callables) callables.add(fn);
    for (const ref of sub.references) references.push(ref);
    if (sub.unresolvedCallable) unresolvedCallable = true;
    if (sub.unresolvedInvocation) unresolvedInvocation = true;
  }
  return {
    callables,
    references,
    ...(unresolvedCallable ? { unresolvedCallable: true } : {}),
    ...(unresolvedInvocation ? { unresolvedInvocation: true } : {}),
    precision: "exact",
  };
};

const hasAmbientObjectPrototypeMutation = (
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (
    state.prototypeEnumerationMayAffect ||
    state.prototypeMutationSites.some((site) => site.owner === "Object")
  )
    return true;
  const target = ["global", "Object", "prototype"];
  return state.ambientWriteEffects.some(
    (effect) =>
      effect.path.length >= 2 &&
      effect.path.length <= 4 &&
      effect.path
        .slice(0, Math.min(effect.path.length, 3))
        .every(
          (seg, idx) =>
            seg === null ||
            semanticPropertyPathKeyMatches(seg, target[idx] ?? ""),
        ),
  );
};

const resolveUnmutatedObjectExpression = (
  expr: t.Node,
  state: JavaScriptSemanticAnalysisState,
  captureAt: t.Node = expr,
  visited: ReadonlySet<t.Node> = new Set(),
): t.ObjectExpression | undefined => {
  const unfrozen = unwrapUnmodifiedObjectFreezeArgument(expr, state) ?? expr;
  const node = unwrapJavaScriptExpression(unfrozen).node;
  if (visited.has(node)) return undefined;
  if (t.isObjectExpression(node)) return node;
  if (
    t.isIdentifier(node) &&
    !semanticResolutionBlocked(state, node, node.name)
  ) {
    const binding = resolveSemanticBindingState(state, node, node.name);
    if (
      binding !== undefined &&
      !binding.mutable &&
      !semanticBindingCanBeRebound(binding) &&
      binding.initializers.length === 1 &&
      binding.referenceInitializers.length === 0 &&
      binding.initializers[0]?.projection.length === 0 &&
      semanticBindingAtRead(binding, node, state).hasDefiniteInitializer &&
      !hasBindingObjectEffectsBeforeSite(binding, captureAt, state)
    ) {
      const nextVisited = new Set(visited);
      nextVisited.add(node);
      return resolveUnmutatedObjectExpression(
        binding.initializers[0].node,
        state,
        captureAt,
        nextVisited,
      );
    }
  }
  return undefined;
};

const resolveUnmutatedArrayExpression = (
  expr: t.Node,
  state: JavaScriptSemanticAnalysisState,
  captureAt: t.Node = expr,
  visited: ReadonlySet<t.Node> = new Set(),
): t.ArrayExpression | undefined => {
  const unfrozen = unwrapUnmodifiedObjectFreezeArgument(expr, state) ?? expr;
  const node = unwrapJavaScriptExpression(unfrozen).node;
  if (visited.has(node)) return undefined;
  if (t.isArrayExpression(node)) return node;
  if (
    t.isIdentifier(node) &&
    !semanticResolutionBlocked(state, node, node.name)
  ) {
    const binding = resolveSemanticBindingState(state, node, node.name);
    if (
      binding !== undefined &&
      !binding.mutable &&
      !semanticBindingCanBeRebound(binding) &&
      binding.initializers.length === 1 &&
      binding.referenceInitializers.length === 0 &&
      binding.initializers[0]?.projection.length === 0 &&
      semanticBindingAtRead(binding, node, state).hasDefiniteInitializer &&
      !hasBindingObjectEffectsBeforeSite(binding, captureAt, state)
    ) {
      const nextVisited = new Set(visited);
      nextVisited.add(node);
      return resolveUnmutatedArrayExpression(
        binding.initializers[0].node,
        state,
        captureAt,
        nextVisited,
      );
    }
  }
  return undefined;
};

const staticObjectValuesKeys = (
  expr: t.Node,
  state: JavaScriptSemanticAnalysisState,
  captureAt: t.Node = expr,
): readonly string[] | undefined => {
  const obj = resolveUnmutatedObjectExpression(expr, state, captureAt);
  if (obj === undefined) return undefined;
  const seen = new Set<string>();
  const arrayIndexKeys: { readonly index: number; readonly key: string }[] = [];
  const stringKeys: string[] = [];
  for (const prop of obj.properties) {
    if (t.isSpreadElement(prop)) return undefined;
    if (t.isObjectMethod(prop) && (prop.kind === "get" || prop.kind === "set"))
      return undefined;
    if (prop.computed && semanticKnownSymbolKey(prop.key, state)) continue;
    const name = semanticStaticPropertyKey(prop.key, prop.computed);
    if (name === null) return undefined;
    if (isObjectPrototypeSetter(prop, name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const idx = semanticArrayIndex(name);
    if (idx !== null) arrayIndexKeys.push({ index: idx, key: name });
    else stringKeys.push(name);
  }
  arrayIndexKeys.sort((left, right) => left.index - right.index);
  return [...arrayIndexKeys.map((entry) => entry.key), ...stringKeys];
};

const denseKnownArrayLengthAt = (
  expr: t.Node,
  state: JavaScriptSemanticAnalysisState,
  readAt: t.Node,
): number | undefined => {
  if (state.arrayIterationUnknown) return undefined;
  const evaluated = evaluateSemanticExpression(expr, state, readAt);
  if (
    evaluated.status !== "array" ||
    evaluated.unknownItems ||
    !evaluated.items.every(
      (item, idx) => item.name === String(idx) && item.presence === "present",
    )
  )
    return undefined;
  return evaluated.items.length;
};

const objectLiteralHasNoOwnIterator = (
  obj: t.ObjectExpression,
  state: JavaScriptSemanticAnalysisState,
  captureAt: t.Node,
  visited: ReadonlySet<t.Node>,
): boolean => {
  const nextVisited = new Set(visited);
  nextVisited.add(obj);
  for (const prop of obj.properties) {
    if (t.isSpreadElement(prop)) {
      const spreadObj = resolveUnmutatedObjectExpression(
        prop.argument,
        state,
        captureAt,
      );
      if (
        spreadObj === undefined ||
        nextVisited.has(spreadObj) ||
        spreadObj.properties.some(
          (inner) =>
            t.isObjectMethod(inner) &&
            (inner.kind === "get" || inner.kind === "set"),
        ) ||
        !objectLiteralHasNoOwnIterator(spreadObj, state, captureAt, nextVisited)
      )
        return false;
      continue;
    }
    if (!prop.computed) continue;
    if (semanticKnownSymbolKey(prop.key, state)) {
      const symExpr = unwrapJavaScriptExpression(prop.key).node;
      if (
        !t.isMemberExpression(symExpr) ||
        semanticStaticPropertyKey(symExpr.property, symExpr.computed) ===
          "iterator"
      )
        return false;
      continue;
    }
    if (semanticStaticPropertyKey(prop.key, true) === null) return false;
  }
  return true;
};

const toKnownArrayLikeLength = (
  valueNode: t.Node,
  state: JavaScriptSemanticAnalysisState,
): number | undefined => {
  if (isDefinitelyUndefinedExpression(valueNode, state)) return 0;
  const literal = readExactJavaScriptLiteral(valueNode);
  if (!literal.found) return undefined;
  if (literal.value === null) return 0;
  if (typeof literal.value === "boolean") return literal.value ? 1 : 0;
  if (typeof literal.value === "number") {
    if (!Number.isFinite(literal.value) || Number.isNaN(literal.value))
      return literal.value === Number.POSITIVE_INFINITY
        ? Number.MAX_SAFE_INTEGER
        : 0;
    return literal.value <= 0
      ? 0
      : Math.min(Math.trunc(literal.value), Number.MAX_SAFE_INTEGER);
  }
  if (typeof literal.value === "string") {
    const num = Number(literal.value);
    if (!Number.isFinite(num) || Number.isNaN(num))
      return num === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : 0;
    return num <= 0 ? 0 : Math.min(Math.trunc(num), Number.MAX_SAFE_INTEGER);
  }
  return undefined;
};

const nonIterableArrayLikeFacts = (
  expr: t.Node,
  state: JavaScriptSemanticAnalysisState,
  captureAt: t.Node = expr,
): { readonly knownLength?: number } | undefined => {
  const obj = resolveUnmutatedObjectExpression(expr, state, captureAt);
  if (
    obj === undefined ||
    !objectLiteralHasNoOwnIterator(obj, state, captureAt, new Set())
  )
    return undefined;
  const protoSetters = obj.properties.filter(
    (prop): prop is t.ObjectProperty =>
      !t.isSpreadElement(prop) &&
      t.isObjectProperty(prop) &&
      isObjectPrototypeSetter(
        prop,
        semanticStaticPropertyKey(prop.key, prop.computed),
      ),
  );
  if (protoSetters.length > 0) {
    if (
      !protoSetters.every((setter) =>
        t.isNullLiteral(unwrapJavaScriptExpression(setter.value).node),
      )
    )
      return undefined;
  } else if (
    state.arrayIterationUnknown ||
    hasAmbientObjectPrototypeMutation(state)
  ) {
    return undefined;
  }
  if (
    obj.properties.some(
      (prop) =>
        t.isSpreadElement(prop) ||
        (t.isObjectMethod(prop) &&
          (prop.kind === "get" || prop.kind === "set")),
    )
  )
    return {};
  let lengthProp: t.ObjectProperty | t.ObjectMethod | undefined;
  for (const prop of obj.properties) {
    if (t.isSpreadElement(prop)) continue;
    const key = semanticStaticPropertyKey(prop.key, prop.computed);
    if (key === "length" && !isObjectPrototypeSetter(prop, key))
      lengthProp = prop;
  }
  if (lengthProp === undefined) return { knownLength: 0 };
  if (!t.isObjectProperty(lengthProp)) return {};
  const knownLength = toKnownArrayLikeLength(lengthProp.value, state);
  return knownLength === undefined ? {} : { knownLength };
};

const selectArrayFromInputSegments = (
  segment: JavaScriptSemanticPropertyPath[number],
  knownLength: number | undefined,
  aliasSelectionLimit: number = JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS.alias_selections,
): readonly JavaScriptSemanticPropertyPath[number][] => {
  if (knownLength !== undefined && knownLength <= 0) return [];
  if (segment === null) {
    if (knownLength !== undefined && knownLength <= aliasSelectionLimit) {
      const indices: number[] = [];
      for (let idx = 0; idx < knownLength; idx += 1) indices.push(idx);
      return indices;
    }
    return [{ excludedKeys: [], startIndex: 0 }];
  }
  if (typeof segment === "object") {
    const startIndex = segment.startIndex ?? 0;
    if (knownLength !== undefined && startIndex >= knownLength) return [];
    if (knownLength !== undefined && knownLength <= aliasSelectionLimit) {
      const indices: number[] = [];
      for (let idx = startIndex; idx < knownLength; idx += 1) {
        if (!segment.excludedKeys.includes(String(idx))) indices.push(idx);
      }
      return indices;
    }
    return [{ excludedKeys: segment.excludedKeys, startIndex }];
  }
  const idx = semanticArrayIndex(segment);
  if (idx === null) return [];
  if (knownLength !== undefined && idx >= knownLength) return [];
  return [idx];
};

const objectAssignTargetAllowsOverwrite = (
  expr: t.Node,
  choice: JavaScriptSemanticPropertyPath[number],
  state: JavaScriptSemanticAnalysisState,
  interop: ReturnType<typeof createSemanticModuleInterop>,
  captureAt: t.Node = expr,
  visited: ReadonlySet<t.Node> = new Set(),
): boolean => {
  const node = unwrapJavaScriptExpression(expr).node;
  if (visited.has(node)) return false;
  const nextVisited = new Set(visited);
  nextVisited.add(node);
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    const inv = interop.intrinsicInvocation(node);
    if (inv?.kind === "known") {
      if (inv.path.join(".") === "intrinsic.Object.create") {
        const args = inv.arguments ?? [];
        if (
          args.length === 1 &&
          args[0] !== undefined &&
          t.isNullLiteral(unwrapJavaScriptExpression(args[0]).node)
        )
          return true;
      }
      if (inv.path.join(".") === "intrinsic.Object.assign") {
        const [innerTarget] = inv.arguments ?? [];
        return (
          innerTarget !== undefined &&
          t.isExpression(innerTarget) &&
          objectAssignTargetAllowsOverwrite(
            innerTarget,
            choice,
            state,
            interop,
            node,
            nextVisited,
          )
        );
      }
    }
    return false;
  }
  if (t.isObjectExpression(node)) {
    let hasNullPrototype = false;
    for (const prop of node.properties) {
      if (t.isSpreadElement(prop)) continue;
      const name = semanticStaticPropertyKey(prop.key, prop.computed);
      if (isObjectPrototypeSetter(prop, name)) {
        if (
          t.isObjectProperty(prop) &&
          t.isNullLiteral(unwrapJavaScriptExpression(prop.value).node)
        ) {
          hasNullPrototype = true;
          continue;
        }
        return false;
      }
      if (
        t.isObjectMethod(prop) &&
        (prop.kind === "get" || prop.kind === "set")
      )
        return false;
    }
    return hasNullPrototype || !hasAmbientObjectPrototypeMutation(state);
  }
  if (hasAmbientObjectPrototypeMutation(state)) return false;
  if (t.isConditionalExpression(node) || t.isLogicalExpression(node)) {
    const branches = evaluateSemanticSelectedBranches(node, state);
    return (
      branches.length > 0 &&
      branches.every((branch) =>
        objectAssignTargetAllowsOverwrite(
          branch,
          choice,
          state,
          interop,
          captureAt,
          nextVisited,
        ),
      )
    );
  }
  if (t.isSequenceExpression(node)) {
    const last = node.expressions.at(-1);
    return (
      last !== undefined &&
      objectAssignTargetAllowsOverwrite(
        last,
        choice,
        state,
        interop,
        captureAt,
        nextVisited,
      )
    );
  }
  if (
    t.isIdentifier(node) &&
    !semanticResolutionBlocked(state, node, node.name)
  ) {
    const binding = resolveSemanticBindingState(state, node, node.name);
    if (
      binding !== undefined &&
      !binding.mutable &&
      !semanticBindingCanBeRebound(binding) &&
      binding.initializers.length === 1 &&
      binding.referenceInitializers.length === 0 &&
      binding.initializers[0]?.projection.length === 0 &&
      semanticBindingAtRead(binding, node, state).hasDefiniteInitializer &&
      !hasBindingObjectEffectsBeforeSite(binding, captureAt, state, {
        allowPlainDataMemberWrites: true,
      })
    ) {
      return objectAssignTargetAllowsOverwrite(
        binding.initializers[0].node,
        choice,
        state,
        interop,
        captureAt,
        nextVisited,
      );
    }
  }
  return false;
};

const definiteObjectAssignSourceKeys = (
  expr: t.Node,
  state: JavaScriptSemanticAnalysisState,
  interop: ReturnType<typeof createSemanticModuleInterop>,
  captureAt: t.Node = expr,
  visited: ReadonlySet<t.Node> = new Set(),
): ReadonlySet<string> => {
  const unfrozen = unwrapUnmodifiedObjectFreezeArgument(expr, state) ?? expr;
  const node = unwrapJavaScriptExpression(unfrozen).node;
  if (visited.has(node)) return new Set();
  const nextVisited = new Set(visited);
  nextVisited.add(node);
  if (t.isObjectExpression(node)) {
    if (
      node.properties.some(
        (prop) =>
          t.isObjectMethod(prop) &&
          (prop.kind === "get" || prop.kind === "set"),
      )
    )
      return new Set();
    const keys = new Set<string>();
    for (const prop of node.properties) {
      if (t.isSpreadElement(prop)) {
        for (const spreadKey of definiteObjectAssignSourceKeys(
          prop.argument,
          state,
          interop,
          captureAt,
          nextVisited,
        ))
          keys.add(spreadKey);
        continue;
      }
      const name = semanticStaticPropertyKey(prop.key, prop.computed);
      if (name !== null && !isObjectPrototypeSetter(prop, name)) keys.add(name);
    }
    return keys;
  }
  if (t.isConditionalExpression(node) || t.isLogicalExpression(node)) {
    const branches = evaluateSemanticSelectedBranches(node, state);
    if (branches.length === 0) return new Set();
    let intersection: Set<string> | undefined;
    for (const branch of branches) {
      const branchKeys = definiteObjectAssignSourceKeys(
        branch,
        state,
        interop,
        captureAt,
        nextVisited,
      );
      intersection =
        intersection === undefined
          ? new Set(branchKeys)
          : new Set([...intersection].filter((k) => branchKeys.has(k)));
    }
    return intersection ?? new Set();
  }
  if (t.isSequenceExpression(node)) {
    const last = node.expressions.at(-1);
    return last === undefined
      ? new Set()
      : definiteObjectAssignSourceKeys(
          last,
          state,
          interop,
          captureAt,
          nextVisited,
        );
  }
  if (
    t.isIdentifier(node) &&
    !semanticResolutionBlocked(state, node, node.name)
  ) {
    const binding = resolveSemanticBindingState(state, node, node.name);
    if (
      binding !== undefined &&
      !binding.mutable &&
      !semanticBindingCanBeRebound(binding) &&
      binding.initializers.length === 1 &&
      binding.referenceInitializers.length === 0 &&
      binding.initializers[0]?.projection.length === 0 &&
      semanticBindingAtRead(binding, node, state).hasDefiniteInitializer &&
      !hasBindingObjectEffectsBeforeSite(binding, captureAt, state)
    )
      return definiteObjectAssignSourceKeys(
        binding.initializers[0].node,
        state,
        interop,
        captureAt,
        nextVisited,
      );
  }
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    const inv = interop.intrinsicInvocation(node);
    if (
      inv?.kind === "known" &&
      inv.path.join(".") === "intrinsic.Object.assign"
    ) {
      const args = inv.arguments ?? [];
      if (args.length === 0) return new Set();
      const [innerTarget, ...innerSources] = args;
      if (innerTarget === undefined || t.isSpreadElement(innerTarget))
        return new Set();
      if (
        innerSources.length > 0 &&
        !objectAssignTargetAllowsOverwrite(
          innerTarget,
          null,
          state,
          interop,
          node,
          nextVisited,
        )
      )
        return new Set();
      const keys = new Set<string>(
        definiteObjectAssignSourceKeys(
          innerTarget,
          state,
          interop,
          node,
          nextVisited,
        ),
      );
      if (
        objectAssignTargetAllowsOverwrite(
          innerTarget,
          null,
          state,
          interop,
          node,
          nextVisited,
        )
      ) {
        for (const innerSrc of innerSources)
          if (t.isExpression(innerSrc))
            for (const srcKey of definiteObjectAssignSourceKeys(
              innerSrc,
              state,
              interop,
              node,
              nextVisited,
            ))
              keys.add(srcKey);
      }
      return keys;
    }
  }
  return new Set();
};

const inactiveDefaultNodesForBinding = (
  bindingId: string,
  callFrame: ElectronMemberWriteCallFrame | undefined,
): ReadonlySet<t.Node> | undefined => {
  for (let frame = callFrame; frame !== undefined; frame = frame.parentFrame) {
    if (frame.parameterSources.has(bindingId))
      return frame.inactiveDefaultNodes;
  }
  return undefined;
};

const enqueueFallbackBindingMemberWriteSources = (
  binding: JavaScriptSemanticBindingState,
  snapshot: JavaScriptSemanticBindingState,
  node: t.Identifier,
  current: ElectronMemberWriteCandidate,
  inactiveDefaults: ReadonlySet<t.Node> | undefined,
  state: JavaScriptSemanticAnalysisState,
  pending: ElectronMemberWriteCandidate[],
): void => {
  const activeDescriptor = descriptorReadAtDepth(
    current.descriptorReads,
    current.suffix.length,
  );
  const strippedReads = withoutDescriptorReadAtDepth(
    current.descriptorReads,
    current.suffix.length,
  );
  for (const source of snapshot.initializers) {
    if (inactiveDefaults?.has(source.node)) continue;
    if (semanticReferenceSourcesInactive(source, state)) continue;
    pending.push({
      node: source.node,
      suffix: [...source.projection, ...current.suffix],
      readAt: current.readAt ?? node,
      descriptorReads: current.descriptorReads,
      awaitDepths: current.awaitDepths,
      iteratedDepths: current.iteratedDepths,
      iteratedElementDepths: current.iteratedElementDepths,
      callFrame: current.callFrame,
    });
  }
  if (activeDescriptor?.kind === "get" || activeDescriptor?.kind === "set")
    return;
  const [key, ...remaining] = current.suffix;
  for (const source of snapshot.referenceInitializers) {
    if (inactiveDefaults?.has(source.node)) continue;
    if (semanticReferenceSourcesInactive(source, state)) continue;
    for (const choice of key === undefined
      ? [undefined]
      : semanticAliasSelectionChoices(key)) {
      const copied = semanticCopiedReferencePath(
        source,
        choice === undefined ? [] : [choice],
        "identity",
      );
      if (copied !== null)
        pending.push({
          node: source.node,
          suffix: [...copied, ...remaining],
          readAt: current.readAt ?? node,
          descriptorReads: strippedReads,
          awaitDepths: current.awaitDepths,
          iteratedDepths: current.iteratedDepths,
          iteratedElementDepths: current.iteratedElementDepths,
          callFrame: current.callFrame,
        });
    }
  }
  for (const effect of binding.memberWrites)
    for (const source of effect.assignedSources ?? []) {
      if (semanticReferenceSourcesInactive(source, state)) continue;
      pending.push({
        node: source.node,
        suffix: [],
        readAt: current.readAt ?? node,
        callFrame: current.callFrame,
      });
    }
};

const enqueueCallFrameParameterMatches = (
  binding: JavaScriptSemanticBindingState,
  hasDefiniteInitializer: boolean,
  retainsOrigin: boolean,
  current: ElectronMemberWriteCandidate,
  capturedSelections: readonly SemanticCapturedSelection[] | undefined,
  enqueue: (candidate: ElectronMemberWriteCandidate) => void,
): void => {
  if (hasDefiniteInitializer || !retainsOrigin) return;
  const activeDescriptor = descriptorReadAtDepth(
    current.descriptorReads,
    current.suffix.length,
  );
  const strippedReads = withoutDescriptorReadAtDepth(
    current.descriptorReads,
    current.suffix.length,
  );
  for (
    let frame = current.callFrame;
    frame !== undefined;
    frame = frame.parentFrame
  ) {
    const mappedArgs = frame.parameterSources.get(binding.bindingId);
    if (mappedArgs === undefined) continue;
    for (const argSource of mappedArgs) {
      if (
        argSource.copyProjectionOffset !== undefined &&
        (activeDescriptor?.kind === "get" || activeDescriptor?.kind === "set")
      )
        continue;
      const nextDescriptorReads =
        argSource.copyProjectionOffset !== undefined
          ? strippedReads
          : current.descriptorReads;
      const unwrappedArg = unwrapJavaScriptExpression(argSource.node).node;
      const memberArg =
        t.isMemberExpression(unwrappedArg) ||
        t.isOptionalMemberExpression(unwrappedArg)
          ? electronMemberPath(unwrappedArg)
          : undefined;
      const argRoot = memberArg === undefined ? argSource.node : memberArg.root;
      const argMembers = memberArg === undefined ? [] : memberArg.members;
      const argMemberCaptures: SemanticCapturedSelection[] = [];
      for (let idx = 0; idx < argMembers.length; idx += 1)
        argMemberCaptures.push({ at: argSource.node, depth: idx + 1 });
      const shiftedArgCaptures = semanticShiftCapturedSelections(
        argSource.capturedSelections,
        argMembers.length,
      );
      for (const selectedSuffix of selectMappedParameterSuffixes(
        argSource,
        current.suffix,
      )) {
        const nextSuffix = [...argMembers, ...selectedSuffix];
        enqueue({
          node: argRoot,
          suffix: nextSuffix,
          readAt: frame.callReadAt,
          capturedSelections: [
            ...(semanticShiftCapturedSelections(
              capturedSelections,
              nextSuffix.length - current.suffix.length,
            ) ?? []),
            ...argMemberCaptures,
            ...(shiftedArgCaptures ?? []),
          ],
          descriptorReads: nextDescriptorReads,
          awaitDepths: current.awaitDepths,
          iteratedDepths: current.iteratedDepths,
          iteratedElementDepths: current.iteratedElementDepths,
          callFrame: frame.parentFrame,
        });
      }
    }
    break;
  }
};

const enqueueBindingDescriptorReadSources = (input: {
  readonly activeDescriptor: SemanticDescriptorRead;
  readonly binding: JavaScriptSemanticBindingState;
  readonly bindingRead: ReturnType<typeof semanticBindingAtRead>;
  readonly node: t.Identifier;
  readonly current: ElectronMemberWriteCandidate;
  readonly capturedSelections: readonly SemanticCapturedSelection[] | undefined;
  readonly inactiveDefaults: ReadonlySet<t.Node> | undefined;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly enqueue: (candidate: ElectronMemberWriteCandidate) => void;
}): void => {
  const {
    activeDescriptor,
    binding,
    bindingRead,
    node,
    current,
    capturedSelections,
    inactiveDefaults,
    state,
    enqueue,
  } = input;
  const snapshot = bindingRead.binding;
  if (activeDescriptor.kind === "get" || activeDescriptor.kind === "set") {
    enqueueCallFrameParameterMatches(
      binding,
      bindingRead.hasDefiniteInitializer,
      true,
      current,
      capturedSelections,
      enqueue,
    );
    for (const source of snapshot.initializers) {
      if (inactiveDefaults?.has(source.node)) continue;
      if (semanticReferenceSourcesInactive(source, state)) continue;
      enqueue({
        node: source.node,
        suffix: [...source.projection, ...current.suffix],
        readAt: current.readAt ?? node,
        capturedSelections: semanticShiftCapturedSelections(
          capturedSelections,
          source.projection.length,
        ),
        descriptorReads: current.descriptorReads,
        awaitDepths: current.awaitDepths,
        iteratedDepths: current.iteratedDepths,
        iteratedElementDepths: current.iteratedElementDepths,
        callFrame: current.callFrame,
      });
    }
    return;
  }
  const strippedReads = withoutDescriptorReadAtDepth(
    current.descriptorReads,
    current.suffix.length,
  );
  const projectedFacts = semanticProjectedSourceFactsAtRead(
    binding,
    node,
    current.suffix,
    state,
    false,
    current.readAt ?? node,
    capturedSelections,
  );
  enqueueCallFrameParameterMatches(
    binding,
    bindingRead.hasDefiniteInitializer,
    projectedFacts === undefined || projectedFacts.retainsOrigin,
    current,
    capturedSelections,
    enqueue,
  );
  if (projectedFacts === undefined) {
    const fallbackPending: ElectronMemberWriteCandidate[] = [];
    enqueueFallbackBindingMemberWriteSources(
      binding,
      snapshot,
      node,
      current,
      inactiveDefaults,
      state,
      fallbackPending,
    );
    for (const candidate of fallbackPending) enqueue(candidate);
    return;
  }
  for (const source of projectedFacts.storedSources) {
    if (inactiveDefaults?.has(source.node)) continue;
    enqueue({
      node: source.node,
      suffix: source.path,
      readAt:
        current.suffix.length === 0 ? undefined : (current.readAt ?? node),
      capturedSelections: [
        ...(semanticShiftCapturedSelections(
          capturedSelections,
          source.path.length - current.suffix.length,
        ) ?? []),
        ...(source.capturedSelections ?? []),
      ],
      descriptorReads: strippedReads,
      awaitDepths: current.awaitDepths,
      iteratedDepths: current.iteratedDepths,
      iteratedElementDepths: current.iteratedElementDepths,
      callFrame: current.callFrame,
    });
  }
  if (!projectedFacts.retainsOrigin) return;
  for (const source of snapshot.initializers) {
    if (inactiveDefaults?.has(source.node)) continue;
    if (semanticReferenceSourcesInactive(source, state)) continue;
    enqueue({
      node: source.node,
      suffix: [...source.projection, ...current.suffix],
      readAt: current.readAt ?? node,
      capturedSelections: semanticShiftCapturedSelections(
        capturedSelections,
        source.projection.length,
      ),
      descriptorReads: current.descriptorReads,
      awaitDepths: current.awaitDepths,
      iteratedDepths: current.iteratedDepths,
      iteratedElementDepths: current.iteratedElementDepths,
      callFrame: current.callFrame,
    });
  }
  const [key, ...remaining] = current.suffix;
  for (const source of snapshot.referenceInitializers) {
    if (inactiveDefaults?.has(source.node)) continue;
    if (semanticReferenceSourcesInactive(source, state)) continue;
    for (const choice of key === undefined
      ? [undefined]
      : semanticAliasSelectionChoices(key)) {
      const copied = semanticCopiedReferencePath(
        source,
        choice === undefined ? [] : [choice],
        "identity",
      );
      if (copied !== null)
        enqueue({
          node: source.node,
          suffix: [...copied, ...remaining],
          readAt: current.readAt ?? node,
          capturedSelections: [
            ...(semanticShiftCapturedSelections(
              capturedSelections,
              copied.length + remaining.length - current.suffix.length,
            ) ?? []),
            {
              at: source.node,
              depth: copied.length,
              ...(source.copyKind === "object-rest"
                ? { ownEnumerable: true as const }
                : {}),
            },
          ],
          descriptorReads: strippedReads,
          awaitDepths: current.awaitDepths,
          iteratedDepths: current.iteratedDepths,
          iteratedElementDepths: current.iteratedElementDepths,
          callFrame: current.callFrame,
        });
    }
  }
};

const isSeparateTerminalMemberWriteSource = (
  candidateNode: t.Node,
  suffix: JavaScriptSemanticPropertyPath,
): boolean => {
  const unwrapped = unwrapJavaScriptExpression(candidateNode).node;
  if (
    readExactJavaScriptLiteral(unwrapped).found ||
    t.isRegExpLiteral(unwrapped)
  )
    return true;
  if (suffix.length === 0)
    return (
      t.isObjectExpression(unwrapped) ||
      t.isArrayExpression(unwrapped) ||
      t.isFunction(unwrapped) ||
      (t.isClass(unwrapped) && !unwrapped.decorators?.length)
    );
  if (t.isObjectExpression(unwrapped) && unwrapped.properties.length === 0)
    return true;
  if (t.isArrayExpression(unwrapped) && unwrapped.elements.length === 0)
    return true;
  return false;
};

const electronMemberWriteExports = (
  root: t.Node,
  members: readonly (string | null)[],
  state: JavaScriptSemanticAnalysisState,
  interop: ReturnType<typeof createSemanticModuleInterop>,
  returnQueries: ElectronMemberWriteReturnQueries,
  rootOrigin: (node: t.Node) => readonly string[] | undefined,
  candidateRootExport: (node: t.Node) => readonly string[] | undefined,
  exportsByBinding: Map<string, readonly string[] | null>,
): readonly JavaScriptSemanticPropertyPath[] => {
  const direct = rootOrigin(root) ?? candidateRootExport(root);
  if (direct !== undefined) return [[...direct, ...members]];
  const rootActivation = enclosingActivationFunction(root, state);
  const results: JavaScriptSemanticPropertyPath[] = [];
  const seenPaths = new Set<string>();
  const addPath = (candidate: JavaScriptSemanticPropertyPath): void => {
    const key = JSON.stringify(candidate);
    if (!seenPaths.has(key)) {
      seenPaths.add(key);
      results.push(candidate);
    }
  };
  const pending: ElectronMemberWriteCandidate[] = [];
  const visited = new WeakMap<t.Node, Set<string>>();
  let selections = 0;
  let widened = false;
  let nextFrameId = 1;
  const allocateFrameId = (): number => {
    const id = nextFrameId;
    nextFrameId += 1;
    return id;
  };
  const enqueue = (candidate: ElectronMemberWriteCandidate): void => {
    const node = unwrapJavaScriptExpression(candidate.node).node;
    if (isSeparateTerminalMemberWriteSource(node, candidate.suffix)) return;
    if (!widened && selections >= state.precision.alias_selections) {
      state.valueResourceLimits.add("alias-selections");
      widened = true;
      for (
        let frame = candidate.callFrame;
        frame !== undefined;
        frame = frame.parentFrame
      ) {
        for (const sources of frame.parameterSources.values())
          for (const source of sources)
            enqueue({ node: source.node, suffix: [null] });
        for (const receiver of frame.receiverSources)
          enqueue({ node: receiver, suffix: [null] });
      }
    }
    const normalized: ElectronMemberWriteCandidate = widened
      ? {
          node,
          suffix: [null],
          ...(candidate.awaitDepths?.length ? { awaitDepths: [1] } : {}),
          ...(candidate.iteratedDepths?.length ? { iteratedDepths: [1] } : {}),
          ...(candidate.iteratedElementDepths?.length
            ? { iteratedElementDepths: [1] }
            : {}),
        }
      : {
          ...candidate,
          node,
          capturedSelections: normalizeCandidateCaptures(
            candidate.capturedSelections,
            {
              callFrame: candidate.callFrame,
              rootActivation,
              suffixLength: candidate.suffix.length,
              state,
            },
          ),
        };
    const visitKey = JSON.stringify([
      normalized.suffix,
      normalized.readAt?.start,
      normalized.readAt?.end,
      normalized.capturedSelections?.map(({ at, depth, ownEnumerable }) => [
        at.start,
        at.end,
        depth,
        ownEnumerable,
      ]),
      normalized.descriptorReads,
      normalized.awaitDepths,
      normalized.iteratedDepths,
      normalized.iteratedElementDepths,
      normalized.callFrame?.id ?? 0,
    ]);
    const nodeVisits = visited.get(node) ?? new Set<string>();
    if (nodeVisits.has(visitKey)) return;
    selections += 1;
    nodeVisits.add(visitKey);
    visited.set(node, nodeVisits);
    pending.push(normalized);
  };
  enqueue({ node: root, suffix: members });
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const node = current.node;
    const capturedSelections = current.capturedSelections;
    const nextPending: ElectronMemberWriteCandidate[] = [];

    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      const { root: memberRoot, members: memberSegments } =
        electronMemberPath(node);
      enqueue({
        node: memberRoot,
        suffix: [...memberSegments, ...current.suffix],
        readAt: current.readAt ?? node,
        capturedSelections: [
          ...(semanticShiftCapturedSelections(
            capturedSelections,
            memberSegments.length,
          ) ?? []),
          ...(buildPrefixCaptures(node, memberSegments.length) ?? []),
        ],
        descriptorReads: current.descriptorReads,
        awaitDepths: current.awaitDepths,
        iteratedDepths: current.iteratedDepths,
        iteratedElementDepths: current.iteratedElementDepths,
        callFrame: current.callFrame,
      });
      continue;
    }

    if (!t.isIdentifier(node)) {
      enqueueNonIdentifierMemberWriteSources(
        node,
        current,
        capturedSelections,
        state,
        interop,
        returnQueries,
        allocateFrameId,
        addPath,
        nextPending,
      );
      for (const candidate of nextPending) enqueue(candidate);
      continue;
    }

    if (semanticResolutionBlocked(state, node, node.name)) continue;
    const binding = resolveSemanticBindingState(state, node, node.name);
    if (binding === undefined) continue;
    const activeDescriptor = descriptorReadAtDepth(
      current.descriptorReads,
      current.suffix.length,
    );
    const bindingRead = semanticBindingAtRead(binding, node, state);
    const snapshot = bindingRead.binding;
    if (activeDescriptor?.kind !== "get" && activeDescriptor?.kind !== "set") {
      let stable = exportsByBinding.get(binding.bindingId);
      if (stable === undefined) {
        stable = electronExport(binding, state, interop);
        exportsByBinding.set(binding.bindingId, stable);
      }
      if (stable !== null) addPath([...stable, ...current.suffix]);
      const candidateExport = candidateRootExport(node);
      if (candidateExport !== undefined)
        addPath([...candidateExport, ...current.suffix]);
      const bundled = (
        semanticBundledRequireOrigin(node, state) ??
        semanticBundledRequireOriginCandidate(node, state)
      )?.origin;
      if (bundled !== undefined && ELECTRON_MODULE.test(bundled.specifier))
        addPath([
          ...electronExportPath(bundled.importedPath),
          ...current.suffix,
        ]);
      for (const origin of snapshot.directOrigins)
        if (ELECTRON_MODULE.test(origin.specifier))
          addPath([
            ...electronExportPath(origin.importedPath),
            ...current.suffix,
          ]);
    }
    const inactiveDefaults = inactiveDefaultNodesForBinding(
      binding.bindingId,
      current.callFrame,
    );
    if (activeDescriptor !== undefined) {
      enqueueBindingDescriptorReadSources({
        activeDescriptor,
        binding,
        bindingRead,
        node,
        current,
        capturedSelections,
        inactiveDefaults,
        state,
        enqueue,
      });
      continue;
    }
    const projectedFacts = semanticProjectedSourceFactsAtRead(
      binding,
      node,
      current.suffix,
      state,
      false,
      current.readAt ?? node,
      capturedSelections,
    );
    enqueueCallFrameParameterMatches(
      binding,
      bindingRead.hasDefiniteInitializer,
      projectedFacts === undefined || projectedFacts.retainsOrigin,
      current,
      capturedSelections,
      enqueue,
    );
    const projected = projectedFacts?.sources;
    if (projected !== undefined) {
      for (const source of projected) {
        if (inactiveDefaults?.has(source.node)) continue;
        enqueue({
          node: source.node,
          suffix: source.path,
          readAt:
            current.suffix.length === 0 ? undefined : (current.readAt ?? node),
          capturedSelections: [
            ...(semanticShiftCapturedSelections(
              capturedSelections,
              source.path.length - current.suffix.length,
            ) ?? []),
            ...(source.capturedSelections ?? []),
          ],
          descriptorReads: current.descriptorReads,
          awaitDepths: current.awaitDepths,
          iteratedDepths: current.iteratedDepths,
          iteratedElementDepths: current.iteratedElementDepths,
          callFrame: current.callFrame,
        });
      }
      continue;
    }
    enqueueFallbackBindingMemberWriteSources(
      binding,
      snapshot,
      node,
      current,
      inactiveDefaults,
      state,
      nextPending,
    );
    for (const candidate of nextPending) enqueue(candidate);
  }
  return results;
};

// Read import and require origins directly; general value evaluation is
// unnecessary here and costly across large vendor bundles.
const electronExport = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
  interop: ReturnType<typeof createSemanticModuleInterop>,
): readonly string[] | null => {
  const reassigned = binding.definitions.some(
    ({ kind }) => kind === "assignment",
  );
  const converted = interop.origin(binding);
  if (reassigned && converted === undefined) return null;
  const directOrigin = converted?.origin ?? bindingOrigin(binding, state);
  const initializer = semanticStableInitializer(binding, state);
  if (directOrigin === undefined && initializer === undefined) return null;
  const provenance =
    directOrigin === undefined
      ? evaluateSemanticProvenance(binding, state)
      : undefined;
  const origin =
    directOrigin ??
    (provenance?.status === "module" && provenance.origins.length === 1
      ? provenance.origins[0]
      : undefined);
  return origin !== undefined && ELECTRON_MODULE.test(origin.specifier)
    ? electronExportPath(origin.importedPath)
    : null;
};

const electronRequireOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
) =>
  semanticRequireOrigin(node, state) ??
  semanticBundledRequireOrigin(node, state);

const bindingOrigin = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined => {
  if (binding.directOrigins.length > 0)
    return binding.directOrigins.length === 1
      ? binding.directOrigins[0]
      : undefined;
  const initializer = semanticStableInitializer(binding, state);
  if (initializer === undefined) return undefined;
  const origin = electronRequireOrigin(initializer.node, state)?.origin;
  const projection = initializer.projection;
  return origin === undefined ||
    !projection.every((key): key is string => typeof key === "string")
    ? undefined
    : { ...origin, importedPath: [...origin.importedPath, ...projection] };
};

const createState = (
  program: t.Program,
  staticImportResolutionMode: JavaScriptModuleResolutionMode = "import",
  precision?: JavaScriptSemanticPrecisionInput,
): JavaScriptSemanticAnalysisState => {
  const root: JavaScriptSemanticScopeState = {
    scopeId: semanticScopeId("program", program),
    parentScopeId: null,
    kind: "program",
    location: range(program),
    bindingsComplete: true,
    bindings: new Map(),
  };
  return {
    precision: resolveJavaScriptSemanticPrecision(precision),
    arrayIterationUnknown: false,
    memberMutationFactsComplete: false,
    program,
    opaqueEffects: {
      mayReferenceGlobalCode: false,
      sites: new WeakSet(),
      sloppySites: new WeakSet(),
      byScope: new Map(),
      children: new Map(),
      globalSites: [],
    },
    staticImportResolutionMode,
    valueResourceLimits: new Set(),
    getterResourceLimits: new Set(),
    returnedReferenceWidenings: new Set(),
    parentsByNode: new WeakMap(),
    erasedSyntaxNodes: new WeakSet(),
    scopes: [root],
    scopesById: new Map([[root.scopeId, root]]),
    scopeByNode: new WeakMap([[program, root]]),
    bindingsById: new Map(),
    bindingWrites: new Map(),
    prototypeRequireMutationObserved: false,
    prototypeEnumerationMayAffect: false,
    prototypeMutationSites: [],
    implicitPropertyReads: new WeakMap(),
    callables: [],
    callableNodesById: new Map(),
    moduleLinks: [],
    linkedRequireCalls: new WeakSet(),
    moduleLinkBindings: new WeakMap(),
    defaultExportExpressions: new WeakMap(),
    conditionallySkippedExpressions: new WeakSet(),
    requiredModuleEffects: new Map(),
    ambientBindingWrites: new Map(),
    ambientWrites: new SemanticPropertyPathCoverage(),
    escapingReferenceStores: new WeakSet(),
    retainedGlobalCallReceivers: new WeakSet(),
    ambientEscapes: new SemanticPropertyPathCoverage(),
    ambientEscapeEffects: [],
    ambientWriteEffects: [],
  };
};

const globalCodeRoots = new Set([
  "eval",
  "Function",
  "globalThis",
  "global",
  "window",
  "self",
]);

function* collectDefinitionsSteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, void> {
  const stack: JavaScriptSemanticScopeState[] = [
    currentSemanticScope(state.scopes),
  ];
  const openedScopes = new WeakMap<t.Node, number>();
  const assignments: {
    readonly node: t.Node;
    readonly scope: JavaScriptSemanticScopeState;
    readonly conditionallySkipped: boolean;
  }[] = [];
  const opaqueCandidates: {
    node: t.CallExpression;
    scopeId: string;
  }[] = [];
  const displacedVarInitializers: {
    node: t.VariableDeclarator;
    scope: JavaScriptSemanticScopeState;
    owner: JavaScriptSemanticScopeState;
  }[] = [];
  const thrownValues: {
    node: t.ThrowStatement;
    ancestors: readonly t.Node[];
  }[] = [];
  const legacyBlockFunctions: {
    node: t.FunctionDeclaration;
    scope: JavaScriptSemanticScopeState;
  }[] = [];
  let needsPrototypeFacts = false;
  const implicitReadCalls: (t.CallExpression | t.OptionalCallExpression)[] = [];
  let mayReferenceReflect = false;
  const functionBodies: {
    readonly body: t.BlockStatement;
    readonly scope: JavaScriptSemanticScopeState;
    readonly parameters: t.Function["params"];
  }[] = [];
  yield* traverseJavaScriptAstSteps(program, {
    enter: (node, parent, readAncestors) => {
      if (parent !== null) state.parentsByNode.set(node, parent);
      if (
        (parent !== null && state.erasedSyntaxNodes.has(parent)) ||
        isErasedJavaScriptValueChild(node, parent)
      ) {
        state.erasedSyntaxNodes.add(node);
        return;
      }
      if (
        t.isWithStatement(node) ||
        t.isForInStatement(node) ||
        t.isForOfStatement(node) ||
        t.isArrayExpression(node) ||
        t.isFunction(node)
      )
        needsPrototypeFacts = true;
      let parentScope = currentSemanticScope(stack);
      if (
        semanticMethodDefinitionExpression(parent ?? undefined, node) &&
        parentScope.parentScopeId !== null
      ) {
        // A method definition expression is evaluated before entering the method's
        // parameter and body environments.
        const keyScope = state.scopesById.get(parentScope.parentScopeId);
        if (keyScope !== undefined) {
          stack.push(keyScope);
          openedScopes.set(node, 1);
          parentScope = keyScope;
        }
      }
      if (
        parent !== null &&
        t.isWithStatement(parent) &&
        parent.body === node
      ) {
        const dynamicScope: JavaScriptSemanticScopeState = {
          scopeId: `${semanticScopeId("block", parent)}:with`,
          parentScopeId: parentScope.scopeId,
          kind: "block",
          location: range(parent),
          bindingsComplete: false,
          bindings: new Map(),
          dynamicWithStatement: parent,
        };
        state.scopes.push(dynamicScope);
        state.scopesById.set(dynamicScope.scopeId, dynamicScope);
        stack.push(dynamicScope);
        openedScopes.set(node, 1);
        parentScope = dynamicScope;
      }
      bindOuterDeclaration(node, parentScope, state);
      if (
        t.isFunctionDeclaration(node) &&
        node.id != null &&
        parentScope.kind === "block"
      )
        legacyBlockFunctions.push({ node, scope: parentScope });
      if (t.isVariableDeclarator(node) && node.init != null) {
        const owner = semanticVariableScope(parentScope, parent, state);
        if (owner !== parentScope)
          displacedVarInitializers.push({ node, scope: parentScope, owner });
      }
      const nested = nestedScope(node, parent, parentScope, state);
      if (nested !== undefined) {
        stack.push(nested);
        openedScopes.set(node, (openedScopes.get(node) ?? 0) + 1);
        if (t.isBlockStatement(node) && t.isFunction(parent))
          functionBodies.push({
            body: node,
            scope: nested,
            parameters: runtimeFunctionParameters(parent),
          });
      }
      const scope = currentSemanticScope(stack);
      // Other nodes inherit the nearest boundary through their AST parents.
      // Avoid a second full-tree index for the same lexical relationship.
      if (parent === null || openedScopes.has(node))
        state.scopeByNode.set(node, scope);
      collectSemanticCallable({
        node,
        parent,
        containerScope: parentScope,
        bodyScope: nested,
        state,
      });
      bindInnerDeclaration(node, parent, scope, state);
      if (
        t.isIdentifier(node, { name: "Reflect" }) ||
        t.isStringLiteral(node, { value: "Reflect" }) ||
        (t.isTemplateLiteral(node) &&
          semanticStaticPropertyKey(node, true) === "Reflect")
      )
        mayReferenceReflect = true;
      // Aliases and optional/call/apply/bind forms share the intrinsic owner;
      // callee spelling alone cannot identify the property-read operation.
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
        implicitReadCalls.push(node);
      if (t.isThrowStatement(node))
        thrownValues.push({ node, ancestors: readAncestors() });
      // Every supported global-code origin starts with one of these decoded
      // identifiers, including computed properties and destructured aliases.
      if (
        t.isThisExpression(node) ||
        (t.isIdentifier(node) && globalCodeRoots.has(node.name))
      )
        state.opaqueEffects.mayReferenceGlobalCode = true;
      if (
        t.isCallExpression(node) &&
        t.isIdentifier(unwrapJavaScriptExpression(node.callee).node, {
          name: "eval",
        })
      )
        opaqueCandidates.push({ node, scopeId: scope.scopeId });
      if (
        t.isVariableDeclarator(node) &&
        node.init != null &&
        parent !== null &&
        t.isVariableDeclaration(parent, { kind: "var" }) &&
        writeMayBeSkipped(node, readAncestors())
      )
        state.conditionallySkippedExpressions.add(node.init);
      if (
        t.isAssignmentExpression(node) ||
        t.isUpdateExpression(node) ||
        t.isForOfStatement(node) ||
        t.isForInStatement(node)
      )
        assignments.push({
          node,
          scope,
          conditionallySkipped:
            t.isForOfStatement(node) ||
            t.isForInStatement(node) ||
            writeMayBeSkipped(node, readAncestors()),
        });
    },
    exit: (node) => {
      for (let count = openedScopes.get(node) ?? 0; count > 0; count--)
        stack.pop();
    },
  });
  // A var declaration is instantiated in its variable environment, while its
  // initializer assigns through the lexical environment at the source site.
  for (const { node, scope, owner } of displacedVarInitializers) {
    for (const identifier of semanticWriteTargets(node.id)) {
      if (!t.isIdentifier(identifier)) continue;
      const selected = resolveSemanticBindingFromScope(
        scope,
        identifier.name,
        state,
      );
      const declared = owner.bindings.get(identifier.name);
      if (
        selected === undefined ||
        selected === declared ||
        declared === undefined
      )
        continue;
      // Move the facts already parsed for this slot, including destructuring
      // projections, defaults and rest copies, without reinterpreting its RHS.
      const belongsToDeclaration = (value: t.Node): boolean => {
        let candidate: t.Node | undefined = value;
        while (candidate !== undefined && candidate !== node)
          candidate = state.parentsByNode.get(candidate);
        return candidate === node;
      };
      for (let index = 0; index < declared.initializers.length; index++) {
        const initializer = declared.initializers[index];
        if (
          initializer !== undefined &&
          belongsToDeclaration(initializer.node)
        ) {
          declared.initializers.splice(index, 1);
          index--;
          selected.initializers.push(initializer);
        }
      }
      for (
        let index = 0;
        index < declared.referenceInitializers.length;
        index++
      ) {
        const initializer = declared.referenceInitializers[index];
        if (
          initializer !== undefined &&
          belongsToDeclaration(initializer.node)
        ) {
          declared.referenceInitializers.splice(index, 1);
          index--;
          selected.referenceInitializers.push({
            ...initializer,
            assignment: true,
          });
        }
      }
      addAssignment(
        identifier,
        null,
        scope,
        state,
        node.init !== null &&
          node.init !== undefined &&
          state.conditionallySkippedExpressions.has(node.init),
        node,
      );
    }
  }
  for (const { node, ancestors } of thrownValues) {
    let child: t.Node = node;
    for (let index = ancestors.length - 1; index >= 0; index--) {
      const parent = ancestors[index]!;
      if (t.isFunction(parent) || t.isClass(parent)) break;
      if (
        t.isTryStatement(parent) &&
        parent.handler != null &&
        child === parent.block
      ) {
        if (parent.handler.param != null)
          state.implicitPropertyReads.set(
            node,
            semanticPatternPropertyReadSources(
              parent.handler.param,
              { node: node.argument, projection: [] },
              node,
            ),
          );
        const scope = state.scopeByNode.get(parent.handler);
        if (scope !== undefined && parent.handler.param != null)
          bindPattern({
            pattern: parent.handler.param,
            initializer: node.argument,
            scope,
            state,
            mutable: true,
            referenceOnly: true,
            entryBody: parent.handler.body,
          });
        break;
      }
      child = parent;
    }
  }
  for (const { node, scope } of legacyBlockFunctions) {
    if (
      node.id == null ||
      semanticStrictnessAt(state.parentsByNode.get(node) ?? node, state) ===
        "strict"
    )
      continue;
    let outer =
      scope.parentScopeId === null
        ? undefined
        : state.scopesById.get(scope.parentScopeId);
    while (outer !== undefined) {
      const binding = outer.bindings.get(node.id.name);
      if (
        binding !== undefined &&
        !binding.declarationKinds.has("var") &&
        binding.kind !== "parameter"
      )
        break;
      if (
        outer.kind === "function" ||
        outer.kind === "program" ||
        outer.kind === "static-block"
      ) {
        if (binding !== undefined)
          addAssignment(node.id, node, outer, state, false, node);
        break;
      }
      outer =
        outer.parentScopeId === null
          ? undefined
          : state.scopesById.get(outer.parentScopeId);
    }
  }
  if (needsPrototypeFacts)
    yield* indexPrototypeUncertaintySteps(program, state);
  // All declarations must exist before resolving writes, including hoisted
  // functions and local declarations that shadow an outer binding.
  for (const [
    index,
    { node, scope, conditionallySkipped },
  ] of assignments.entries()) {
    if (index % 64 === 0) yield;
    bindAssignment(node, scope, state, conditionallySkipped);
  }
  for (const [index, { body, scope, parameters }] of functionBodies.entries()) {
    if (index % 64 === 0) yield;
    for (const parameter of parameters)
      for (const identifier of semanticWriteTargets(
        t.isTSParameterProperty(parameter) ? parameter.parameter : parameter,
      ))
        if (t.isIdentifier(identifier))
          copyParameterToBody({ identifier, body, scope, state });
  }
  const readInterop = mayReferenceReflect
    ? createSemanticModuleInterop(state)
    : undefined;
  for (const node of readInterop === undefined ? [] : implicitReadCalls) {
    const invocation = readInterop?.intrinsicInvocation(node);
    if (
      invocation?.kind !== "known" ||
      invocation.path.join(".") !== "intrinsic.Reflect.get"
    )
      continue;
    const [receiver, key] = invocation.arguments ?? [];
    const receiverUnknown =
      invocation.arguments === undefined || t.isSpreadElement(receiver);
    if (!receiverUnknown && !t.isExpression(receiver)) continue;
    const selected =
      !receiverUnknown && (t.isStringLiteral(key) || t.isNumericLiteral(key))
        ? key.value
        : null;
    state.implicitPropertyReads.set(node, [
      {
        node: receiverUnknown ? node : (receiver ?? node),
        projection: receiverUnknown ? [null, selected] : [selected],
        mutation: node,
        lookup: "prototype",
      },
    ]);
  }
  indexSemanticOpaqueEffects(opaqueCandidates, state);
  if (state.opaqueEffects.byScope.size > 0) clearSemanticValueCaches(state);
}

/** Preserve uncertainty when source can change or expose a built-in prototype. */
function* indexPrototypeUncertaintySteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, void> {
  let effectSite: t.Node = program;
  const seen = new Map<SemanticPrototypeOwner, WeakSet<t.Node>>();
  const possiblePrototypeReferences = createAmbientPathResolver(state, false);
  const taint = (owner: SemanticPrototypeOwner, inherited = true): void => {
    let sites = seen.get(owner);
    if (sites === undefined) {
      sites = new WeakSet();
      seen.set(owner, sites);
    }
    if (inherited && !sites.has(effectSite)) {
      sites.add(effectSite);
      state.prototypeMutationSites.push({ owner, node: effectSite });
    }
    if (owner === "Object") state.prototypeRequireMutationObserved = undefined;
    state.prototypeEnumerationMayAffect = undefined;
  };
  const globalOwner = (node: t.Node): SemanticPrototypeOwner | undefined => {
    const value = unwrapJavaScriptExpression(node).node;
    const member =
      t.isMemberExpression(value) || t.isOptionalMemberExpression(value);
    const key = t.isIdentifier(value)
      ? value.name
      : member
        ? semanticStaticPropertyKey(value.property, value.computed)
        : null;
    const owner = semanticPrototypeOwners.find(
      (candidate) => candidate === key,
    );
    if (owner === undefined) return undefined;
    if (isUnmodifiedGlobalReference(value, state, owner)) return owner;
    if (member) {
      const { paths, callerPaths } = possiblePrototypeReferences(value);
      const selectsOwner = (path: readonly (string | null)[]) =>
        path.length === 2 && path[0] === "global" && path[1] === owner;
      return paths.some(selectsOwner) || callerPaths.some(selectsOwner)
        ? owner
        : undefined;
    }
    return resolveSemanticBindingState(state, value, owner) === undefined
      ? owner
      : undefined;
  };
  const prototypeOwner = (node: t.Node): SemanticPrototypeOwner | undefined => {
    const value = unwrapJavaScriptExpression(node).node;
    return (t.isMemberExpression(value) ||
      t.isOptionalMemberExpression(value)) &&
      semanticStaticPropertyKey(value.property, value.computed) === "prototype"
      ? globalOwner(value.object)
      : undefined;
  };
  const objectMethod = (node: t.Node): string | undefined => {
    const callee = unwrapJavaScriptExpression(node).node;
    return (t.isMemberExpression(callee) ||
      t.isOptionalMemberExpression(callee)) &&
      globalOwner(callee.object) === "Object"
      ? (semanticStaticPropertyKey(callee.property, callee.computed) ??
          undefined)
      : undefined;
  };
  const mutators = new Set([
    "defineProperty",
    "defineProperties",
    "setPrototypeOf",
  ]);
  yield* traverseJavaScriptValueAstSteps(program, state.erasedSyntaxNodes, {
    enter: (node, parent) => {
      effectSite = node;
      const write = semanticWriteSiteTarget(node);
      if (write !== null) {
        for (const target of semanticWriteTargets(write)) {
          const value = unwrapJavaScriptExpression(target).node;
          if (
            t.isMemberExpression(value) ||
            t.isOptionalMemberExpression(value)
          ) {
            const prototype = prototypeOwner(value.object);
            const owner = prototype ?? globalOwner(value.object);
            if (owner !== undefined)
              taint(
                owner,
                prototype !== undefined ||
                  semanticStaticPropertyKey(value.property, value.computed) ===
                    "prototype",
              );
          } else {
            const owner = globalOwner(value);
            if (owner !== undefined) taint(owner);
          }
        }
      }
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        const method = objectMethod(node.callee);
        const callee = unwrapJavaScriptExpression(node.callee).node;
        if (
          t.isMemberExpression(callee) ||
          t.isOptionalMemberExpression(callee)
        ) {
          const owner = prototypeOwner(callee.object);
          if (owner !== undefined) taint(owner);
        }
        for (const [index, argument] of node.arguments.entries()) {
          const owner = prototypeOwner(argument) ?? globalOwner(argument);
          if (owner === undefined) continue;
          // These intrinsics mutate only their first argument. Linking another
          // object's prototype to this one does not mutate this prototype.
          if (method !== undefined && mutators.has(method) && index !== 0)
            continue;
          taint(owner);
        }
      }
      const owner = prototypeOwner(node) ?? globalOwner(node);
      if (owner === undefined || parent === null) return;
      if (
        (t.isMemberExpression(parent) ||
          t.isOptionalMemberExpression(parent)) &&
        parent.object === node
      )
        return;
      if (
        (t.isCallExpression(parent) || t.isOptionalCallExpression(parent)) &&
        parent.arguments.includes(node as t.Expression)
      )
        return;
      if (
        t.isIdentifier(node) &&
        semanticReferenceRole(node, parent, state.parentsByNode.get(parent)) ===
          null
      )
        return;
      taint(owner);
    },
  });
}

const copyParameterToBody = (input: {
  readonly identifier: t.Identifier;
  readonly body: t.BlockStatement;
  readonly scope: JavaScriptSemanticScopeState;
  readonly state: JavaScriptSemanticAnalysisState;
}): void => {
  const { identifier, body, scope, state } = input;
  const binding = scope.bindings.get(identifier.name);
  if (
    binding === undefined ||
    binding.kind !== "variable" ||
    binding.definitions.some(({ kind }) => kind === "function")
  )
    return;
  // A separate body var environment starts with the parameter's value. The
  // real parameter identifier retains its scope and source location; entryBody
  // records when the copy occurs without inventing an expression in the AST.
  binding.initializers.unshift({
    node: identifier,
    projection: [],
    entryBody: body,
  });
  for (let index = binding.initializers.length - 1; index >= 0; index -= 1) {
    const initializer = binding.initializers[index];
    if (
      initializer !== undefined &&
      initializer.entryBody === undefined &&
      initializer.projection.length === 0 &&
      t.isIdentifier(initializer.node) &&
      resolveSemanticBindingState(
        state,
        initializer.node,
        initializer.node.name,
      ) === binding
    )
      // Direct self-initialization preserves the prior value, including any
      // actual overwrite before it. Keep the source definition/reference facts.
      binding.initializers.splice(index, 1);
  }
};

const writeMayBeSkipped = (
  node: t.Node,
  ancestors: readonly t.Node[],
): boolean => {
  let child = node;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const parent = ancestors[index];
    if (
      parent === undefined ||
      t.isFunction(parent) ||
      t.isProgram(parent) ||
      t.isStaticBlock(parent)
    )
      return false;
    if (
      semanticBranchMayBeSkipped(parent, child) ||
      semanticPriorStatementMayExit(parent, child)
    )
      return true;
    child = parent;
  }
  return false;
};

const bindOuterDeclaration = (
  node: t.Node,
  scope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
): void => {
  if (t.isFunctionDeclaration(node) && t.isIdentifier(node.id))
    addBinding({
      state,
      scope,
      name: node.id.name,
      kind: "function",
      mutable: false,
      definitionNode: node.id,
      initializer: node,
    });
  else if (t.isClassDeclaration(node) && t.isIdentifier(node.id))
    addBinding({
      state,
      scope,
      name: node.id.name,
      kind: "class",
      mutable: false,
      definitionNode: node.id,
      initializer: node,
    });
};

const bindInnerDeclaration = (
  node: t.Node,
  parent: t.Node | null,
  scope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
): void => {
  if (t.isImportDeclaration(node)) bindImports(node, scope, state);
  else if (t.isTSImportEqualsDeclaration(node))
    bindImportEquals(node, scope, state);
  else if (t.isVariableDeclarator(node))
    bindPattern({
      pattern: node.id,
      initializer: node.init ?? null,
      scope: semanticVariableScope(scope, parent, state),
      state,
      mutable:
        parent !== null && t.isVariableDeclaration(parent)
          ? parent.kind !== "const"
          : true,
      ...(parent !== null && t.isVariableDeclaration(parent)
        ? { declarationKind: parent.kind }
        : {}),
    });
  else if (t.isClass(node) && t.isIdentifier(node.id))
    addBinding({
      state,
      scope,
      name: node.id.name,
      kind: "class",
      mutable: false,
      definitionNode: node.id,
      initializer: node,
    });
  else if (t.isFunction(node)) bindFunctionLocals(node, scope, state);
  else if (t.isCatchClause(node) && node.param != null)
    bindPattern({
      pattern: node.param,
      initializer: null,
      scope,
      state,
      mutable: true,
      kind: "catch",
    });
};

const bindImportEquals = (
  node: t.TSImportEqualsDeclaration,
  scope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
): void => {
  const specifier = semanticImportEqualsSpecifier(node);
  if (specifier === null) return;
  addBinding({
    state,
    scope,
    name: node.id.name,
    kind: "import",
    mutable: false,
    definitionNode: node.id,
    initializer: null,
    directOrigin: { specifier, importedPath: [], resolutionMode: "require" },
  });
};

// A parameter or catch binding starts with a caller-supplied value that a
// conditional logical assignment can retain, so its RHS is not exact.
const hasIncomingValue = (
  identifier: t.Identifier,
  scope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const kind = resolveSemanticBindingFromScope(
    scope,
    identifier.name,
    state,
  )?.kind;
  return kind === "parameter" || kind === "catch";
};

const bindAssignment = (
  node: t.Node,
  scope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
  conditionallySkipped: boolean,
): void => {
  if (t.isAssignmentExpression(node)) {
    const left = unwrapJavaScriptExpression(node.left).node;
    bindMappedArgumentWrite(left, node, state, conditionallySkipped);
    const selectedPattern =
      node.operator === "=" &&
      (t.isObjectPattern(left) || t.isArrayPattern(left));
    if (t.isIdentifier(left))
      addAssignment(
        left,
        node.operator === "=" ||
          ((node.operator === "||=" || node.operator === "??=") &&
            !hasIncomingValue(left, scope, state))
          ? node.right
          : node,
        scope,
        state,
        conditionallySkipped,
        node,
      );
    else {
      for (const identifier of semanticWriteTargets(node.left))
        if (t.isIdentifier(identifier))
          addAssignment(
            identifier,
            selectedPattern ? null : node,
            scope,
            state,
            conditionallySkipped,
            node,
          );
      if (selectedPattern)
        bindPattern({
          pattern: left,
          initializer: node.right,
          scope,
          state,
          mutable: true,
          referenceOnly: true,
          assignmentReference: true,
        });
    }
  } else if (t.isUpdateExpression(node)) {
    const argument = unwrapJavaScriptExpression(node.argument).node;
    bindMappedArgumentWrite(argument, node, state, conditionallySkipped);
    if (t.isIdentifier(argument))
      addAssignment(argument, node, scope, state, conditionallySkipped);
  } else if (t.isForOfStatement(node) || t.isForInStatement(node)) {
    if (
      semanticIterationCardinality(
        node,
        state.prototypeEnumerationMayAffect,
      ) === "empty"
    )
      return;
    for (const pattern of t.isVariableDeclaration(node.left)
      ? node.left.declarations.map(({ id }) => id)
      : [node.left]) {
      for (const identifier of semanticWriteTargets(pattern))
        if (t.isIdentifier(identifier))
          addAssignment(
            identifier,
            node,
            scope,
            state,
            conditionallySkipped,
            node,
          );
      if (t.isForOfStatement(node))
        // Keep the loop value unknown, but preserve references yielded into
        // each bound slot so writes/escapes can reach their iterable origins.
        bindPattern({
          pattern,
          initializer: node,
          scope,
          state,
          mutable: true,
          referenceOnly: true,
        });
    }
  }
};

type MappedArgumentsOwner = {
  readonly scope: JavaScriptSemanticScopeState;
  readonly parameters: ReadonlyMap<number, t.Identifier>;
  readonly strictness: "sloppy" | "strict" | "unknown";
};

/** Find an implicit arguments object through stable local aliases. */
const mappedArgumentsOwner = (
  expression: t.Node,
  state: JavaScriptSemanticAnalysisState,
  seen: Set<string> = new Set(),
): MappedArgumentsOwner | undefined => {
  let value = unwrapJavaScriptExpression(expression).node;
  while (t.isIdentifier(value) && value.name !== "arguments") {
    const binding = resolveSemanticBindingState(state, value, value.name);
    if (binding === undefined || seen.has(binding.bindingId)) return undefined;
    seen.add(binding.bindingId);
    const initializer = semanticStableInitializer(binding, state);
    if (initializer === undefined) return undefined;
    value = unwrapJavaScriptExpression(initializer.node).node;
  }
  if (!t.isIdentifier(value)) return undefined;

  const lookup = semanticBindingLookupAt(state, value, "arguments");
  if (lookup.kind !== "implicit-arguments" && lookup.kind !== "ambient")
    return undefined;
  let owner: t.Function | undefined;
  for (
    let current: t.Node | undefined = value;
    current !== undefined;
    current = state.parentsByNode.get(current)
  ) {
    if (t.isFunction(current) && !t.isArrowFunctionExpression(current)) {
      owner = current;
      break;
    }
  }
  if (owner === undefined) return undefined;
  const scope = state.scopeByNode.get(owner);
  if (scope === undefined) return undefined;

  const parameters = runtimeFunctionParameters(owner);
  if (
    parameters.some((parameter) => {
      const node = t.isTSParameterProperty(parameter)
        ? parameter.parameter
        : parameter;
      return !t.isIdentifier(node);
    })
  )
    return undefined;

  // Duplicate formals map only their last occurrence to the shared binding.
  const mapped = new Map<number, t.Identifier>();
  const names = new Set<string>();
  for (let index = parameters.length - 1; index >= 0; index -= 1) {
    const parameter = parameters[index];
    if (parameter === undefined) continue;
    const node = t.isTSParameterProperty(parameter)
      ? parameter.parameter
      : parameter;
    if (!t.isIdentifier(node) || names.has(node.name)) continue;
    names.add(node.name);
    mapped.set(index, node);
  }
  if (mapped.size === 0) return undefined;

  return {
    scope,
    parameters: mapped,
    strictness: semanticStrictnessAt(owner, state),
  };
};

const semanticStrictnessAt = (
  owner: t.Node,
  state: JavaScriptSemanticAnalysisState,
): MappedArgumentsOwner["strictness"] => {
  for (
    let current: t.Node | undefined = owner;
    current !== undefined;
    current = state.parentsByNode.get(current)
  ) {
    if (t.isClass(current)) return "strict";
    if (
      t.isFunction(current) &&
      t.isBlockStatement(current.body) &&
      current.body.directives.some(({ value }) => value.value === "use strict")
    )
      return "strict";
    if (t.isProgram(current)) return javaScriptProgramStrictness(current);
  }
  return "unknown";
};

/** A mapped arguments property write is another write to its formal binding. */
const bindMappedArgumentWrite = (
  target: t.Node,
  writeSite: t.Node,
  state: JavaScriptSemanticAnalysisState,
  conditionallySkipped: boolean,
): void => {
  for (const writeTarget of semanticWriteTargets(target)) {
    if (
      !t.isMemberExpression(writeTarget) &&
      !t.isOptionalMemberExpression(writeTarget)
    )
      continue;
    const root = semanticReferenceRoot(writeTarget);
    if (root.path.length !== 1) continue;
    const owner = mappedArgumentsOwner(root.root, state);
    if (owner === undefined || owner.strictness === "strict") continue;
    const key = root.path[0];
    const index =
      typeof key === "number"
        ? key
        : typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key)
          ? Number(key)
          : undefined;
    const parameters =
      key === null
        ? [...owner.parameters.values()]
        : index !== undefined && owner.parameters.has(index)
          ? [owner.parameters.get(index)!]
          : [];
    for (const parameter of parameters) {
      addAssignment(
        parameter,
        writeTarget,
        owner.scope,
        state,
        conditionallySkipped,
        writeSite,
      );
    }
  }
};

const nestedScope = (
  node: t.Node,
  parent: t.Node | null,
  parentScope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticScopeState | undefined => {
  const switchOwner =
    t.isSwitchCase(node) && parent !== null && t.isSwitchStatement(parent)
      ? parent
      : undefined;
  if (switchOwner !== undefined) {
    const existing = state.scopesById.get(
      semanticScopeId("block", switchOwner),
    );
    if (existing !== undefined) return existing;
  }
  const kind = scopeKind(node, parent);
  if (kind === undefined) return undefined;
  const scope: JavaScriptSemanticScopeState = {
    scopeId: semanticScopeId(kind, switchOwner ?? node),
    parentScopeId:
      functionNameScope(node, parentScope, state)?.scopeId ??
      parentScope.scopeId,
    kind,
    location: range(switchOwner ?? node),
    bindingsComplete: true,
    bindings: new Map(),
    ...(t.isFunction(node) && !t.isArrowFunctionExpression(node)
      ? { implicitArguments: true as const }
      : {}),
  };
  state.scopes.push(scope);
  state.scopesById.set(scope.scopeId, scope);
  return scope;
};

const functionNameScope = (
  node: t.Node,
  parentScope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticScopeState | undefined => {
  if (!t.isFunctionExpression(node) || !t.isIdentifier(node.id))
    return undefined;
  // A named expression has a private name environment outside its parameters
  // and body. Parameters and local declarations may shadow that name.
  const scope: JavaScriptSemanticScopeState = {
    scopeId: `${semanticScopeId("block", node)}:function-name`,
    parentScopeId: parentScope.scopeId,
    kind: "block",
    location: range(node),
    bindingsComplete: true,
    bindings: new Map(),
  };
  state.scopes.push(scope);
  state.scopesById.set(scope.scopeId, scope);
  addBinding({
    state,
    scope,
    name: node.id.name,
    kind: "function",
    mutable: false,
    definitionNode: node.id,
    initializer: node,
  });
  return scope;
};

const scopeKind = (
  node: t.Node,
  parent: t.Node | null,
): JavaScriptSemanticScopeState["kind"] | undefined => {
  if (t.isFunction(node)) return "function";
  if (t.isClass(node)) return "class";
  if (t.isCatchClause(node)) return "catch";
  if (
    t.isForStatement(node) ||
    t.isForOfStatement(node) ||
    t.isForInStatement(node)
  )
    return "block";
  // A switch body is one lexical scope shared by all its cases, so `let` in
  // two cases must resolve to one binding rather than collide or leak.
  if (t.isSwitchCase(node)) return "block";
  // Each `static {}` block is its own lexical scope; otherwise a `let` in two
  // static blocks would collide in the enclosing class scope.
  if (t.isStaticBlock(node)) return "static-block";
  if (
    t.isBlockStatement(node) &&
    parent !== null &&
    t.isFunction(parent) &&
    parent.body === node
  ) {
    // Parameter expressions cannot see declarations in the function body.
    // Retain the outer function scope for parameters and callable ownership;
    // body declarations belong to a separate variable environment.
    return functionParametersHaveExpressions(parent) ? "function" : undefined;
  }
  if (t.isBlockStatement(node)) return "block";
  return undefined;
};

const functionParametersHaveExpressions = (node: t.Function): boolean => {
  const pending: t.Node[] = [...runtimeFunctionParameters(node)];
  while (pending.length > 0) {
    const parameter = pending.pop();
    if (t.isAssignmentPattern(parameter)) return true;
    if (t.isTSParameterProperty(parameter)) pending.push(parameter.parameter);
    else if (t.isRestElement(parameter)) pending.push(parameter.argument);
    else if (t.isArrayPattern(parameter)) {
      for (const element of parameter.elements)
        if (element !== null) pending.push(element);
    } else if (t.isObjectPattern(parameter)) {
      for (const property of parameter.properties) {
        if (t.isRestElement(property)) pending.push(property.argument);
        else {
          if (property.computed) return true;
          pending.push(property.value);
        }
      }
    }
  }
  return false;
};

const bindImports = (
  node: t.ImportDeclaration,
  scope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
): void => {
  if (isTypeOnlyImportDeclaration(node)) return;
  for (const specifier of node.specifiers) {
    if (t.isImportSpecifier(specifier) && isTypeOnlyImportSpecifier(specifier))
      continue;
    const importedPath = t.isImportDefaultSpecifier(specifier)
      ? ["default"]
      : t.isImportNamespaceSpecifier(specifier)
        ? []
        : [semanticStaticPropertyKey(specifier.imported, false) ?? "[dynamic]"];
    addBinding({
      state,
      scope,
      name: specifier.local.name,
      kind: "import",
      mutable: false,
      definitionNode: specifier.local,
      initializer: null,
      directOrigin: { specifier: node.source.value, importedPath },
      runtimeImport: true,
    });
  }
};

const bindFunctionLocals = (
  node: t.Function,
  scope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
): void => {
  for (const parameter of runtimeFunctionParameters(node))
    bindPattern({
      pattern: t.isTSParameterProperty(parameter)
        ? parameter.parameter
        : parameter,
      initializer: null,
      scope,
      state,
      mutable: true,
      kind: "parameter",
    });
};

const MAX_BIND_PATTERN_VISITS = 512;

const bindPatternNodeId = (node: t.Node, budget: BindPatternBudget): number => {
  const existing = budget.nodeIds.get(node);
  if (existing !== undefined) return existing;
  const assigned = budget.nextNodeId;
  budget.nextNodeId += 1;
  budget.nodeIds.set(node, assigned);
  return assigned;
};

const bindPattern = (input: BindPatternInput): void => {
  const budget = input.budget ?? {
    remaining: MAX_BIND_PATTERN_VISITS,
    nextNodeId: 1,
    nodeIds: new WeakMap(),
    saturatedStates: new Set(),
  };
  let effectiveInput: BindPatternInput =
    input.budget === budget ? input : { ...input, budget };
  if (budget.remaining > 0) {
    budget.remaining -= 1;
  } else {
    const stateKey = JSON.stringify([
      bindPatternNodeId(input.pattern, budget),
      input.initializer === null
        ? 0
        : bindPatternNodeId(input.initializer, budget),
      input.projection ?? [],
      input.referenceOnly ?? false,
      input.assignmentReference ?? false,
      input.copyKind ?? "",
      input.copyProjectionOffset ?? -1,
      input.copyExcludedKeys ?? [],
      input.copyStartIndex ?? -1,
      input.iterationSources?.map((iter) => [
        bindPatternNodeId(iter.node, budget),
        iter.projection,
      ]),
    ]);
    if (budget.saturatedStates.has(stateKey)) return;
    budget.saturatedStates.add(stateKey);
    const {
      fallbackSources: _droppedFallback,
      requiredSources: _droppedRequired,
      ...restInput
    } = effectiveInput;
    effectiveInput = restInput;
  }
  const {
    pattern,
    initializer,
    scope,
    state,
    mutable,
    declarationKind,
    kind = "variable",
    projection = [],
    referenceOnly = false,
    assignmentReference,
    copyKind,
    copyProjectionOffset,
    copyExcludedKeys,
    copyStartIndex,
    fallbackSources,
    requiredSources,
    iterationSources,
  } = effectiveInput;
  if (t.isTSParameterProperty(pattern)) {
    bindPattern({ ...effectiveInput, pattern: pattern.parameter });
    return;
  }
  if (t.isIdentifier(pattern)) {
    if (referenceOnly) {
      const binding = resolveSemanticBindingFromScope(
        scope,
        pattern.name,
        state,
      );
      if (binding !== undefined && initializer !== null)
        binding.referenceInitializers.push({
          node: initializer,
          projection,
          ...(effectiveInput.entryBody === undefined
            ? {}
            : { entryBody: effectiveInput.entryBody }),
          ...(assignmentReference === undefined ? {} : { assignment: true }),
          ...(copyKind === undefined ? {} : { copyKind }),
          ...(copyProjectionOffset === undefined
            ? {}
            : { copyProjectionOffset }),
          ...(copyExcludedKeys === undefined ? {} : { copyExcludedKeys }),
          ...(copyStartIndex === undefined ? {} : { copyStartIndex }),
          ...(fallbackSources === undefined ? {} : { fallbackSources }),
          ...(requiredSources === undefined ? {} : { requiredSources }),
          ...(iterationSources === undefined ? {} : { iterationSources }),
        });
      return;
    }
    addBinding({
      state,
      scope,
      name: pattern.name,
      kind,
      mutable,
      ...(declarationKind === undefined ? {} : { declarationKind }),
      definitionNode: pattern,
      initializer,
      projection,
      ...(iterationSources === undefined ? {} : { iterationSources }),
    });
    return;
  }
  if (t.isAssignmentPattern(pattern)) {
    const saturated = budget.remaining <= 0;
    bindPattern({
      ...effectiveInput,
      pattern: pattern.left,
      initializer:
        kind === "parameter" || kind === "catch"
          ? initializer
          : (initializer ?? pattern.right),
      ...(saturated
        ? {}
        : {
            requiredSources: [
              ...(requiredSources ?? []),
              ...(initializer === null
                ? []
                : [
                    {
                      node: initializer,
                      projection,
                      ...(iterationSources === undefined
                        ? {}
                        : { iterationSources }),
                    },
                  ]),
            ],
          }),
    });
    bindPattern({
      budget,
      state,
      scope,
      mutable,
      kind,
      pattern: pattern.left,
      initializer: pattern.right,
      projection: [],
      referenceOnly: true,
      ...(assignmentReference === undefined ? {} : { assignmentReference }),
      ...(saturated
        ? {}
        : {
            fallbackSources: [
              ...(fallbackSources ?? []),
              ...(initializer === null
                ? []
                : [
                    {
                      node: initializer,
                      projection,
                      ...(iterationSources === undefined
                        ? {}
                        : { iterationSources }),
                    },
                  ]),
            ],
            ...(requiredSources === undefined ? {} : { requiredSources }),
          }),
    });
    return;
  }
  if (t.isRestElement(pattern)) {
    bindPattern({
      ...effectiveInput,
      pattern: pattern.argument,
      initializer: null,
      mutable: true,
    });
    return;
  }
  if (t.isObjectPattern(pattern))
    for (const property of pattern.properties) {
      if (t.isRestElement(property)) {
        bindPattern({
          ...effectiveInput,
          pattern: property.argument,
          initializer: null,
          mutable: true,
          projection: [],
        });
        bindPattern({
          ...effectiveInput,
          pattern: property.argument,
          projection: [...projection, null],
          referenceOnly: true,
          copyKind: "object-rest",
          copyProjectionOffset: projection.length,
          copyExcludedKeys: semanticObjectPatternKeys(pattern),
        });
      } else {
        const name = semanticStaticPropertyKey(property.key, property.computed);
        bindPattern({
          ...effectiveInput,
          pattern: property.value,
          projection: [...projection, name],
        });
      }
    }
  else if (t.isArrayPattern(pattern)) {
    const arrayInput = {
      ...effectiveInput,
      ...(initializer === null
        ? {}
        : {
            iterationSources: [
              ...(iterationSources ?? []),
              { node: initializer, projection },
            ],
          }),
    };
    pattern.elements.forEach((element, index) => {
      if (element !== null) {
        bindPattern({
          ...arrayInput,
          pattern: element,
          projection: [...projection, index],
        });
        if (t.isRestElement(element))
          bindPattern({
            ...arrayInput,
            pattern: element.argument,
            projection: [...projection, null],
            referenceOnly: true,
            copyKind: "array-rest",
            copyProjectionOffset: projection.length,
            copyStartIndex: index,
          });
      }
    });
  }
};

const addBinding = (input: AddBindingInput): void => {
  const {
    state,
    scope,
    name,
    kind,
    mutable,
    declarationKind,
    definitionNode,
    initializer,
    directOrigin,
    runtimeImport,
    projection = [],
    iterationSources,
  } = input;
  let binding = scope.bindings.get(name);
  if (binding === undefined) {
    if (!scope.bindingsComplete) return;
    binding = createBinding(scope, name, kind, mutable);
    scope.bindings.set(name, binding);
    state.bindingsById.set(binding.bindingId, binding);
  }
  binding.mutable ||= mutable;
  if (declarationKind !== undefined)
    binding.declarationKinds.add(declarationKind);
  binding.definitions.push({ kind, location: range(definitionNode) });
  if (initializer !== null)
    binding.initializers.push({
      node: initializer,
      projection,
      ...(iterationSources === undefined ? {} : { iterationSources }),
    });
  if (directOrigin !== undefined)
    binding.directOrigins.push(
      directOrigin.resolutionMode === undefined &&
        state.staticImportResolutionMode !== "import"
        ? {
            ...directOrigin,
            resolutionMode: state.staticImportResolutionMode,
          }
        : directOrigin,
    );
  binding.runtimeImport ||= runtimeImport === true;
};

const createBinding = (
  scope: JavaScriptSemanticScopeState,
  name: string,
  kind: JavaScriptSemanticDefinition["kind"],
  mutable: boolean,
): JavaScriptSemanticBindingState => ({
  bindingId: semanticBindingId(scope.scopeId, name),
  scopeId: scope.scopeId,
  name,
  kind,
  mutable,
  declarationKinds: new Set(),
  memberWrites: [],
  escapedPaths: [],
  definitions: [],
  initializers: [],
  referenceInitializers: [],
  directOrigins: [],
  runtimeImport: false,
});

const addAssignment = (
  identifier: t.Identifier,
  initializer: t.Node | null,
  scope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
  conditionallySkipped: boolean,
  writeSite?: t.Node,
): void => {
  const mutation = writeSite ?? initializer;
  if (mutation === null) return;
  const lookup = semanticBindingLookupFromScope(scope, identifier.name, state);
  if (lookup.kind === "captured" || lookup.kind === "implicit-arguments")
    return;
  const binding = "binding" in lookup ? lookup.binding : undefined;
  conditionallySkipped ||=
    lookup.kind !== "binding" && lookup.kind !== "ambient";
  if (binding === undefined) {
    // Unbound identifiers can denote host wrapper bindings (such as require),
    // which are separate from properties written through the global object.
    const writes = state.ambientBindingWrites.get(identifier.name) ?? [];
    writes.push(mutation);
    state.ambientBindingWrites.set(identifier.name, writes);
    return;
  }
  const writes = state.bindingWrites.get(binding.bindingId) ?? [];
  writes.push(mutation);
  state.bindingWrites.set(binding.bindingId, writes);
  binding.mutable = true;
  binding.definitions.push({ kind: "assignment", location: range(identifier) });
  if (initializer !== null)
    binding.initializers.push({ node: initializer, projection: [] });
  if (conditionallySkipped)
    state.conditionallySkippedExpressions.add(initializer ?? mutation);
};
