import type * as t from "@babel/types";

import type {
  JavaScriptModuleOrigin,
  JavaScriptSemanticDefinition,
  JavaScriptSemanticLimits,
  JavaScriptSemanticModuleLink,
  JavaScriptSemanticCallable,
  JavaScriptSemanticScope,
} from "./javascriptSemanticIr.js";

/** Internal initializer plus a destructuring/member projection. */
interface JavaScriptSemanticInitializer {
  readonly node: t.Node;
  readonly projection: readonly (string | number | null)[];
}

/** Mutable binding state used only while constructing the immutable IR. */
export interface JavaScriptSemanticBindingState {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly name: string;
  kind: JavaScriptSemanticDefinition["kind"];
  mutable: boolean;
  readonly definitions: JavaScriptSemanticDefinition[];
  readonly initializers: JavaScriptSemanticInitializer[];
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

/** Shared bounded state for semantic collection and evaluation. */
export interface JavaScriptSemanticAnalysisState {
  readonly limits: JavaScriptSemanticLimits;
  readonly scopes: JavaScriptSemanticScopeState[];
  readonly scopesById: Map<string, JavaScriptSemanticScopeState>;
  readonly scopeByNode: WeakMap<t.Node, JavaScriptSemanticScopeState>;
  readonly bindingsById: Map<string, JavaScriptSemanticBindingState>;
  readonly callables: JavaScriptSemanticCallable[];
  readonly moduleLinks: JavaScriptSemanticModuleLink[];
  readonly limitsReached: Set<keyof JavaScriptSemanticLimits>;
  omittedCount: number;
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
  let scope = state.scopeByNode.get(node);
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
  let scope = state.scopeByNode.get(node);
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
