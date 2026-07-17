import { parse } from "@babel/parser";
import * as t from "@babel/types";

import {
  DEFAULT_JAVASCRIPT_SEMANTIC_LIMITS,
  failedJavaScriptSemanticIr,
  type JavaScriptModuleOrigin,
  type JavaScriptSemanticDefinition,
  type JavaScriptSemanticIr,
  type JavaScriptSemanticLimits,
} from "./javascriptSemanticIr.js";
import {
  collectSemanticModuleLink,
  collectSemanticCallable,
  collectSemanticReferences,
  immutableSemanticBindings,
  immutableSemanticScopes,
  reachSemanticLimit,
  semanticModuleOrigin,
  semanticStaticPropertyName,
} from "./javascriptSemanticProjection.js";
import type {
  JavaScriptSemanticAnalysisState,
  JavaScriptSemanticBindingState,
  JavaScriptSemanticScopeState,
} from "./javascriptSemanticState.js";
import {
  currentSemanticScope,
  semanticScopeId,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import {
  compareCodePoints,
  propertyName,
  range,
} from "./javascriptStaticAnalysisHelpers.js";

interface BindPatternInput {
  readonly pattern: t.Node;
  readonly initializer: t.Node | null;
  readonly scope: JavaScriptSemanticScopeState;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly mutable: boolean;
  readonly kind?: JavaScriptSemanticDefinition["kind"];
  readonly projection?: readonly (string | number | null)[];
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
  readonly projection?: readonly (string | number | null)[];
}

/** Recover bounded lexical bindings, aliases, constants, and module links. */
export const analyzeJavaScriptSemantics = (
  source: string,
  inputLimits: Partial<JavaScriptSemanticLimits> = {},
): JavaScriptSemanticIr => {
  const limits = { ...DEFAULT_JAVASCRIPT_SEMANTIC_LIMITS, ...inputLimits };
  let file: ReturnType<typeof parse>;
  try {
    file = parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: ["jsx", "typescript"],
    });
  } catch {
    return failedJavaScriptSemanticIr();
  }
  const state = createState(file.program, limits);
  collectDefinitions(file.program, state);
  const references = collectSemanticReferences(file.program, state);
  const parserPartial = file.errors.length > 0;
  return {
    schema: "JavaScriptSemanticIR",
    schemaVersion: 1,
    scopes: immutableSemanticScopes(state),
    bindings: immutableSemanticBindings(state),
    callables: [...state.callables],
    references,
    moduleLinks: [...state.moduleLinks],
    coverage: {
      status:
        state.limitsReached.size > 0
          ? "truncated"
          : parserPartial
            ? "partial"
            : "complete",
      omittedCount: state.limitsReached.size > 0 ? state.omittedCount : 0,
      limitsReached: [...state.limitsReached].sort(compareCodePoints),
    },
    limitations: [
      ...(parserPartial
        ? [
            "The parser recovered from syntax errors; affected bindings are partial.",
          ]
        : []),
      ...(state.limitsReached.size === 0
        ? []
        : ["Semantic recovery stopped retaining facts at explicit limits."]),
      "Values and aliases were recovered from inert syntax only; no JavaScript was executed.",
      "Cross-function mutation and dynamic property resolution remain unknown.",
    ],
  };
};

const createState = (
  program: t.Program,
  limits: JavaScriptSemanticLimits,
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
    limits,
    scopes: [root],
    scopesById: new Map([[root.scopeId, root]]),
    scopeByNode: new WeakMap([[program, root]]),
    bindingsById: new Map(),
    callables: [],
    moduleLinks: [],
    limitsReached: new Set(),
    omittedCount: 0,
  };
};

const collectDefinitions = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): void => {
  const stack: JavaScriptSemanticScopeState[] = [
    currentSemanticScope(state.scopes),
  ];
  const openedScopes = new WeakSet<t.Node>();
  traverseJavaScriptAst(program, {
    enter: (node, parent) => {
      const parentScope = currentSemanticScope(stack);
      bindOuterDeclaration(node, parentScope, state);
      const nested = nestedScope(node, parent, parentScope, state);
      if (nested !== undefined) {
        stack.push(nested);
        openedScopes.add(node);
      }
      const scope = currentSemanticScope(stack);
      state.scopeByNode.set(node, scope);
      collectSemanticCallable({
        node,
        parent,
        containerScope: parentScope,
        bodyScope: nested,
        state,
      });
      bindInnerDeclaration(node, parent, scope, state);
      collectSemanticModuleLink(node, state);
    },
    exit: (node) => {
      if (openedScopes.has(node)) stack.pop();
    },
  });
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
  else if (t.isVariableDeclarator(node))
    bindPattern({
      pattern: node.id,
      initializer: node.init ?? null,
      scope: variableScope(scope, parent, state),
      state,
      mutable:
        parent !== null && t.isVariableDeclaration(parent)
          ? parent.kind !== "const"
          : true,
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
  else if (t.isAssignmentExpression(node) && t.isIdentifier(node.left))
    addAssignment(node.left, node.right, scope, state);
};

const nestedScope = (
  node: t.Node,
  parent: t.Node | null,
  parentScope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticScopeState | undefined => {
  const kind = scopeKind(node, parent);
  if (kind === undefined) return undefined;
  if (state.scopes.length >= state.limits.maxScopes) {
    reachSemanticLimit(state, "maxScopes");
    return {
      scopeId: `${semanticScopeId(kind, node)}:omitted`,
      parentScopeId: parentScope.scopeId,
      kind,
      location: range(node),
      bindingsComplete: false,
      bindings: new Map(),
    };
  }
  const scope: JavaScriptSemanticScopeState = {
    scopeId: semanticScopeId(kind, node),
    parentScopeId: parentScope.scopeId,
    kind,
    location: range(node),
    bindingsComplete: true,
    bindings: new Map(),
  };
  state.scopes.push(scope);
  state.scopesById.set(scope.scopeId, scope);
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
    t.isBlockStatement(node) &&
    !(parent !== null && t.isFunction(parent) && parent.body === node)
  )
    return "block";
  return undefined;
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
    });
  }
};

