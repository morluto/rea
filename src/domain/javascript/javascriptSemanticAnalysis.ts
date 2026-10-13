import * as t from "@babel/types";

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
  semanticImportEqualsSpecifier,
  collectSemanticReferences,
  collectSemanticReferencesSteps,
  immutableSemanticBindings,
  immutableSemanticScopes,
} from "./javascriptSemanticProjection.js";
import {
  semanticObjectPatternKeys,
  semanticStaticPropertyKey,
  semanticWriteTargets,
} from "./javascriptAstValues.js";
import type {
  JavaScriptSemanticAnalysisState,
  JavaScriptSemanticBindingState,
  JavaScriptSemanticScopeState,
} from "./javascriptSemanticState.js";
import {
  currentSemanticScope,
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  resolveSemanticBindingFromScope,
  semanticBindingId,
  semanticScopeId,
  semanticStableInitializer,
  semanticVariableScope,
} from "./javascriptSemanticState.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAstSteps,
} from "./javascriptSemanticTraversal.js";
import { semanticRequireOrigin } from "./javascriptSemanticRequireOrigin.js";
import { collectSemanticMemberMutationsSteps } from "./javascriptSemanticMemberMutations.js";
import { indexJavaScriptAmbientWritesSteps } from "./javascriptSemanticAmbientWrites.js";
import { hasUncertainTypeOnlyModuleSideEffect } from "./javascriptModuleDeclaration.js";
import {
  collectSemanticReturns,
  resolveSemanticModuleCallables,
} from "./javascriptSemanticReturns.js";
import { collectJavaScriptDerivedSemanticsSteps } from "./javascriptSemanticDerivedAnalysis.js";
import { evaluateSemanticProvenance } from "./javascriptSemanticValues.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronExportPath,
  electronMemberPath,
  ELECTRON_MODULE,
} from "./javascriptElectronMemberWrites.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import { propertyName } from "./javascriptAstValues.js";
import { semanticCoverage } from "./javascriptSemanticCoverage.js";
import { semanticResourceLimitsIn } from "./javascriptSemanticResourceLimits.js";
import {
  parseJavaScriptSource,
  type ParsedJavaScriptSource,
} from "./javascriptSourceParser.js";

import { isJavaScriptRpcClientFactory } from "./javascriptRpcEndpoints.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { SemanticPropertyPathCoverage } from "./javascriptSemanticPropertyPaths.js";
import type { JavaScriptModuleResolutionMode } from "./javascriptModuleResolutionMode.js";

interface BindPatternInput {
  readonly pattern: t.Node;
  readonly initializer: t.Node | null;
  readonly scope: JavaScriptSemanticScopeState;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly mutable: boolean;
  readonly kind?: JavaScriptSemanticDefinition["kind"];
  readonly projection?: readonly (string | number | null)[];
  readonly referenceOnly?: boolean;
  readonly copyKind?: "object-rest" | "array-rest";
  readonly copyProjectionOffset?: number;
  readonly copyExcludedKeys?: readonly string[];
  readonly copyStartIndex?: number;
  readonly fallbackSources?: readonly {
    readonly node: t.Node;
    readonly projection: readonly (string | number | null)[];
  }[];
  readonly requiredSources?: readonly {
    readonly node: t.Node;
    readonly projection: readonly (string | number | null)[];
  }[];
}

