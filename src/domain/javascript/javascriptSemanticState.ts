import * as t from "@babel/types";

import type { JavaScriptSemanticPropertyPath } from "./javascriptSemanticPropertyPaths.js";

import type {
  JavaScriptModuleOrigin,
  JavaScriptSemanticDefinition,
  JavaScriptSemanticModuleLink,
  JavaScriptSemanticCallable,
  JavaScriptSemanticScope,
} from "./javascriptSemanticIr.js";

/** Internal initializer plus a destructuring/member projection. */
interface JavaScriptSemanticInitializer {
  readonly node: t.Node;
  readonly projection: readonly (string | number | null)[];
  readonly entryBody?: t.BlockStatement;
}

/** Additional references from destructuring copies and possible defaults. */
interface JavaScriptSemanticReferenceInitializer extends JavaScriptSemanticInitializer {
  readonly copyKind?: "object-rest" | "array-rest";
  readonly copyProjectionOffset?: number;
  readonly copyExcludedKeys?: readonly string[];
  readonly copyStartIndex?: number;
  readonly fallbackSources?: readonly JavaScriptSemanticInitializer[];
  readonly requiredSources?: readonly JavaScriptSemanticInitializer[];
}

/** Mutable binding state used only while constructing the immutable IR. */
export interface JavaScriptSemanticBindingState {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly name: string;
  kind: JavaScriptSemanticDefinition["kind"];
  mutable: boolean;
  readonly mutatedPaths: JavaScriptSemanticPropertyPath[];
  readonly escapedPaths: {
    readonly path: JavaScriptSemanticPropertyPath;
    readonly node: t.Node | undefined;
  }[];
  readonly definitions: JavaScriptSemanticDefinition[];
  readonly initializers: JavaScriptSemanticInitializer[];
  readonly referenceInitializers: JavaScriptSemanticReferenceInitializer[];
  readonly directOrigins: JavaScriptModuleOrigin[];
}

/** Mutable lexical-scope state used only during AST recovery. */
export interface JavaScriptSemanticScopeState {
  readonly scopeId: string;
  readonly parentScopeId: string | null;
  readonly kind: JavaScriptSemanticScope["kind"];
  readonly location: JavaScriptSemanticScope["location"];
  bindingsComplete: boolean;
  readonly bindings: Map<string, JavaScriptSemanticBindingState>;
}

/** Shared state for semantic collection and evaluation. */
export interface JavaScriptSemanticAnalysisState {
  readonly parentsByNode: WeakMap<t.Node, t.Node>;
  readonly scopes: JavaScriptSemanticScopeState[];
  readonly scopesById: Map<string, JavaScriptSemanticScopeState>;
  /** Scope boundaries and descendant scopes resolved on demand. */
  readonly scopeByNode: WeakMap<t.Node, JavaScriptSemanticScopeState>;
  readonly bindingsById: Map<string, JavaScriptSemanticBindingState>;
  readonly callables: JavaScriptSemanticCallable[];
  readonly callableNodesById: Map<string, t.Node>;
  readonly moduleLinks: JavaScriptSemanticModuleLink[];
  readonly moduleLinkBindings: WeakMap<
    JavaScriptSemanticModuleLink,
    JavaScriptSemanticBindingState
  >;
  readonly conditionalInitializers: WeakSet<t.Node>;
}

/** Return the active scope from a non-empty construction stack. */
export const currentSemanticScope = (
  stack: readonly JavaScriptSemanticScopeState[],
): JavaScriptSemanticScopeState => {
  const scope = stack.at(-1);
  if (scope === undefined) throw new TypeError("Missing semantic scope");
  return scope;
};

/** Create a stable source-position identity for one lexical scope. */
export const semanticScopeId = (
  kind: JavaScriptSemanticScope["kind"],
  node: t.Node,
): string =>
  `scope:${kind}:${String(node.start ?? -1)}:${String(node.end ?? -1)}`;

/** Resolve one lexical name from the scope containing a node. */
export const resolveSemanticBindingState = (
  state: JavaScriptSemanticAnalysisState,
  node: t.Node,
  name: string,
): JavaScriptSemanticBindingState | undefined => {
  let scope = semanticScopeForNode(state, node);
  while (scope !== undefined) {
    const binding = scope.bindings.get(name);
    if (binding !== undefined) return binding;
    if (!scope.bindingsComplete) return undefined;
    scope =
      scope.parentScopeId === null
        ? undefined
        : state.scopesById.get(scope.parentScopeId);
  }
  return undefined;
};

/** Report whether an omitted binding scope blocks a trustworthy miss. */
export const semanticResolutionBlocked = (
  state: JavaScriptSemanticAnalysisState,
  node: t.Node,
  name: string,
): boolean => {
  let scope = semanticScopeForNode(state, node);
  while (scope !== undefined) {
    if (scope.bindings.has(name)) return false;
    if (!scope.bindingsComplete) return true;
    scope =
      scope.parentScopeId === null
        ? undefined
        : state.scopesById.get(scope.parentScopeId);
  }
  return false;
};

const semanticScopeForNode = (
  state: JavaScriptSemanticAnalysisState,
  node: t.Node,
): JavaScriptSemanticScopeState | undefined => {
  let candidate: t.Node | undefined = node;
  while (candidate !== undefined) {
    const scope = state.scopeByNode.get(candidate);
    if (scope !== undefined) {
      // Repeated references in a deep expression share this ancestry. Cache
      // the traversed path without eagerly indexing nodes never resolved.
      let descendant: t.Node | undefined = node;
      while (descendant !== undefined && descendant !== candidate) {
        state.scopeByNode.set(descendant, scope);
        descendant = state.parentsByNode.get(descendant);
      }
      return scope;
    }
    candidate = state.parentsByNode.get(candidate);
  }
  return undefined;
};

/** Resolve one name starting from an explicitly selected lexical scope. */
export const resolveSemanticBindingFromScope = (
  scope: JavaScriptSemanticScopeState,
  name: string,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticBindingState | undefined => {
  let candidate: JavaScriptSemanticScopeState | undefined = scope;
  while (candidate !== undefined) {
    const binding = candidate.bindings.get(name);
    if (binding !== undefined) return binding;
    if (!candidate.bindingsComplete) return undefined;
    candidate =
      candidate.parentScopeId === null
        ? undefined
        : state.scopesById.get(candidate.parentScopeId);
  }
  return undefined;
};

/** Select the function/program owner for a var declaration. */
export const semanticVariableScope = (
  scope: JavaScriptSemanticScopeState,
  parent: t.Node | null,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticScopeState => {
  if (!(parent !== null && t.isVariableDeclaration(parent, { kind: "var" })))
    return scope;
  let candidate = scope;
  while (candidate.kind === "block" || candidate.kind === "catch") {
    const outer =
      candidate.parentScopeId === null
        ? undefined
        : state.scopesById.get(candidate.parentScopeId);
    if (outer === undefined) break;
    candidate = outer;
  }
  return candidate;
};

/** Identify a global name only when no lexical or dynamic environment shadows it. */
export const isUnshadowedGlobal = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  name: string,
): boolean =>
  t.isIdentifier(node, { name }) &&
  resolveSemanticBindingState(state, node, name) === undefined &&
  !semanticResolutionBlocked(state, node, name);