const bindFunctionLocals = (
  node: t.Function,
  scope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
): void => {
  if (t.isFunctionExpression(node) && t.isIdentifier(node.id))
    addBinding({
      state,
      scope,
      name: node.id.name,
      kind: "function",
      mutable: false,
      definitionNode: node.id,
      initializer: node,
    });
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
  } = input;
  if (t.isTSParameterProperty(pattern)) {
    bindPattern({ ...input, pattern: pattern.parameter });
    return;
  }
  if (t.isIdentifier(pattern)) {
    const baseOrigin = semanticModuleOrigin(initializer, []);
    const directOrigin =
      baseOrigin === undefined || projection.includes(null)
        ? undefined
        : {
            ...baseOrigin,
            importedPath: [
              ...baseOrigin.importedPath,
              ...projection.map((segment) => String(segment)),
            ],
          };
    addBinding({
      state,
      scope,
      name: pattern.name,
      kind,
      mutable,
      definitionNode: pattern,
      initializer,
      ...(directOrigin === undefined ? {} : { directOrigin }),
      projection,
    });
    return;
  }
  if (t.isAssignmentPattern(pattern)) {
    bindPattern({
      ...input,
      pattern: pattern.left,
      initializer: initializer ?? pattern.right,
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
      if (t.isRestElement(property))
        bindPattern({
          ...input,
          pattern: property.argument,
          initializer: null,
          mutable: true,
          projection: [],
        });
      else {
        const name = semanticStaticPropertyName(
          property.key,
          property.computed,
        );
        bindPattern({
          ...input,
          pattern: property.value,
          projection: [...projection, name === "" ? null : name],
        });
      }
    }
  else if (t.isArrayPattern(pattern))
    pattern.elements.forEach((element, index) => {
      if (element !== null)
        bindPattern({
          ...input,
          pattern: element,
          projection: [...projection, index],
        });
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
    projection = [],
  } = input;
  let binding = scope.bindings.get(name);
  if (binding === undefined) {
    if (!scope.bindingsComplete) {
      state.omittedCount += 1;
      return;
    }
    if (state.bindingsById.size >= state.limits.maxBindings) {
      scope.bindingsComplete = false;
      reachSemanticLimit(state, "maxBindings");
      return;
    }
    binding = createBinding(scope, name, kind, mutable);
    scope.bindings.set(name, binding);
    state.bindingsById.set(binding.bindingId, binding);
  }
  binding.mutable ||= mutable;
  binding.definitions.push({ kind, location: range(definitionNode) });
  if (initializer !== null)
    binding.initializers.push({ node: initializer, projection });
  if (directOrigin !== undefined) binding.directOrigins.push(directOrigin);
};

const createBinding = (
  scope: JavaScriptSemanticScopeState,
  name: string,
  kind: JavaScriptSemanticDefinition["kind"],
  mutable: boolean,
): JavaScriptSemanticBindingState => ({
  bindingId: `${scope.scopeId}:binding:${encodeURIComponent(name)}`,
  scopeId: scope.scopeId,
  name,
  kind,
  mutable,
  definitions: [],
  initializers: [],
  directOrigins: [],
});

const addAssignment = (
  identifier: t.Identifier,
  initializer: t.Expression,
  scope: JavaScriptSemanticScopeState,
  state: JavaScriptSemanticAnalysisState,
): void => {
  const binding = resolveFromScope(scope, identifier.name, state);
  if (binding === undefined) return;
  binding.mutable = true;
  binding.definitions.push({ kind: "assignment", location: range(identifier) });
  binding.initializers.push({ node: initializer, projection: [] });
};

const resolveFromScope = (
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

const variableScope = (
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
