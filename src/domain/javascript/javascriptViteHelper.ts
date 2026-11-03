import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { isUnshadowedGlobal } from "./javascriptSemanticMutationInitializers.js";
import { semanticArrayIndex } from "./javascriptSemanticPropertyPaths.js";
import { semanticIdentifierRole } from "./javascriptSemanticProjection.js";
import {
  childNodes,
  javaScriptAstChildKeys,
} from "./javascriptSemanticTraversal.js";

type ViteHelper =
  | t.ArrowFunctionExpression
  | t.FunctionExpression
  | t.FunctionDeclaration;

/** null is an owned unknown value; undefined leaves property ownership unproven. */
export type JavaScriptViteCacheTable = readonly (string | null | undefined)[];

const tableSlots = new WeakMap<t.ArrayExpression, JavaScriptViteCacheTable>();

/** normalize table ownership and decoded values once for all read consumers. */
export function* readJavaScriptViteTableSlotsSteps(
  table: t.ArrayExpression,
): Generator<void, JavaScriptViteCacheTable> {
  const retained = tableSlots.get(table);
  if (retained !== undefined) return retained;
  const slots: (string | null | undefined)[] = [];
  for (const [index, element] of table.elements.entries()) {
    if (index > 0 && index % 1024 === 0) yield;
    if (t.isSpreadElement(element)) {
      slots.push(undefined);
      break;
    }
    const literal =
      element === null ? undefined : readExactJavaScriptLiteral(element);
    slots.push(
      literal?.found && typeof literal.value === "string"
        ? literal.value
        : element === null
          ? undefined
          : null,
    );
  }
  tableSlots.set(table, slots);
  return slots;
}

/** an owned data slot cannot invoke a prototype getter, even if its value is unknown. */
export const javaScriptViteTableHasOwnSlot = (
  key: string | null,
  table: JavaScriptViteCacheTable | undefined,
): boolean => {
  if (table === undefined || key === null) return false;
  const index = semanticArrayIndex(key);
  return key === "length" || (index !== null && table[index] !== undefined);
};

