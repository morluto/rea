import * as t from "@babel/types";

import type {
  JavaScriptModuleOrigin,
  JavaScriptSemanticBinding,
  JavaScriptSemanticModuleLink,
  JavaScriptSemanticReference,
  JavaScriptSemanticScope,
} from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  isUnshadowedGlobal,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticScopeState,
} from "./javascriptSemanticState.js";
import { compareCodePoints } from "./canonicalOrdering.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import {
  evaluateSemanticBinding,
  evaluateSemanticProvenance,
} from "./javascriptSemanticValues.js";
import {
  propertyName,
  range,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import { semanticStaticPropertyName } from "./javascriptAstValues.js";

interface CollectCallableInput {
  readonly node: t.Node;
  readonly parent: t.Node | null;
  readonly containerScope: JavaScriptSemanticScopeState;
  readonly bodyScope: JavaScriptSemanticScopeState | undefined;
  readonly state: JavaScriptSemanticAnalysisState;
}

/** Retain callable identity without polluting lexical bindings. */
export const collectSemanticCallable = (input: CollectCallableInput): void => {
  const { node, parent, containerScope, bodyScope, state } = input;
  const kind = callableKind(node);
  if (kind === undefined) return;
  const callableId =
    semanticCallableIdForNode(node) ?? "callable:unknown:-1:-1";
  state.callables.push({
    callableId,
    kind,
    name: callableName(node, parent),
    containerScopeId: containerScope.scopeId,
    bodyScopeId:
      bodyScope === undefined || !bodyScope.bindingsComplete
        ? null
        : bodyScope.scopeId,
    location: range(node),
    returnSites: [],
    returnCoverage: {
      status: "partial",
      retainedCount: 0,
      omittedCount: null,
    },
  });
  state.callableNodesById.set(callableId, node);
};

/** Collect one static import/export relationship for later composition. */
export const collectSemanticModuleLink = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): void => {
  if (t.isImportDeclaration(node)) collectImports(node, state);
  else if (t.isExportAllDeclaration(node))
    addModuleLink(state, {
      kind: "re-export",
      specifier: node.source.value,
      importedName: "*",
      localName: null,
      exportedName: "*",
      location: range(node),
    });
  else if (t.isExportNamedDeclaration(node)) collectNamedExports(node, state);
  else if (t.isExportDefaultDeclaration(node))
    addModuleLink(state, {
      kind: "export",
      specifier: null,
      importedName: null,
      localName: defaultDeclarationName(node.declaration),
      exportedName: "default",
      callableId: semanticCallableIdForNode(node.declaration),
      location: range(node),
    });
  else if (t.isVariableDeclarator(node)) collectRequireLink(node, state);
  else if (t.isAssignmentExpression(node)) collectCommonJsExport(node, state);
};

