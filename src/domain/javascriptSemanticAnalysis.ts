import * as t from "@babel/types";

import {
  failedJavaScriptSemanticIr,
  type JavaScriptModuleOrigin,
  type JavaScriptSemanticDefinition,
  type JavaScriptSemanticIr,
} from "./javascriptSemanticIr.js";
import {
  collectSemanticModuleLink,
  collectSemanticCallable,
  collectSemanticReferences,
  immutableSemanticBindings,
  immutableSemanticScopes,
  semanticStaticPropertyName,
} from "./javascriptSemanticProjection.js";
import type {
  JavaScriptSemanticAnalysisState,
  JavaScriptSemanticBindingState,
  JavaScriptSemanticScopeState,
} from "./javascriptSemanticState.js";
import {
  currentSemanticScope,
  resolveSemanticBindingFromScope,
  semanticScopeId,
  semanticVariableScope,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import {
  collectSemanticReturns,
  resolveSemanticModuleCallables,
} from "./javascriptSemanticReturns.js";
import { collectJavaScriptDerivedSemantics } from "./javascriptSemanticDerivedAnalysis.js";
import { propertyName, range } from "./javascriptStaticAnalysisHelpers.js";
import { semanticCoverage } from "./javascriptSemanticCoverage.js";
import {
  parseJavaScriptSource,
  type ParsedJavaScriptSource,
} from "./javascriptSourceParser.js";

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

/** Recover lexical bindings, aliases, constants, and module links. */
export const analyzeJavaScriptSemantics = (
  source: string,
): JavaScriptSemanticIr => {
  const file = parseJavaScriptSource(source);
  return file === null
    ? failedJavaScriptSemanticIr()
    : analyzeParsedJavaScriptSemantics(file);
};

/** Recover semantics from an already parsed JavaScript artifact. */
export const analyzeParsedJavaScriptSemantics = (
  file: ParsedJavaScriptSource,
): JavaScriptSemanticIr => {
  const state = createState(file.program);
  collectDefinitions(file.program, state);
  traverseJavaScriptAst(file.program, {
    enter: (node) => collectSemanticModuleLink(node, state),
  });
  const references = collectSemanticReferences(file.program, state);
  const parserPartial = file.errors.length > 0;
  const bindings = immutableSemanticBindings(state);
  const callables = collectSemanticReturns(file.program, state, parserPartial);
  const moduleLinks = resolveSemanticModuleCallables(state, callables);
  const derived = collectJavaScriptDerivedSemantics(
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
    coverage: semanticCoverage(parserPartial),
    limitations: [
      ...(parserPartial
        ? [
            "The parser recovered from syntax errors; affected bindings are partial.",
          ]
        : []),
      "Values and aliases were recovered from inert syntax only; no JavaScript was executed.",
      "Return sites include only direct callable returns; nested callable returns remain separate.",
      "Local call, argument, return, and closure relations are static candidates and do not prove runtime invocation.",
      "Promise ownership covers explicit unshadowed Promise construction, static factories, aggregation, chaining, and await syntax only.",
      "Cross-function mutation and dynamic property resolution remain unknown.",
    ],
  };
};

const createState = (program: t.Program): JavaScriptSemanticAnalysisState => {
  const root: JavaScriptSemanticScopeState = {
    scopeId: semanticScopeId("program", program),
    parentScopeId: null,
    kind: "program",
    location: range(program),
    bindingsComplete: true,
    bindings: new Map(),
  };
  return {
    scopes: [root],
    scopesById: new Map([[root.scopeId, root]]),
    scopeByNode: new WeakMap([[program, root]]),
    bindingsById: new Map(),
    callables: [],
    callableNodesById: new Map(),
    moduleLinks: [],
  };
};

const collectDefinitions = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): void => {
  const stack: JavaScriptSemanticScopeState[] = [
    currentSemanticScope(state.scopes),
  ];
  const openedScopes = new WeakMap<t.Node, number>();
  traverseJavaScriptAst(program, {
    enter: (node, parent) => {
      let parentScope = currentSemanticScope(stack);
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
    },
    exit: (node) => {
      for (let count = openedScopes.get(node) ?? 0; count > 0; count--)
        stack.pop();
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
  else if (t.isAssignmentExpression(node)) {
    if (t.isIdentifier(node.left))
      addAssignment(node.left, node.right, scope, state);
    else
      for (const identifier of assignedPatternIdentifiers(node.left))
        addAssignment(identifier, node, scope, state);
  } else if (t.isUpdateExpression(node) && t.isIdentifier(node.argument))
    addAssignment(node.argument, node, scope, state);
  else if (t.isForOfStatement(node) || t.isForInStatement(node))
    for (const identifier of assignedPatternIdentifiers(node.left))
      addAssignment(identifier, node, scope, state);
};

const assignedPatternIdentifiers = (
  pattern: t.Node,
): readonly t.Identifier[] => {
  const identifiers: t.Identifier[] = [];
  const pending = [pattern];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if (t.isIdentifier(node)) identifiers.push(node);
    else if (t.isRestElement(node)) pending.push(node.argument);
    else if (t.isAssignmentPattern(node)) pending.push(node.left);
    else if (t.isArrayPattern(node)) {
      for (const element of node.elements)
        if (element !== null) pending.push(element);
    } else if (t.isObjectPattern(node)) {
      for (const property of node.properties)
        pending.push(
          t.isRestElement(property) ? property.argument : property.value,
        );
    }
  }
  return identifiers;
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
    parentScopeId: parentScope.scopeId,
    kind,
    location: range(switchOwner ?? node),
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
  if (t.isBlockStatement(node)) {
    if (parent !== null && t.isFunction(parent) && parent.body === node) {
      // Parameter expressions execute outside the body var environment. A
      // body-local declaration must never become visible to a default value
      // or a computed destructuring key.
      return parent.params.some(parameterHasExpressions)
        ? "function"
        : undefined;
    }
    return "block";
  }
  return undefined;
};

const parameterHasExpressions = (node: t.Node): boolean => {
  if (t.isAssignmentPattern(node)) return true;
  if (t.isTSParameterProperty(node))
    return parameterHasExpressions(node.parameter);
  if (t.isRestElement(node)) return parameterHasExpressions(node.argument);
  if (t.isArrayPattern(node))
    return node.elements.some(
      (element) => element !== null && parameterHasExpressions(element),
    );
  if (t.isObjectPattern(node))
    return node.properties.some((property) =>
      t.isRestElement(property)
        ? parameterHasExpressions(property.argument)
        : property.computed || parameterHasExpressions(property.value),
    );
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
    if (!scope.bindingsComplete) return;
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