/** a missing property is inert only when visible writes cannot supply an accessor. */
export const hasJavaScriptViteInheritedProperty = (
  key: string | number,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  ["Array", "Object"].some((namespace) =>
    state.ambientWrites.covers(["global", namespace, "prototype", String(key)]),
  );

export interface JavaScriptViteHelperCandidate {
  readonly name: t.Identifier;
  readonly helper: ViteHelper;
  readonly table: t.ArrayExpression;
  readonly projection: t.ArrowFunctionExpression | t.FunctionExpression;
  readonly cacheReads: readonly [t.Node, t.Node];
  readonly uncertain: boolean;
}

interface ViteHelperDefaults {
  readonly indexes: string;
  readonly map: string;
  readonly dependencies: string;
  readonly cache: t.Node;
  readonly returned: t.Node;
  readonly uncertain: boolean;
}

interface LoweredParameterDefault {
  readonly fallback: t.Node;
  readonly uncertain: boolean;
}

/** normalize admitted emitted helper forms without executing their defaults. */
export const readJavaScriptViteHelper = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptViteHelperCandidate | undefined => {
  const declaration = viteHelperDeclaration(node);
  if (declaration === undefined) return undefined;
  const { name, helper } = declaration;
  const defaults =
    helper.params.length === 3
      ? (parameterDefaults(helper, name.name) ??
        assignmentGuardedDefaults(helper, name.name, state))
      : loweredDefaults(helper, name.name, state);
  if (defaults === undefined) return undefined;
  const parameterNames = new Set([
    defaults.indexes,
    defaults.map,
    defaults.dependencies,
  ]);
  if (parameterNames.size !== 3 || parameterNames.has(name.name))
    return undefined;
  const { cache } = defaults;
  const projection = dependencyIndexProjection(
    defaults.returned,
    defaults.indexes,
    defaults.dependencies,
  );
  if (
    !t.isLogicalExpression(cache, { operator: "||" }) ||
    !isNamedMember(cache.left, defaults.map, "f") ||
    !t.isAssignmentExpression(cache.right, { operator: "=" }) ||
    !isNamedMember(cache.right.left, defaults.map, "f") ||
    !t.isArrayExpression(cache.right.right) ||
    projection === undefined
  )
    return undefined;
  return {
    name,
    helper,
    table: cache.right.right,
    projection,
    cacheReads: [cache.left, cache.right.left],
    uncertain:
      defaults.uncertain ||
      state.ambientWrites.covers(["global", "Array", "prototype", "map"]) ||
      state.ambientWrites.covers(["global", "Function", "prototype", "f"]) ||
      state.ambientWrites.covers(["global", "Object", "prototype", "f"]),
  };
};

/** Table initializers run before projection and may change or expose its input. */
export function* tableMayAffectIndexesSteps(
  table: t.ArrayExpression,
  helper: ViteHelper,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, boolean> {
  const parameter = helper.params[0];
  if (!t.isIdentifier(parameter)) return true;
  const indexes = parameter.name;
  const binding = resolveSemanticBindingState(state, parameter, indexes);
  if (binding === undefined) return true;
  let examined = 0;
  for (const [index, element] of table.elements.entries()) {
    if (index % 1024 === 0) yield;
    if (element === null || readExactJavaScriptLiteral(element).found) continue;
    const pending: t.Node[] = [element];
    while (pending.length > 0) {
      if (++examined > 1024) return true;
      const node = pending.pop();
      if (node === undefined) continue;
      if (
        t.isCallExpression(node) &&
        t.isIdentifier(node.callee, { name: "eval" })
      )
        return true;
      if (
        t.isIdentifier(node) &&
        (node.name === "arguments" || node.name === indexes)
      ) {
        const parent = state.parentsByNode.get(node);
        if (parent === undefined) return true;
        const ancestors: t.Node[] = [parent];
        for (
          let ancestor = state.parentsByNode.get(parent);
          ancestor !== undefined;
          ancestor = state.parentsByNode.get(ancestor)
        ) {
          if (ancestors.length >= 1024) return true;
          ancestors.push(ancestor);
          if (ancestor === helper) break;
        }
        ancestors.reverse();
        if (ancestors[0] !== helper) return true;
        if (semanticIdentifierRole(node, parent, () => ancestors) === null)
          continue;
        // In lowered non-strict functions arguments[0] aliases the parameter;
        // passing either value away also permits mutation before projection.
        if (node.name === "arguments") return true;
        if (node.name === indexes) {
          const referenced = resolveSemanticBindingState(state, node, indexes);
          if (
            referenced === undefined ||
            referenced.bindingId === binding.bindingId
          )
            return true;
        }
      }
      // Avoid expanding a wide nested expression before enforcing the bound.
      for (const key of javaScriptAstChildKeys(node)) {
        const value: unknown = Reflect.get(node, key);
        if (Array.isArray(value) && value.length > 1024 - examined) return true;
      }
      for (const child of childNodes(node)) pending.push(child);
    }
  }
  return false;
}

const viteHelperDeclaration = (
  node: t.Node,
): Pick<JavaScriptViteHelperCandidate, "name" | "helper"> | undefined => {
  const name =
    t.isVariableDeclarator(node) || t.isFunctionDeclaration(node)
      ? node.id
      : undefined;
  const initializer = t.isVariableDeclarator(node) ? node.init : node;
  if (!t.isIdentifier(name, { name: "__vite__mapDeps" }) || initializer == null)
    return undefined;
  const helper = unwrapJavaScriptExpression(initializer).node;
  if (
    (!t.isArrowFunctionExpression(helper) &&
      !t.isFunctionExpression(helper) &&
      !t.isFunctionDeclaration(helper)) ||
    helper.async ||
    (!t.isArrowFunctionExpression(helper) && helper.generator)
  )
    return undefined;
  return { name, helper };
};

const parameterDefaults = (
  helper: ViteHelper,
  name: string,
): ViteHelperDefaults | undefined => {
  const [indexes, map, dependencies] = helper.params;
  if (
    !t.isIdentifier(indexes) ||
    !t.isAssignmentPattern(map) ||
    !t.isIdentifier(map.left) ||
    !t.isIdentifier(map.right, { name }) ||
    !t.isAssignmentPattern(dependencies) ||
    !t.isIdentifier(dependencies.left)
  )
    return undefined;
  const returned = singleReturnedExpression(helper.body);
  if (returned === undefined) return undefined;
  return {
    indexes: indexes.name,
    map: map.left.name,
    dependencies: dependencies.left.name,
    cache: dependencies.right,
    returned,
    uncertain: false,
  };
};

/** read statement and sequence forms of assignment-guarded defaults once. */
const assignmentGuardedDefaults = (
  helper: ViteHelper,
  name: string,
  state: JavaScriptSemanticAnalysisState,
): ViteHelperDefaults | undefined => {
  if (
    helper.params.length !== 3 ||
    !t.isIdentifier(helper.params[0]) ||
    !t.isIdentifier(helper.params[1]) ||
    !t.isIdentifier(helper.params[2])
  )
    return undefined;
  const [indexes, map, dependencies] = helper.params;
  const operations = guardedDefaultOperations(helper.body);
  if (
    indexes === undefined ||
    map === undefined ||
    dependencies === undefined ||
    operations === undefined
  )
    return undefined;
  const [mapGuard, dependenciesGuard, returned] = operations;
  const mapDefault = assignmentGuardedParameterDefault(
    mapGuard,
    map.name,
    state,
  );
  const dependenciesDefault = assignmentGuardedParameterDefault(
    dependenciesGuard,
    dependencies.name,
    state,
  );
  if (
    mapDefault === undefined ||
    !t.isIdentifier(mapDefault.fallback, { name }) ||
    dependenciesDefault === undefined
  )
    return undefined;
  return {
    indexes: indexes.name,
    map: map.name,
    dependencies: dependencies.name,
    cache: dependenciesDefault.fallback,
    returned,
    uncertain: mapDefault.uncertain || dependenciesDefault.uncertain,
  };
};

const guardedDefaultOperations = (
  body: t.Node,
): readonly [t.Node, t.Node, t.Node] | undefined => {
  const operations: t.Node[] = [];
  let returned: t.Node = body;
  if (t.isBlockStatement(body)) {
    if (body.body.length === 0 || body.body.length > 3) return undefined;
    const statement = body.body.at(-1);
    if (!t.isReturnStatement(statement) || statement.argument == null)
      return undefined;
    returned = statement.argument;
    for (let index = 0; index < body.body.length - 1; index++) {
      const guard = body.body[index];
      if (
        guard !== undefined &&
        !appendGuardedDefaultOperations(guard, operations)
      )
        return undefined;
    }
  }
  if (!appendGuardedDefaultOperations(returned, operations)) return undefined;
  const [mapGuard, dependenciesGuard, projection] = operations;
  return mapGuard !== undefined &&
    dependenciesGuard !== undefined &&
    projection !== undefined &&
    operations.length === 3
    ? [mapGuard, dependenciesGuard, projection]
    : undefined;
};

/** Comma grouping does not change the ordered guards or returned projection. */
const appendGuardedDefaultOperations = (
  node: t.Node,
  operations: t.Node[],
): boolean => {
  const pending = [node];
  while (pending.length > 0) {
    const operation = pending.pop();
    if (operation === undefined) continue;
    const expression = unwrapJavaScriptExpression(
      t.isExpressionStatement(operation) ? operation.expression : operation,
    ).node;
    if (t.isSequenceExpression(expression)) {
      if (
        operations.length + pending.length + expression.expressions.length >
        3
      )
        return false;
      for (let index = expression.expressions.length - 1; index >= 0; index--) {
        const child = expression.expressions[index];
        if (child !== undefined) pending.push(child);
      }
    } else {
      if (operations.length === 3) return false;
      operations.push(expression);
    }
  }
  return true;
};

const assignmentGuardedParameterDefault = (
  statement: t.Node | undefined,
  name: string,
  state: JavaScriptSemanticAnalysisState,
): LoweredParameterDefault | undefined => {
  const guard = t.isExpressionStatement(statement)
    ? unwrapJavaScriptExpression(statement.expression).node
    : statement;
  const test =
    t.isIfStatement(guard) && guard.alternate === null
      ? guard.test
      : t.isLogicalExpression(guard, { operator: "&&" })
        ? guard.left
        : undefined;
  const exactUndefined = comparedDefaultUndefined(
    test,
    "===",
    (node) => t.isIdentifier(node, { name }),
    state,
  );
  if (exactUndefined === undefined) return undefined;
  const consequent = t.isIfStatement(guard)
    ? guard.consequent
    : t.isLogicalExpression(guard, { operator: "&&" })
      ? guard.right
      : undefined;
  const assignment = t.isExpressionStatement(consequent)
    ? consequent.expression
    : t.isBlockStatement(consequent) &&
        consequent.body.length === 1 &&
        t.isExpressionStatement(consequent.body[0])
      ? consequent.body[0].expression
      : consequent;
  return t.isAssignmentExpression(assignment, { operator: "=" }) &&
    t.isIdentifier(assignment.left, { name })
    ? { fallback: assignment.right, uncertain: !exactUndefined }
    : undefined;
};

const loweredDefaults = (
  helper: ViteHelper,
  name: string,
  state: JavaScriptSemanticAnalysisState,
): ViteHelperDefaults | undefined => {
  if (
    t.isArrowFunctionExpression(helper) ||
    helper.params.length !== 1 ||
    !t.isIdentifier(helper.params[0])
  )
    return undefined;
  const returned = helper.body.body.at(-1);
  if (!t.isReturnStatement(returned) || returned.argument == null)
    return undefined;
  const declarations = loweredDeclarations(helper.body);
  if (declarations === undefined) return undefined;
  const [map, dependencies] = declarations;
  if (
    map === undefined ||
    dependencies === undefined ||
    !t.isIdentifier(map.id) ||
    !t.isIdentifier(dependencies.id)
  )
    return undefined;
  const mapDefault = loweredParameterDefault(map.init, 1, state);
  const dependenciesDefault = loweredParameterDefault(
    dependencies.init,
    2,
    state,
  );
  if (
    mapDefault === undefined ||
    !t.isIdentifier(mapDefault.fallback, { name }) ||
    dependenciesDefault === undefined
  )
    return undefined;
  return {
    indexes: helper.params[0].name,
    map: map.id.name,
    dependencies: dependencies.id.name,
    cache: dependenciesDefault.fallback,
    returned: returned.argument,
    uncertain:
      mapDefault.uncertain ||
      dependenciesDefault.uncertain ||
      new Set([helper.params[0].name, map.id.name, dependencies.id.name]).has(
        "arguments",
      ),
  };
};

const loweredDeclarations = (
  body: t.BlockStatement,
): readonly t.VariableDeclarator[] | undefined => {
  if (body.body.length < 2 || body.body.length > 3) return undefined;
  const declarations: t.VariableDeclarator[] = [];
  for (const statement of body.body.slice(0, -1)) {
    if (
      !t.isVariableDeclaration(statement) ||
      statement.declarations.length > 2
    )
      return undefined;
    declarations.push(...statement.declarations);
  }
  return declarations.length === 2 ? declarations : undefined;
};

/** Babel lowers each default to a guarded lookup of the same argument index. */
const loweredParameterDefault = (
  node: t.Node | null | undefined,
  index: number,
  state: JavaScriptSemanticAnalysisState,
): LoweredParameterDefault | undefined => {
  if (!t.isConditionalExpression(node)) return undefined;
  const { test } = node;
  if (!t.isLogicalExpression(test, { operator: "&&" })) return undefined;
  // Minifiers can reverse only the length comparison, so both orientations
  // describe the same required-argument guard.
  const lengthComparison = t.isBinaryExpression(test.left)
    ? test.left
    : undefined;
  if (lengthComparison === undefined) return undefined;
  const lengthGuard =
    (lengthComparison.operator === ">" &&
      isNamedMember(lengthComparison.left, "arguments", "length") &&
      t.isNumericLiteral(lengthComparison.right, { value: index })) ||
    (lengthComparison.operator === "<" &&
      isNamedMember(lengthComparison.right, "arguments", "length") &&
      t.isNumericLiteral(lengthComparison.left, { value: index }));
  if (!lengthGuard || !isArgumentIndex(node.consequent, index))
    return undefined;
  const exactUndefined = comparedDefaultUndefined(
    test.right,
    "!==",
    (value) => isArgumentIndex(value, index),
    state,
  );
  if (exactUndefined === undefined) return undefined;
  return { fallback: node.alternate, uncertain: !exactUndefined };
};

/** compare one parameter with an inert undefined sentinel in either orientation. */
const comparedDefaultUndefined = (
  node: t.Node | undefined,
  operator: "===" | "!==",
  matchesParameter: (value: t.Node) => boolean,
  state: JavaScriptSemanticAnalysisState,
): boolean | undefined => {
  if (node === undefined) return undefined;
  const comparison = unwrapJavaScriptExpression(node).node;
  if (!t.isBinaryExpression(comparison, { operator })) return undefined;
  const left = unwrapJavaScriptExpression(comparison.left).node;
  const right = unwrapJavaScriptExpression(comparison.right).node;
  const value = matchesParameter(left)
    ? right
    : matchesParameter(right)
      ? left
      : undefined;
  if (value === undefined) return undefined;
  if (isJavaScriptViteDefaultUndefined(value, state)) return true;
  return t.isIdentifier(value, { name: "undefined" }) ? false : undefined;
};

const isArgumentIndex = (node: t.Node, index: number): boolean =>
  t.isMemberExpression(node) &&
  node.computed &&
  t.isIdentifier(node.object, { name: "arguments" }) &&
  t.isNumericLiteral(node.property, { value: index });

/** distinguish inert default values from shadowed or effectful expressions. */
export const isJavaScriptViteDefaultUndefined = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  node = unwrapJavaScriptExpression(node).node;
  return (
    isUnshadowedGlobal(node, state, "undefined") ||
    (t.isUnaryExpression(node, { operator: "void" }) &&
      readExactJavaScriptLiteral(node.argument).found)
  );
};

const singleReturnedExpression = (body: t.Node): t.Node | undefined => {
  if (!t.isBlockStatement(body)) return body;
  const [statement] = body.body;
  return body.body.length === 1 && t.isReturnStatement(statement)
    ? (statement.argument ?? undefined)
    : undefined;
};

const isNamedMember = (
  node: t.Node,
  object: string,
  property: string,
): boolean =>
  t.isMemberExpression(node) &&
  t.isIdentifier(node.object, { name: object }) &&
  semanticStaticPropertyKey(node.property, node.computed) === property;

const dependencyIndexProjection = (
  body: t.Node,
  indexes: string,
  dependencies: string,
): t.ArrowFunctionExpression | t.FunctionExpression | undefined => {
  if (
    !t.isCallExpression(body) ||
    !isNamedMember(body.callee, indexes, "map") ||
    body.arguments.length !== 1
  )
    return undefined;
  const callback = body.arguments[0];
  if (
    (!t.isArrowFunctionExpression(callback) &&
      !t.isFunctionExpression(callback)) ||
    callback.async ||
    (t.isFunctionExpression(callback) &&
      (callback.generator || callback.id?.name === dependencies)) ||
    callback.params.length !== 1 ||
    !t.isIdentifier(callback.params[0]) ||
    callback.params[0].name === dependencies
  )
    return undefined;
  const returned = singleReturnedExpression(callback.body);
  return t.isMemberExpression(returned) &&
    returned.computed &&
    t.isIdentifier(returned.object, { name: dependencies }) &&
    t.isIdentifier(returned.property, { name: callback.params[0].name })
    ? callback
    : undefined;
};
