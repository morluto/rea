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
} from "./javascriptElectronMemberWrites.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticCoverage,
  RETURNED_REFERENCE_WIDENING_LIMITATION,
} from "./javascriptSemanticCoverage.js";
import {
  SEMANTIC_ALIAS_SELECTION_LIMIT,
  semanticResourceLimitReason,
} from "./javascriptSemanticResourceLimits.js";
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
  semanticObjectPropertyReferences,
} from "./javascriptSemanticObjectReferences.js";
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
): JavaScriptSemanticIr => {
  const file = parseJavaScriptSource(source);
  return file === null
    ? failedJavaScriptSemanticIr()
    : analyzeParsedJavaScriptSemantics(file);
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
): Generator<void, JavaScriptSemanticAnalysisState> {
  const state = createState(program);
  yield* collectDefinitionsSteps(program, state);
  yield* indexSemanticAmbientWritesSteps(state);
  return state;
}

/** Recover semantics from an already parsed JavaScript artifact. */
export const analyzeParsedJavaScriptSemantics = (
  file: ParsedJavaScriptSource,
  staticImportResolutionMode: JavaScriptModuleResolutionMode = "import",
): JavaScriptSemanticIr =>
  completeSemanticSteps(
    analyzeParsedJavaScriptSemanticsSteps(file, staticImportResolutionMode),
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
): Generator<void, JavaScriptSemanticIr> {
  const state = createState(file.program, staticImportResolutionMode);
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
        ? [semanticResourceLimitReason("alias-selections")]
        : []),
      ...(state.returnedReferenceWidenings.size > 0
        ? [RETURNED_REFERENCE_WIDENING_LIMITATION]
        : []),
      ...[...state.getterResourceLimits]
        .sort()
        .map(semanticResourceLimitReason),
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
): Generator<void, JavaScriptReceiverIndex> {
  const state = createState(program);
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

interface ElectronMemberWriteCandidate {
  readonly node: t.Node;
  readonly suffix: JavaScriptSemanticPropertyPath;
  readonly readAt?: t.Node | undefined;
  readonly capturedSelections?:
    | readonly SemanticCapturedSelection[]
    | undefined;
  readonly awaitDepths?: readonly number[] | undefined;
  readonly iteratedDepths?: readonly number[] | undefined;
  readonly iteratedElementDepths?: readonly number[] | undefined;
  readonly callFrame?: ElectronMemberWriteCallFrame | undefined;
}

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
  if (matchingFrame === undefined) return undefined;
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
    if (outerFrame === undefined) return undefined;
    currentFrame = outerFrame;
  }
};