/** Collect bounded lexical identifier references after definitions exist. */
export const collectSemanticReferences = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticReference[] => {
  const output: JavaScriptSemanticReference[] = [];
  const seen = new Set<string>();
  traverseJavaScriptAst(program, {
    enter: (node, parent, ancestors) => {
      if (!t.isIdentifier(node) || parent === null) return;
      const role = semanticIdentifierRole(node, parent, ancestors);
      if (role === null) return;
      // A compound assignment or update reads before it writes; emit both so
      // reference consumers see the read they actually execute.
      const roles =
        role === "write" && semanticReadsBeforeWrite(node, parent)
          ? (["read", "write"] as const)
          : ([role] as const);
      for (const resolvedRole of roles) {
        const key = `${String(node.start)}:${resolvedRole}:${node.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const binding = resolveSemanticBindingState(state, node, node.name);
        const blocked =
          binding === undefined &&
          semanticResolutionBlocked(state, node, node.name);
        output.push({
          name: node.name,
          role: resolvedRole,
          location: range(node),
          bindingId: binding?.bindingId ?? null,
          resolution:
            binding !== undefined
              ? "resolved"
              : blocked
                ? "unknown"
                : "unbound",
        });
      }
    },
  });
  return output;
};

/** Freeze collected scopes into deterministic IR order. */
export const immutableSemanticScopes = (
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticScope[] =>
  state.scopes.map((scope) => ({
    scopeId: scope.scopeId,
    parentScopeId: scope.parentScopeId,
    kind: scope.kind,
    location: scope.location,
    bindingsComplete: scope.bindingsComplete,
    bindingIds: [...scope.bindings.values()]
      .map(({ bindingId }) => bindingId)
      .sort(compareCodePoints),
  }));

/** Evaluate and freeze bindings into deterministic IR order. */
export const immutableSemanticBindings = (
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticBinding[] =>
  [...state.bindingsById.values()]
    .map((binding) => ({
      bindingId: binding.bindingId,
      scopeId: binding.scopeId,
      name: binding.name,
      kind: binding.kind,
      mutable: binding.mutable,
      definitions: binding.definitions,
      value: evaluateSemanticBinding(binding, state),
      provenance: evaluateSemanticProvenance(binding, state),
    }))
    .sort((left, right) => compareCodePoints(left.bindingId, right.bindingId));

/** Recover a literal require origin plus an optional member chain. */
const semanticModuleOrigin = (
  node: t.Node | null | undefined,
  projection: readonly (string | number | null)[],
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined => {
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const nested = t.isNode(node.object)
      ? semanticModuleOrigin(node.object, projection, state)
      : undefined;
    const member = semanticStaticPropertyName(node.property, node.computed);
    return nested === undefined || member === ""
      ? undefined
      : { ...nested, importedPath: [...nested.importedPath, member] };
  }
  if (
    !t.isCallExpression(node) ||
    !t.isIdentifier(node.callee, { name: "require" })
  )
    return undefined;
  if (
    resolveSemanticBindingState(state, node.callee, "require") !== undefined ||
    semanticResolutionBlocked(state, node.callee, "require")
  )
    return undefined;
  const specifier = stringValue(node.arguments[0]);
  return specifier === undefined || projection.includes(null)
    ? undefined
    : {
        specifier,
        importedPath: projection.map((segment) => String(segment)),
      };
};

export { semanticStaticPropertyName } from "./javascriptAstValues.js";

const callableKind = (
  node: t.Node,
): "function" | "class" | "method" | undefined => {
  if (
    t.isClassMethod(node) ||
    t.isClassPrivateMethod(node) ||
    t.isObjectMethod(node)
  )
    return "method";
  if (t.isFunction(node)) return "function";
  if (t.isClass(node)) return "class";
  return undefined;
};

const callableName = (node: t.Node, parent: t.Node | null): string | null => {
  if (
    (t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isClassDeclaration(node) ||
      t.isClassExpression(node)) &&
    t.isIdentifier(node.id)
  )
    return node.id.name;
  if (
    t.isClassMethod(node) ||
    t.isClassPrivateMethod(node) ||
    t.isObjectMethod(node)
  ) {
    if (t.isPrivateName(node.key)) return `#${node.key.id.name}`;
    // `{[key]() {}}` names nothing statically; reading `key` off the key node
    // would report the variable name as the method name.
    return (
      semanticStaticPropertyName(node.key, node.computed) ||
      `[computed@${String(node.start ?? -1)}]`
    );
  }
  if (
    parent !== null &&
    t.isVariableDeclarator(parent) &&
    t.isIdentifier(parent.id)
  )
    return parent.id.name;
  return null;
};

const collectImports = (
  node: t.ImportDeclaration,
  state: JavaScriptSemanticAnalysisState,
): void => {
  if (node.specifiers.length === 0)
    addModuleLink(state, {
      kind: "import",
      specifier: node.source.value,
      importedName: null,
      localName: null,
      exportedName: null,
      location: range(node),
    });
  for (const specifier of node.specifiers)
    addModuleLink(state, {
      kind: "import",
      specifier: node.source.value,
      importedName: t.isImportDefaultSpecifier(specifier)
        ? "default"
        : t.isImportNamespaceSpecifier(specifier)
          ? "*"
          : propertyName(specifier.imported),
      localName: specifier.local.name,
      exportedName: null,
      location: range(specifier),
    });
};

const collectNamedExports = (
  node: t.ExportNamedDeclaration,
  state: JavaScriptSemanticAnalysisState,
): void => {
  if (node.declaration !== null && node.declaration !== undefined)
    for (const localName of declarationNames(node.declaration))
      addModuleLink(state, {
        kind: "export",
        specifier: null,
        importedName: null,
        localName,
        exportedName: localName,
        callableId: declarationCallableId(node.declaration, localName),
        location: range(node.declaration),
      });
  for (const specifier of node.specifiers)
    if (t.isExportSpecifier(specifier))
      addModuleLink(state, {
        kind: node.source == null ? "export" : "re-export",
        specifier: node.source?.value ?? null,
        importedName: propertyName(specifier.local),
        localName: node.source == null ? propertyName(specifier.local) : null,
        exportedName: propertyName(specifier.exported),
        location: range(specifier),
      });
};

const collectRequireLink = (
  node: t.VariableDeclarator,
  state: JavaScriptSemanticAnalysisState,
): void => {
  const origin = semanticModuleOrigin(node.init, [], state);
  if (origin === undefined) return;
  for (const binding of requirePatternBindings(node.id, origin.importedPath))
    addModuleLink(state, {
      kind: "require",
      specifier: origin.specifier,
      importedName: binding.importedName,
      localName: binding.localName,
      exportedName: null,
      location: range(node),
    });
};

const requirePatternBindings = (
  pattern: t.Node,
  path: readonly string[],
): { readonly importedName: string; readonly localName: string }[] => {
  if (t.isTSParameterProperty(pattern))
    return requirePatternBindings(pattern.parameter, path);
  if (t.isIdentifier(pattern))
    return [{ importedName: path.at(-1) ?? "*", localName: pattern.name }];
  if (t.isAssignmentPattern(pattern))
    return requirePatternBindings(pattern.left, path);
  if (t.isObjectPattern(pattern))
    return pattern.properties.flatMap((property) => {
      if (t.isRestElement(property)) return [];
      const name = semanticStaticPropertyName(property.key, property.computed);
      return name === ""
        ? []
        : requirePatternBindings(property.value, [...path, name]);
    });
  if (t.isArrayPattern(pattern))
    return pattern.elements.flatMap((element, index) =>
      element === null
        ? []
        : requirePatternBindings(element, [...path, String(index)]),
    );
  return [];
};

const collectCommonJsExport = (
  node: t.AssignmentExpression,
  state: JavaScriptSemanticAnalysisState,
): void => {
  const exportedName = commonJsExportName(node.left, state);
  if (exportedName === undefined) return;
  const origin = semanticModuleOrigin(node.right, [], state);
  addModuleLink(state, {
    kind: "commonjs-export",
    specifier: origin?.specifier ?? null,
    importedName: origin?.importedPath.at(-1) ?? null,
    localName: t.isIdentifier(node.right) ? node.right.name : null,
    exportedName,
    callableId: semanticCallableIdForNode(node.right),
    location: range(node),
  });
};

const addModuleLink = (
  state: JavaScriptSemanticAnalysisState,
  link: Omit<JavaScriptSemanticModuleLink, "callableId"> & {
    readonly callableId?: string | null;
  },
): void => {
  state.moduleLinks.push({ ...link, callableId: link.callableId ?? null });
};

/** Deterministic callable identity shared by collection and return recovery. */
export const semanticCallableIdForNode = (node: t.Node): string | null => {
  const kind = callableKind(node);
  return kind === undefined
    ? null
    : `callable:${kind}:${String(node.start ?? -1)}:${String(node.end ?? -1)}`;
};

const declarationCallableId = (
  declaration: t.Declaration,
  localName: string,
): string | null => {
  if (
    (t.isFunctionDeclaration(declaration) ||
      t.isClassDeclaration(declaration)) &&
    declaration.id?.name === localName
  )
    return semanticCallableIdForNode(declaration);
  if (!t.isVariableDeclaration(declaration)) return null;
  const declarator = declaration.declarations.find(({ id }) =>
    t.isIdentifier(id, { name: localName }),
  );
  return declarator?.init === null || declarator?.init === undefined
    ? null
    : semanticCallableIdForNode(declarator.init);
};

/**
 * True when writing `node` also reads it first: a compound assignment
 * (`+=`, `||=`, …) or an update (`++`/`--`). A plain `=` writes only.
 *
 * One predicate serves both member operations and identifier references so the
 * two can never disagree about what counts as a read-modify-write.
 */
export const semanticReadsBeforeWrite = (
  node: t.Node,
  parent: t.Node,
): boolean =>
  (t.isAssignmentExpression(parent) &&
    parent.left === node &&
    parent.operator !== "=") ||
  (t.isUpdateExpression(parent) && parent.argument === node);

/**
 * Role of one identifier occurrence, given the node's ancestry.
 *
 * A binding inside a destructuring pattern has an ObjectProperty/ArrayPattern
 * as its direct parent, so the immediate parent cannot tell a declaration
 * (`const {a} = o`, `catch ({message})`) from an assignment target
 * (`({a} = o)`, `for (a of list)`). Walking the ancestry to the nearest
 * pattern-owning construct is what makes the distinction possible.
 */
export const semanticIdentifierRole = (
  node: t.Identifier,
  parent: t.Node,
  ancestors: readonly t.Node[],
): JavaScriptSemanticReference["role"] | null => {
  const patternAncestor = enclosingPatternAncestor(node, parent, ancestors);
  if (patternAncestor !== null) {
    if (isPatternOwnerDeclaration(patternAncestor)) return null;
    return "write";
  }
  return semanticReferenceRole(node, parent);
};

/**
 * The nearest ancestor that owns this identifier as a *bound* pattern slot, or
 * null when the identifier is not being bound. A binding inside a pattern has
 * an ObjectProperty/ArrayPattern parent, so the immediate parent cannot say
 * whether the identifier declares a binding or is assigned to.
 *
 * Only the bound side counts: `{a = compute()}` binds `a` but merely *reads*
 * `compute`, so the default-value side must not be mistaken for a binding.
 */
const enclosingPatternAncestor = (
  node: t.Identifier,
  parent: t.Node,
  ancestors: readonly t.Node[],
): t.Node | null => {
  const chain = [...ancestors, parent];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const ancestor = chain[index];
    if (ancestor === undefined || !isPatternNode(ancestor)) continue;
    if (!bindsIdentifier(ancestor, parent, node)) continue;
    // Found the binding slot; now find what owns the pattern.
    for (let owner = index - 1; owner >= 0; owner -= 1) {
      const candidate = chain[owner];
      if (candidate === undefined) continue;
      if (
        t.isAssignmentExpression(candidate) ||
        t.isForInStatement(candidate) ||
        t.isForOfStatement(candidate)
      )
        return candidate;
      if (isPatternOwnerDeclaration(candidate)) return candidate;
    }
    return null;
  }
  return null;
};

/** True when `parent` places `node` in the bound slot of `pattern`. */
const bindsIdentifier = (
  pattern: t.Node,
  parent: t.Node,
  node: t.Identifier,
): boolean => {
  // The identifier sits directly in the pattern: `[b]`, `({b})`, `{b = 1}`.
  if (parent === pattern) return patternContains(pattern, node);
  if (t.isObjectPattern(pattern))
    return (
      t.isObjectProperty(parent) &&
      (parent.value === node || (parent.shorthand && parent.key === node))
    );
  if (t.isArrayPattern(pattern))
    return pattern.elements.some((element) => element === parent);
  if (t.isAssignmentPattern(pattern)) return pattern.left === parent;
  return t.isRestElement(pattern) && pattern.argument === parent;
};

const isPatternNode = (node: t.Node): boolean =>
  t.isObjectPattern(node) ||
  t.isArrayPattern(node) ||
  t.isAssignmentPattern(node) ||
  t.isRestElement(node);

const isPatternOwnerDeclaration = (node: t.Node): boolean =>
  (t.isVariableDeclarator(node) && t.isPattern(node.id)) ||
  (t.isFunction(node) &&
    node.params.some((value): value is t.Pattern => t.isPattern(value))) ||
  (t.isCatchClause(node) && node.param !== null && t.isPattern(node.param));

/** Classify one identifier occurrence consistently with semantic references. */
export const semanticReferenceRole = (
  node: t.Identifier,
  parent: t.Node,
): JavaScriptSemanticReference["role"] | null => {
  if (isDeclarationIdentifier(node, parent) || isNonReferenceKey(node, parent))
    return null;
  if (
    (t.isAssignmentExpression(parent) && parent.left === node) ||
    t.isUpdateExpression(parent) ||
    ((t.isForInStatement(parent) || t.isForOfStatement(parent)) &&
      parent.left === node)
  )
    return "write";
  if (t.isExportSpecifier(parent) && parent.local === node) return "export";
  return "read";
};

const isDeclarationIdentifier = (node: t.Identifier, parent: t.Node): boolean =>
  (t.isVariableDeclarator(parent) && patternContains(parent.id, node)) ||
  ((t.isFunctionDeclaration(parent) || t.isFunctionExpression(parent)) &&
    parent.id === node) ||
  (t.isFunction(parent) &&
    parent.params.some((value) => patternContains(value, node))) ||
  ((t.isClassDeclaration(parent) || t.isClassExpression(parent)) &&
    parent.id === node) ||
  (t.isImportSpecifier(parent) &&
    (parent.local === node || parent.imported === node)) ||
  (t.isImportDefaultSpecifier(parent) && parent.local === node) ||
  (t.isImportNamespaceSpecifier(parent) && parent.local === node) ||
  (t.isCatchClause(parent) && parent.param === node);

const isNonReferenceKey = (node: t.Identifier, parent: t.Node): boolean =>
  ((t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) &&
    parent.property === node &&
    !parent.computed) ||
  ((t.isObjectProperty(parent) || t.isObjectMethod(parent)) &&
    parent.key === node &&
    !parent.computed &&
    !(t.isObjectProperty(parent) && parent.shorthand)) ||
  (t.isExportSpecifier(parent) && parent.exported === node) ||
  t.isLabeledStatement(parent) ||
  t.isBreakStatement(parent) ||
  t.isContinueStatement(parent);

const patternNames = (pattern: t.Node): string[] => {
  if (t.isTSParameterProperty(pattern)) return patternNames(pattern.parameter);
  if (t.isIdentifier(pattern)) return [pattern.name];
  if (t.isAssignmentPattern(pattern)) return patternNames(pattern.left);
  if (t.isRestElement(pattern)) return patternNames(pattern.argument);
  if (t.isObjectPattern(pattern))
    return pattern.properties.flatMap((property) =>
      t.isRestElement(property)
        ? patternNames(property.argument)
        : patternNames(property.value),
    );
  if (t.isArrayPattern(pattern))
    return pattern.elements.flatMap((element) =>
      element === null ? [] : patternNames(element),
    );
  return [];
};

const patternContains = (pattern: t.Node, target: t.Identifier): boolean =>
  pattern === target ||
  (t.isAssignmentPattern(pattern) && patternContains(pattern.left, target)) ||
  (t.isRestElement(pattern) && patternContains(pattern.argument, target)) ||
  (t.isObjectPattern(pattern) &&
    pattern.properties.some((property) =>
      t.isRestElement(property)
        ? patternContains(property.argument, target)
        : patternContains(property.value, target),
    )) ||
  (t.isArrayPattern(pattern) &&
    pattern.elements.some(
      (element) => element !== null && patternContains(element, target),
    ));

const declarationNames = (declaration: t.Declaration): string[] => {
  if (t.isVariableDeclaration(declaration))
    return declaration.declarations.flatMap(({ id }) => patternNames(id));
  if (
    (t.isFunctionDeclaration(declaration) ||
      t.isClassDeclaration(declaration)) &&
    t.isIdentifier(declaration.id)
  )
    return [declaration.id.name];
  return [];
};

const defaultDeclarationName = (
  declaration: t.ExportDefaultDeclaration["declaration"],
): string | null =>
  (t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) &&
  t.isIdentifier(declaration.id)
    ? declaration.id.name
    : null;

const commonJsExportName = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): string | undefined => {
  if (isUnshadowedGlobal(node, state, "exports")) return "default";
  if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node))
    return undefined;
  const key = memberKey(node);
  // `exports[key]`/`module.exports[key]` assign an export whose name is not
  // knowable. Report the wildcard rather than the variable name, and never
  // collapse it into `default`, which would claim a real default export.
  if (isUnshadowedGlobal(node.object, state, "exports"))
    return key === null ? "*" : key || "*";
  if (
    t.isMemberExpression(node.object) &&
    isUnshadowedGlobal(node.object.object, state, "module") &&
    memberKey(node.object) === "exports"
  )
    return key === null ? "*" : key || "default";
  if (
    isUnshadowedGlobal(node.object, state, "module") &&
    memberKey(node) === "exports"
  )
    return "default";
  return undefined;
};

/** Exact member key, or null when a computed key commits no name. */
const memberKey = (
  node: t.MemberExpression | t.OptionalMemberExpression,
): string | null =>
  semanticStaticPropertyName(node.property, node.computed) || null;