interface AddBindingInput {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly scope: JavaScriptSemanticScopeState;
  readonly name: string;
  readonly kind: JavaScriptSemanticDefinition["kind"];
  readonly mutable: boolean;
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

/** Share the lexical index with bounded, demand-driven boundary analyses. */
export function* indexJavaScriptBindingsSteps(
  program: t.Program,
): Generator<void, JavaScriptSemanticAnalysisState> {
  const state = createState(program);
  yield* collectDefinitionsSteps(program, state);
  yield* indexJavaScriptAmbientWritesSteps(program, state);
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
): Generator<void, JavaScriptSemanticIr> {
  const state = createState(file.program, staticImportResolutionMode);
  yield* collectDefinitionsSteps(file.program, state);
  yield* collectSemanticMemberMutationsSteps(file.program, state);
  yield* traverseJavaScriptAstSteps(file.program, {
    enter: (node) => collectSemanticModuleLink(node, state),
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
    parserPartial,
  );
  return {
    schema: "JavaScriptSemanticIR",
    scopes: immutableSemanticScopes(state),
    bindings,
    callables,
    references,
    moduleLinks,
    ...derived,
    coverage: semanticCoverage(
      parserPartial,
      semanticResourceLimitsIn([
        ...bindings.map(({ value }) => value),
        ...callables.flatMap((callable) =>
          callable.returnSites.map(({ value }) => value),
        ),
      ]),
    ),
    limitations: [
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

/** Resolve tRPC client roots by lexical identity, excluding overwritten bindings. */
export function* classifyParsedJavaScriptRpcClientRootsSteps(
  file: ParsedJavaScriptSource,
): Generator<void, ReadonlySet<t.Node>> {
  const state = createState(file.program);
  yield* collectDefinitionsSteps(file.program, state);
  const roots = new Set<t.Node>();
  const clients = new Map<string, boolean>();
  yield* traverseJavaScriptAstSteps(file.program, {
    enter: (node) => {
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
    },
  });
  return roots;
}

/**
 * Receiver identity facts for the overloaded `.open` syntax, plus
 * `configuration` for `.get` reads of a `getConfiguration(...)` result.
 */
export type JavaScriptOpenReceiverFact =
  | "window"
  | "indexed-db"
  | "cache-storage"
  | "local"
  | "local-indexed-db"
  | "local-cache-storage"
  | "configuration";

/**
 * Resolve only the lexical receiver identity needed to distinguish browser
 * `window.open` from XHR and global storage `.open` calls, and configuration
 * `.get` reads from HTTP client calls. This deliberately builds definitions
 * without running semantic value or provenance analysis.
 */
export const classifyParsedJavaScriptOpenReceivers = (
  file: ParsedJavaScriptSource,
): ReadonlyMap<number, JavaScriptOpenReceiverFact> =>
  completeSemanticSteps(classifyParsedJavaScriptOpenReceiversSteps(file));

/** Classify `.open` receivers while yielding during lexical and AST scans. */
export function* classifyParsedJavaScriptOpenReceiversSteps(
  file: ParsedJavaScriptSource,
): Generator<void, ReadonlyMap<number, JavaScriptOpenReceiverFact>> {
  const state = createState(file.program);
  yield* collectDefinitionsSteps(file.program, state);
  const facts = new Map<number, JavaScriptOpenReceiverFact>();
  yield* traverseJavaScriptAstSteps(file.program, {
    enter: (node) => {
      if (
        (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) ||
        (!t.isMemberExpression(node.callee) &&
          !t.isOptionalMemberExpression(node.callee))
      )
        return;
      const method = semanticStaticPropertyKey(
        node.callee.property,
        node.callee.computed,
      );
      if (method === "get") {
        if (isConfigurationReceiver(state, node.callee.object))
          facts.set(node.start ?? -1, "configuration");
        return;
      }
      if (method !== "open" || !t.isIdentifier(node.callee.object)) return;
      const receiver = node.callee.object.name;
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
      const initializer = binding.initializers[0]?.node;
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
          const nested = initializerBinding.initializers[0]?.node;
          if (t.isIdentifier(nested)) {
            const nestedFact = resolveGlobalAliasFact(
              state,
              initializer,
              nested.name,
            );
            if (nestedFact !== undefined)
              facts.set(node.start ?? -1, nestedFact);
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
    },
  });
  return facts;
}

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
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
    return false;
  const callee = node.callee;
  if (
    (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) ||
    semanticStaticPropertyKey(callee.property, callee.computed) !==
      "getConfiguration"
  )
    return false;
  const host = callee.object;
  const matchesSpelling = t.isIdentifier(host)
    ? host.name === "workspace"
    : (t.isMemberExpression(host) || t.isOptionalMemberExpression(host)) &&
      semanticStaticPropertyKey(host.property, host.computed) === "workspace";
  if (!matchesSpelling) return false;
  const root = t.isIdentifier(host)
    ? host
    : t.isMemberExpression(host) || t.isOptionalMemberExpression(host)
      ? host.object
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

/**
 * Proven Electron export path segments for call and construction roots, keyed by
 * root offset. Only proven Electron origins are present; callers must not
 * infer an Electron export from an absent entry or familiar local name.
 */
export const classifyParsedJavaScriptElectronBindings = (
  file: ParsedJavaScriptSource,
): ReadonlyMap<number, readonly string[]> =>
  completeSemanticSteps(classifyParsedJavaScriptElectronBindingsSteps(file));

/** Resolve Electron aliases while yielding during lexical and AST scans. */
export function* classifyParsedJavaScriptElectronBindingsSteps(
  file: ParsedJavaScriptSource,
): Generator<void, ReadonlyMap<number, readonly string[]>> {
  const state = createState(file.program);
  yield* collectDefinitionsSteps(file.program, state);
  return (yield* indexJavaScriptElectronIdentitySteps(file.program, state))
    .bindings;
}

/** Shared lexical identity and visible-write proof for direct and wrapped calls. */
export interface JavaScriptElectronIdentity {
  readonly bindings: ReadonlyMap<number, readonly string[]>;
  readonly intactExport: (path: readonly (string | null)[]) => boolean;
  readonly exportPath: (root: t.Node) => readonly string[] | undefined;
}

export function* indexJavaScriptElectronIdentitySteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, JavaScriptElectronIdentity> {
  const facts = new Map<number, readonly string[]>();
  const interop = createSemanticModuleInterop(state);
  const writes = new SemanticPropertyPathCoverage();
  let collectedWrites = false;
  const exportsByBinding = new Map<string, readonly string[] | null>();
  const rootExport = (root: t.Node): readonly string[] | undefined => {
    if (t.isIdentifier(root)) {
      if (semanticResolutionBlocked(state, root, root.name)) return undefined;
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (binding === undefined) return undefined;
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
        ? semanticRequireOrigin(root, state)?.origin
        : collectedWrites && interop.invalidatedCall(root)
          ? undefined
          : wrapped.origin;
    return origin !== undefined && ELECTRON_MODULE.test(origin.specifier)
      ? electronExportPath(origin.importedPath)
      : undefined;
  };
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    (node, kind) => {
      if (kind === "opaque-call") return [interop.opaqueMutationPath(node)];
      const { root, members } = electronMemberPath(node);
      const exported = kind === "binding" ? undefined : rootExport(root);
      const path =
        exported === undefined
          ? (interop.intrinsicPath(root) ??
            (kind === "member"
              ? interop.boundIntrinsic(root)?.path
              : undefined))
          : ["electron", ...exported];
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
  yield* traverseJavaScriptAstSteps(program, {
    enter: (node) => {
      if (
        !t.isCallExpression(node) &&
        !t.isOptionalCallExpression(node) &&
        !t.isNewExpression(node)
      )
        return;
      const { root, members } = electronMemberPath(node.callee);
      const exported = rootExport(root);
      if (
        exported !== undefined &&
        intactExport(["electron", ...exported, ...members])
      )
        facts.set(root.start ?? -1, exported);
    },
  });
  return { bindings: facts, intactExport, exportPath: rootExport };
}

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
  const origin = semanticRequireOrigin(initializer.node, state)?.origin;
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
    staticImportResolutionMode,
    parentsByNode: new WeakMap(),
    scopes: [root],
    scopesById: new Map([[root.scopeId, root]]),
    scopeByNode: new WeakMap([[program, root]]),
    bindingsById: new Map(),
    callables: [],
    callableNodesById: new Map(),
    moduleLinks: [],
    linkedRequireCalls: new WeakSet(),
    moduleLinkBindings: new WeakMap(),
    conditionalInitializers: new WeakSet(),
    ambientWrites: new SemanticPropertyPathCoverage(),
  };
};

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
  }[] = [];
  const functionBodies: {
    readonly body: t.BlockStatement;
    readonly scope: JavaScriptSemanticScopeState;
    readonly parameters: t.Function["params"];
  }[] = [];
  yield* traverseJavaScriptAstSteps(program, {
    enter: (node, parent, readAncestors) => {
      if (parent !== null) state.parentsByNode.set(node, parent);
      let parentScope = currentSemanticScope(stack);
      if (
        parent !== null &&
        (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
        parent.computed &&
        parent.key === node &&
        parentScope.parentScopeId !== null
      ) {
        // A computed method key is evaluated before entering the method's
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
        };
        state.scopes.push(dynamicScope);
        state.scopesById.set(dynamicScope.scopeId, dynamicScope);
        stack.push(dynamicScope);
        openedScopes.set(node, 1);
        parentScope = dynamicScope;
      }
      bindOuterDeclaration(node, parentScope, state);
      const nested = nestedScope(node, parent, parentScope, state);
      if (nested !== undefined) {
        stack.push(nested);
        openedScopes.set(node, (openedScopes.get(node) ?? 0) + 1);
        if (t.isBlockStatement(node) && t.isFunction(parent))
          functionBodies.push({
            body: node,
            scope: nested,
            parameters: parent.params,
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
        t.isVariableDeclarator(node) &&
        node.init != null &&
        parent !== null &&
        t.isVariableDeclaration(parent, { kind: "var" }) &&
        hasConditionalInitializer(readAncestors())
      )
        state.conditionalInitializers.add(node.init);
      if (
        t.isAssignmentExpression(node) ||
        t.isUpdateExpression(node) ||
        t.isForOfStatement(node) ||
        t.isForInStatement(node)
      )
        assignments.push({ node, scope });
    },
    exit: (node) => {
      for (let count = openedScopes.get(node) ?? 0; count > 0; count--)
        stack.pop();
    },
  });
  // All declarations must exist before resolving writes, including hoisted
  // functions and local declarations that shadow an outer binding.
  for (const [index, { node, scope }] of assignments.entries()) {
    if (index % 64 === 0) yield;
    bindAssignment(node, scope, state);
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

const hasConditionalInitializer = (ancestors: readonly t.Node[]): boolean => {
  // A hoisted var can remain undefined when control flow skips its initializer.
  // Conditions outside the owning callable/static block do not govern its body.
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const node = ancestors[index];
    if (t.isFunction(node) || t.isProgram(node) || t.isStaticBlock(node))
      return false;
    if (
      t.isIfStatement(node) ||
      t.isLoop(node) ||
      t.isSwitchCase(node) ||
      t.isTryStatement(node)
    )
      return true;
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
    });
  else if (t.isClassExpression(node) && t.isIdentifier(node.id))
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

const bindAssignment = (
  node: t.Node,
  scope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
): void => {
  if (t.isAssignmentExpression(node)) {
    if (t.isIdentifier(node.left))
      addAssignment(
        node.left,
        node.operator === "=" ||
          node.operator === "||=" ||
          node.operator === "??="
          ? node.right
          : node,
        scope,
        state,
      );
    else
      for (const identifier of semanticWriteTargets(node.left))
        if (t.isIdentifier(identifier))
          addAssignment(identifier, node, scope, state);
  } else if (t.isUpdateExpression(node) && t.isIdentifier(node.argument))
    addAssignment(node.argument, node, scope, state);
  else if (t.isForOfStatement(node) || t.isForInStatement(node))
    for (const pattern of t.isVariableDeclaration(node.left)
      ? node.left.declarations.map(({ id }) => id)
      : [node.left]) {
      for (const identifier of semanticWriteTargets(pattern))
        if (t.isIdentifier(identifier))
          addAssignment(identifier, node, scope, state);
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
  const pending: t.Node[] = [...node.params];
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
  for (const specifier of node.specifiers) {
    const importedPath = t.isImportDefaultSpecifier(specifier)
      ? ["default"]
      : t.isImportNamespaceSpecifier(specifier)
        ? []
        : [propertyName(specifier.imported) || "[dynamic]"];
    addBinding({
      state,
      scope,
      name: specifier.local.name,
      kind: "import",
      mutable: false,
      definitionNode: specifier.local,
      initializer: null,
      directOrigin: { specifier: node.source.value, importedPath },
      runtimeImport:
        node.importKind !== "type" &&
        node.importKind !== "typeof" &&
        (!t.isImportSpecifier(specifier) ||
          (specifier.importKind !== "type" &&
            specifier.importKind !== "typeof")),
    });
  }
};

const bindFunctionLocals = (
  node: t.Function,
  scope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
): void => {
  for (const parameter of node.params)
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

const bindPattern = (input: BindPatternInput): void => {
  const {
    pattern,
    initializer,
    scope,
    state,
    mutable,
    kind = "variable",
    projection = [],
    referenceOnly = false,
    copyKind,
    copyProjectionOffset,
    copyExcludedKeys,
    copyStartIndex,
    fallbackSources,
    requiredSources,
  } = input;
  if (t.isTSParameterProperty(pattern)) {
    bindPattern({ ...input, pattern: pattern.parameter });
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
          ...(copyKind === undefined ? {} : { copyKind }),
          ...(copyProjectionOffset === undefined
            ? {}
            : { copyProjectionOffset }),
          ...(copyExcludedKeys === undefined ? {} : { copyExcludedKeys }),
          ...(copyStartIndex === undefined ? {} : { copyStartIndex }),
          ...(fallbackSources === undefined ? {} : { fallbackSources }),
          ...(requiredSources === undefined ? {} : { requiredSources }),
        });
      return;
    }
    addBinding({
      state,
      scope,
      name: pattern.name,
      kind,
      mutable,
      definitionNode: pattern,
      initializer,
      projection,
    });
    return;
  }
  if (t.isAssignmentPattern(pattern)) {
    bindPattern({
      ...input,
      pattern: pattern.left,
      initializer:
        kind === "parameter" || kind === "catch"
          ? initializer
          : (initializer ?? pattern.right),
      requiredSources: [
        ...(requiredSources ?? []),
        ...(initializer === null ? [] : [{ node: initializer, projection }]),
      ],
    });
    bindPattern({
      state,
      scope,
      mutable,
      kind,
      pattern: pattern.left,
      initializer: pattern.right,
      projection: [],
      referenceOnly: true,
      fallbackSources: [
        ...(fallbackSources ?? []),
        ...(initializer === null ? [] : [{ node: initializer, projection }]),
      ],
      ...(requiredSources === undefined ? {} : { requiredSources }),
    });
    return;
  }
  if (t.isRestElement(pattern)) {
    bindPattern({
      ...input,
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
          ...input,
          pattern: property.argument,
          initializer: null,
          mutable: true,
          projection: [],
        });
        bindPattern({
          ...input,
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
          ...input,
          pattern: property.value,
          projection: [...projection, name],
        });
      }
    }
  else if (t.isArrayPattern(pattern))
    pattern.elements.forEach((element, index) => {
      if (element !== null) {
        bindPattern({
          ...input,
          pattern: element,
          projection: [...projection, index],
        });
        if (t.isRestElement(element))
          bindPattern({
            ...input,
            pattern: element.argument,
            projection: [...projection, null],
            referenceOnly: true,
            copyKind: "array-rest",
            copyProjectionOffset: projection.length,
            copyStartIndex: index,
          });
      }
    });
};

const addBinding = (input: AddBindingInput): void => {
  const {
    state,
    scope,
    name,
    kind,
    mutable,
    definitionNode,
    initializer,
    directOrigin,
    runtimeImport,
    projection = [],
  } = input;
  let binding = scope.bindings.get(name);
  if (binding === undefined) {
    if (!scope.bindingsComplete) return;
    binding = createBinding(scope, name, kind, mutable);
    scope.bindings.set(name, binding);
    state.bindingsById.set(binding.bindingId, binding);
  }
  binding.mutable ||= mutable;
  binding.definitions.push({ kind, location: range(definitionNode) });
  if (initializer !== null)
    binding.initializers.push({ node: initializer, projection });
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
  mutatedPaths: [],
  escapedPaths: [],
  definitions: [],
  initializers: [],
  referenceInitializers: [],
  directOrigins: [],
  runtimeImport: false,
});

const addAssignment = (
  identifier: t.Identifier,
  initializer: t.Node,
  scope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
): void => {
  const binding = resolveSemanticBindingFromScope(
    scope,
    identifier.name,
    state,
  );
  if (binding === undefined) return;
  binding.mutable = true;
  binding.definitions.push({ kind: "assignment", location: range(identifier) });
  binding.initializers.push({ node: initializer, projection: [] });
};