const normalizeCandidateCaptures = (
  captures: readonly SemanticCapturedSelection[] | undefined,
  callFrame: ElectronMemberWriteCallFrame | undefined,
  suffixLength: number,
  state: JavaScriptSemanticAnalysisState,
): readonly SemanticCapturedSelection[] | undefined => {
  if (captures === undefined || captures.length === 0) return undefined;
  const resolved: SemanticCapturedSelection[] = [];
  for (const capture of captures) {
    const at =
      enclosingActivationFunction(capture.at, state) === undefined
        ? capture.at
        : memberSelectionCaptureSite(capture.at, callFrame, state);
    if (at !== undefined) resolved.push({ ...capture, at });
  }
  return semanticNormalizeCapturedSelections(resolved, suffixLength);
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
      : (memberSelectionCaptureSite(callSite, callFrame, state) ?? callSite);
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
      : (memberSelectionCaptureSite(callSite, callFrame, state) ?? callSite);
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
          iterable,
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
            capturedSelections: [{ at: iterable, depth: 1 }],
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
                  capturedSelections: [{ at: iterable, depth: 1 }],
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
              iterable,
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
              iterable,
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
    if (intrinsic?.kind === "known") {
      const [ns, obj, method] = intrinsic.path;
      const callArgs = intrinsic.arguments ?? [];
      if (
        ns === "intrinsic" &&
        obj === "Object" &&
        (method === "freeze" ||
          method === "seal" ||
          method === "preventExtensions")
      ) {
        const [target] = callArgs;
        if (target !== undefined && t.isExpression(target))
          pending.push({ ...current, node: target, capturedSelections });
        return;
      }
      if (ns === "intrinsic" && obj === "Object" && method === "assign") {
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
                  { at: src.argument, depth: 2, ownEnumerable: true },
                ],
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
                { at: src, depth: 1, ownEnumerable: true },
              ],
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
      if (
        ns === "intrinsic" &&
        obj === "Object" &&
        method === "values" &&
        current.suffix.length > 0 &&
        maySelectArrayElementSegment(current.suffix[0]!)
      ) {
        const [target] = callArgs;
        if (target !== undefined && t.isExpression(target)) {
          const remainingSuffix = current.suffix.slice(1);
          const readAt = current.readAt ?? node;
          const targetCapturedSelections: readonly SemanticCapturedSelection[] =
            [
              ...(capturedSelections ?? []),
              { at: target, depth: 1, ownEnumerable: true },
            ];
          const resolvedValuesTarget = resolveSingleExpressionInCallFrame(
            target,
            node,
            current.callFrame,
            state,
          );
          const staticKeys = staticObjectValuesKeys(
            resolvedValuesTarget?.node ?? target,
            state,
            interop,
            resolvedValuesTarget?.captureAt ?? node,
          );
          if (staticKeys !== undefined) {
            for (const seg of selectArrayFromInputSegments(
              current.suffix[0]!,
              staticKeys.length,
            )) {
              if (typeof seg === "number") {
                const key = staticKeys[seg];
                if (key !== undefined)
                  pending.push({
                    ...current,
                    node: target,
                    suffix: [key, ...remainingSuffix],
                    readAt,
                    capturedSelections: targetCapturedSelections,
                  });
              } else if (
                seg !== null &&
                typeof seg === "object" &&
                staticKeys.length <= SEMANTIC_ALIAS_SELECTION_LIMIT
              ) {
                for (
                  let idx = seg.startIndex ?? 0;
                  idx < staticKeys.length;
                  idx += 1
                ) {
                  if (!seg.excludedKeys.includes(String(idx)))
                    pending.push({
                      ...current,
                      node: target,
                      suffix: [staticKeys[idx]!, ...remainingSuffix],
                      readAt,
                      capturedSelections: targetCapturedSelections,
                    });
                }
              } else if (
                seg === null &&
                staticKeys.length <= SEMANTIC_ALIAS_SELECTION_LIMIT
              ) {
                for (const key of staticKeys)
                  pending.push({
                    ...current,
                    node: target,
                    suffix: [key, ...remainingSuffix],
                    readAt,
                    capturedSelections: targetCapturedSelections,
                  });
              } else {
                pending.push({
                  ...current,
                  node: target,
                  suffix: [null, ...remainingSuffix],
                  readAt,
                  capturedSelections: targetCapturedSelections,
                });
              }
            }
            return;
          }
          const denseLen = denseKnownArrayLengthAt(
            resolvedValuesTarget?.node ?? target,
            state,
            resolvedValuesTarget?.captureAt ?? node,
          );
          if (denseLen !== undefined) {
            for (const seg of selectArrayFromInputSegments(
              current.suffix[0]!,
              denseLen,
            ))
              pending.push({
                ...current,
                node: target,
                suffix: [seg, ...remainingSuffix],
                readAt,
                capturedSelections: targetCapturedSelections,
              });
            return;
          }
          pending.push({
            node: target,
            suffix: [null, ...remainingSuffix],
            readAt,
            capturedSelections: targetCapturedSelections,
            callFrame: current.callFrame,
          });
        }
        return;
      }
      if (ns === "intrinsic" && obj === "Array" && method === "from") {
        if (
          current.suffix.length > 0 &&
          maySelectArrayElementSegment(current.suffix[0]!)
        ) {
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
                  interop,
                  effectiveIterableCaptureAt,
                )
              : undefined;
          const positional = knownArrayIter || arrayLike !== undefined;
          const knownLength = knownArrayIter
            ? denseArrayLen
            : arrayLike?.knownLength;
          const inputSegments = positional
            ? selectArrayFromInputSegments(current.suffix[0]!, knownLength)
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
                    { at: iterable.argument, depth: 2 },
                  ],
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
                  callFrame: current.callFrame,
                },
              );
              return;
            }
            if (!t.isExpression(iterable)) return;
            const iterableCapturedSelections: readonly SemanticCapturedSelection[] =
              [...(capturedSelections ?? []), { at: iterable, depth: 1 }];
            if (knownArrayIter) {
              for (const seg of inputSegments) {
                const nextSuffix = [seg, ...elementSuffix];
                pending.push({
                  ...current,
                  node: iterable,
                  suffix: nextSuffix,
                  readAt,
                  capturedSelections: iterableCapturedSelections,
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
                });
              return;
            }
            pending.push(
              {
                ...current,
                node: iterable,
                capturedSelections: iterableCapturedSelections,
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
              { ...current, suffix: elementSuffix },
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
          const isElementIterated =
            current.iteratedDepths?.includes(elementSuffix.length) === true;
          const isElementIteratedItem =
            current.iteratedElementDepths?.includes(elementSuffix.length) ===
            true;
          const isElementAwaited =
            current.awaitDepths?.includes(elementSuffix.length) === true;
          const mapped = isElementIterated
            ? returnQueries.potential(mapFn)
            : isElementAwaited
              ? returnQueries.awaited(mapFn)
              : returnQueries.direct(mapFn);
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
              { ...current, suffix: elementSuffix },
              pending,
            );
        }
        return;
      }
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
    const returned = isIterated
      ? returnQueries.potential(calleeNode, node)
      : isAwaited
        ? returnQueries.awaited(calleeNode, node)
        : returnQueries.direct(calleeNode, node);
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
    pending.push(
      {
        ...current,
        node: t.isConditionalExpression(node) ? node.consequent : node.left,
        capturedSelections,
      },
      {
        ...current,
        node: t.isConditionalExpression(node) ? node.alternate : node.right,
        capturedSelections,
      },
    );
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
    const filteredAwaitDepths = current.awaitDepths?.filter(
      (depth) => depth !== current.suffix.length,
    );
    for (const choice of semanticAliasSelectionChoices(key!)) {
      const sources = t.isObjectExpression(node)
        ? semanticObjectPropertyReferences(node, [choice], state)
        : semanticArrayPropertyReferences(node, [choice]);
      for (const source of sources) {
        if (
          source.inherited &&
          capturedSelections?.some(
            (capture) => capture.depth === 1 && capture.ownEnumerable,
          )
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
  interop: ReturnType<typeof createSemanticModuleInterop>,
  captureAt: t.Node = expr,
  visited: ReadonlySet<t.Node> = new Set(),
): t.ObjectExpression | undefined => {
  let node = unwrapJavaScriptExpression(expr).node;
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    const inv = interop.intrinsicInvocation(node);
    if (
      inv?.kind === "known" &&
      inv.path[0] === "intrinsic" &&
      inv.path[1] === "Object" &&
      (inv.path[2] === "freeze" ||
        inv.path[2] === "seal" ||
        inv.path[2] === "preventExtensions") &&
      inv.arguments?.[0] !== undefined &&
      t.isExpression(inv.arguments[0])
    )
      node = unwrapJavaScriptExpression(inv.arguments[0]).node;
  }
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
        interop,
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
  interop: ReturnType<typeof createSemanticModuleInterop>,
  captureAt: t.Node = expr,
): readonly string[] | undefined => {
  const obj = resolveUnmutatedObjectExpression(expr, state, interop, captureAt);
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
  interop: ReturnType<typeof createSemanticModuleInterop>,
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
        interop,
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
        !objectLiteralHasNoOwnIterator(
          spreadObj,
          state,
          interop,
          captureAt,
          nextVisited,
        )
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
  interop: ReturnType<typeof createSemanticModuleInterop>,
  captureAt: t.Node = expr,
): { readonly knownLength?: number } | undefined => {
  const obj = resolveUnmutatedObjectExpression(expr, state, interop, captureAt);
  if (
    obj === undefined ||
    !objectLiteralHasNoOwnIterator(obj, state, interop, captureAt, new Set())
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
): readonly JavaScriptSemanticPropertyPath[number][] => {
  if (knownLength !== undefined && knownLength <= 0) return [];
  if (segment === null) {
    if (
      knownLength !== undefined &&
      knownLength <= SEMANTIC_ALIAS_SELECTION_LIMIT
    ) {
      const indices: number[] = [];
      for (let idx = 0; idx < knownLength; idx += 1) indices.push(idx);
      return indices;
    }
    return [{ excludedKeys: [], startIndex: 0 }];
  }
  if (typeof segment === "object") {
    const startIndex = segment.startIndex ?? 0;
    if (knownLength !== undefined && startIndex >= knownLength) return [];
    if (
      knownLength !== undefined &&
      knownLength <= SEMANTIC_ALIAS_SELECTION_LIMIT
    ) {
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
  if (t.isConditionalExpression(node)) {
    return (
      objectAssignTargetAllowsOverwrite(
        node.consequent,
        choice,
        state,
        interop,
        captureAt,
        nextVisited,
      ) &&
      objectAssignTargetAllowsOverwrite(
        node.alternate,
        choice,
        state,
        interop,
        captureAt,
        nextVisited,
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
  let node = unwrapJavaScriptExpression(expr).node;
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    const inv = interop.intrinsicInvocation(node);
    if (
      inv?.kind === "known" &&
      inv.path[0] === "intrinsic" &&
      inv.path[1] === "Object" &&
      (inv.path[2] === "freeze" ||
        inv.path[2] === "seal" ||
        inv.path[2] === "preventExtensions") &&
      inv.arguments?.[0] !== undefined &&
      t.isExpression(inv.arguments[0])
    )
      node = unwrapJavaScriptExpression(inv.arguments[0]).node;
  }
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
  if (t.isConditionalExpression(node)) {
    const consequentKeys = definiteObjectAssignSourceKeys(
      node.consequent,
      state,
      interop,
      captureAt,
      nextVisited,
    );
    const alternateKeys = definiteObjectAssignSourceKeys(
      node.alternate,
      state,
      interop,
      captureAt,
      nextVisited,
    );
    return new Set([...consequentKeys].filter((k) => alternateKeys.has(k)));
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
  for (const source of snapshot.initializers) {
    if (inactiveDefaults?.has(source.node)) continue;
    if (semanticReferenceSourcesInactive(source, state)) continue;
    pending.push({
      node: source.node,
      suffix: [...source.projection, ...current.suffix],
      readAt: current.readAt ?? node,
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
        pending.push({
          node: source.node,
          suffix: [...copied, ...remaining],
          readAt: current.readAt ?? node,
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
  for (
    let frame = current.callFrame;
    frame !== undefined;
    frame = frame.parentFrame
  ) {
    const mappedArgs = frame.parameterSources.get(binding.bindingId);
    if (mappedArgs === undefined) continue;
    for (const argSource of mappedArgs) {
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
    if (!widened && selections >= SEMANTIC_ALIAS_SELECTION_LIMIT) {
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
            candidate.callFrame,
            candidate.suffix.length,
            state,
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
      addPath([...electronExportPath(bundled.importedPath), ...current.suffix]);
    const bindingRead = semanticBindingAtRead(binding, node, state);
    const snapshot = bindingRead.binding;
    for (const origin of snapshot.directOrigins)
      if (ELECTRON_MODULE.test(origin.specifier))
        addPath([
          ...electronExportPath(origin.importedPath),
          ...current.suffix,
        ]);
    const projectedFacts = semanticProjectedSourceFactsAtRead(
      binding,
      node,
      current.suffix,
      state,
      false,
      current.readAt ?? node,
      capturedSelections,
    );
    const inactiveDefaults = inactiveDefaultNodesForBinding(
      binding.bindingId,
      current.callFrame,
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
