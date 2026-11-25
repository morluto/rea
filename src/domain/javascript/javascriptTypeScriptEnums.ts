import * as t from "@babel/types";
import {
  readExactJavaScriptLiteral,
  runtimeFunctionParameters,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { javascriptBootstrapAt } from "./javascriptBootstrap.js";
import { commonJsExportName } from "./javascriptCommonJsExportReceivers.js";
import { moduleFactory } from "./javascriptStaticAnalysisHelpers.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import type { SymbolicValue } from "./javascriptSymbolicValues.js";

interface TypeScriptEnum {
  /** Call that assigns the members; a read must follow its completion. */
  readonly call: t.CallExpression;
  /**
   * Expression that creates the object: the call, or the initializer around
   * it. Effects on the binding inside it belong to the recognized shape.
   */
  readonly declaration: t.Node;
  /** The empty object literal that the call fills and returns. */
  readonly object: t.ObjectExpression;
  readonly value: SymbolicValue;
}

/**
 * Recognize the binding of a compiled TypeScript enum: tsc's
 * `var E; (function (E) { E["A"] = "a"; E[E["B"] = 0] = "B"; })(E || (E = {}));`
 * or the `var E = function (E) {...; return E; }(E || {})` of Babel and
 * esbuild. Any other write to the binding or escape of its object is a fact
 * the caller must still check.
 */
export const typeScriptEnumInitializer = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): TypeScriptEnum | undefined => {
  const [initializer, ...others] = binding.initializers;
  if (
    initializer === undefined ||
    others.length > 0 ||
    initializer.projection.length > 0 ||
    initializer.entryBody !== undefined
  )
    return undefined;
  const definitions = binding.definitions.map(({ kind }) => kind).join();
  if (definitions === "variable")
    return initializedEnum(initializer.node, binding, state);
  return definitions === "variable,assignment"
    ? assignedEnum(initializer.node, binding, state)
    : undefined;
};

/**
 * The store around the enum's object may only publish it as a CommonJS
 * export. Another object's member may be a setter, whose code would run
 * inside the declaration that the caller's effect check skips. So may a
 * member of `module.exports`, which code can replace with an object that has
 * one, so only stores on the `exports` object itself are accepted.
 */
const isExportStore = (
  target: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  t.isMemberExpression(target) &&
  !t.isMemberExpression(unwrapJavaScriptExpression(target.object).node) &&
  (commonJsExportName(target, state) !== undefined ||
    isFactoryExportStore(target, state));

/**
 * `exports.E` through the exports parameter of a factory in a recognized
 * bundle module table. Its loader supplies that object, as the host does for
 * a global receiver.
 */
const isFactoryExportStore = (
  target: t.MemberExpression,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const receiver = unwrapJavaScriptExpression(target.object).node;
  if (!t.isIdentifier(receiver)) return false;
  const binding = resolveSemanticBindingState(state, receiver, receiver.name);
  // A reassigned role parameter no longer holds the loader's object.
  if (
    binding === undefined ||
    binding.definitions.some(({ kind }) => kind !== "parameter")
  )
    return false;
  for (
    let node = state.parentsByNode.get(target);
    node !== undefined;
    node = state.parentsByNode.get(node)
  ) {
    if (!t.isFunction(node)) continue;
    const parameter = runtimeFunctionParameters(node)[1];
    if (
      t.isIdentifier(parameter) &&
      resolveSemanticBindingState(state, parameter, parameter.name)
        ?.bindingId === binding.bindingId
    )
      return isBootstrapFactory(node, state);
  }
  return false;
};

/** A factory of the module table that a recognized bootstrap dispatches. */
const isBootstrapFactory = (
  factory: t.Function,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const property = t.isObjectMethod(factory)
    ? factory
    : state.parentsByNode.get(factory);
  const table = property && state.parentsByNode.get(property);
  if (
    !t.isObjectExpression(table) ||
    !(t.isObjectMethod(property) || t.isObjectProperty(property)) ||
    moduleFactory(property) !== factory
  )
    return false;
  for (
    let node = state.parentsByNode.get(table);
    node !== undefined;
    node = state.parentsByNode.get(node)
  )
    if (t.isCallExpression(node))
      return javascriptBootstrapAt(node, state)?.table === table;
  return false;
};

/** `var E = function (E) {...}(E || {})`, or `let E = exports.E = ...({})`. */
const initializedEnum = (
  initializer: t.Node,
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): TypeScriptEnum | undefined => {
  let call = unwrapJavaScriptExpression(initializer).node;
  while (
    t.isAssignmentExpression(call, { operator: "=" }) &&
    isExportStore(call.left, state)
  )
    call = unwrapJavaScriptExpression(call.right).node;
  if (
    !t.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    state.conditionallySkippedExpressions.has(initializer)
  )
    return undefined;
  // The binding is still undefined while its own initializer runs.
  const argument = unwrapJavaScriptExpression(call.arguments[0]!).node;
  const fresh =
    t.isLogicalExpression(argument, { operator: "||" }) &&
    refersTo(argument.left, binding.bindingId, state)
      ? emptyObject(argument.right)
      : emptyObject(argument);
  return fresh === undefined
    ? undefined
    : enumObject(call, initializer, fresh, true, state);
};

/** `var E; (function (E) {...})(E || (E = {}))`, or `(E || (exports.E = E = {}))`. */
const assignedEnum = (
  object: t.Node,
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): TypeScriptEnum | undefined => {
  const isBinding = (node: t.Node) => refersTo(node, binding.bindingId, state);
  const assignment = state.parentsByNode.get(object);
  const fresh = emptyObject(object);
  if (
    fresh === undefined ||
    !t.isAssignmentExpression(assignment, { operator: "=" }) ||
    !isBinding(assignment.left)
  )
    return undefined;
  const stored = state.parentsByNode.get(assignment);
  const operand =
    t.isAssignmentExpression(stored, { operator: "=" }) &&
    isExportStore(stored.left, state)
      ? stored
      : assignment;
  const logical = state.parentsByNode.get(operand);
  const call = logical && state.parentsByNode.get(logical);
  return t.isLogicalExpression(logical, { operator: "||" }) &&
    logical.right === operand &&
    isBinding(logical.left) &&
    t.isCallExpression(call) &&
    call.arguments.length === 1 &&
    runsInBindingBody(call, binding, state)
    ? enumObject(call, call, fresh, false, state)
    : undefined;
};

/**
 * Whether the call runs whenever the body declaring the binding does: as its
 * own statement, possibly negated or in a comma sequence, directly in that
 * module, script or function body.
 */
const runsInBindingBody = (
  call: t.CallExpression,
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let node = state.parentsByNode.get(call);
  while (
    t.isSequenceExpression(node) ||
    t.isUnaryExpression(node, { operator: "!" }) ||
    t.isUnaryExpression(node, { operator: "void" })
  )
    node = state.parentsByNode.get(node);
  const body = t.isExpressionStatement(node)
    ? state.parentsByNode.get(node)
    : undefined;
  const owner = t.isBlockStatement(body) ? state.parentsByNode.get(body) : body;
  const scope =
    body !== undefined && (t.isProgram(owner) || t.isFunction(owner))
      ? (state.scopeByNode.get(owner) ?? state.scopeByNode.get(body))
      : undefined;
  return scope?.scopeId === binding.scopeId;
};

/**
 * The record of members that a one-parameter function assigns to that
 * parameter. Each statement or comma operand must assign a string or number
 * literal to a fixed key or add a numeric reverse mapping, as in
 * `E[E["B"] = 0] = "B"`. The function may end by returning the parameter,
 * and must when its result is the binding's value.
 */
const enumObject = (
  call: t.CallExpression,
  declaration: t.Node,
  object: t.ObjectExpression,
  returnsParameter: boolean,
  state: JavaScriptSemanticAnalysisState,
): TypeScriptEnum | undefined => {
  const callee = unwrapJavaScriptExpression(call.callee).node;
  if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee))
    return undefined;
  const [parameter, ...rest] = runtimeFunctionParameters(callee);
  const id =
    t.isIdentifier(parameter) && rest.length === 0
      ? resolveSemanticBindingState(state, parameter, parameter.name)?.bindingId
      : undefined;
  if (id === undefined || callee.async || callee.generator) return undefined;
  const values = new Map<string, SymbolicValue>();
  const assign = (node: t.Node, reverse: boolean): string | number | null => {
    if (!t.isAssignmentExpression(node, { operator: "=" })) return null;
    const target = unwrapJavaScriptExpression(node.left).node;
    const literal = readExactJavaScriptLiteral(node.right);
    const value = literal.found ? literal.value : null;
    if (
      !t.isMemberExpression(target) ||
      !refersTo(target.object, id, state) ||
      (typeof value !== "string" && typeof value !== "number")
    )
      return null;
    const property = unwrapJavaScriptExpression(target.property).node;
    // The inner write runs first; its number keys the outer name.
    const forward =
      target.computed && t.isAssignmentExpression(property)
        ? reverse && typeof value === "string" && assign(property, false)
        : undefined;
    // Any other computed key must be a literal: an expression that only
    // evaluates to a fixed key, such as `void (E.A = "b")`, may still write.
    const literalKey =
      !target.computed ||
      t.isStringLiteral(property) ||
      t.isNumericLiteral(property);
    const key =
      forward === undefined
        ? literalKey
          ? semanticStaticPropertyKey(target.property, target.computed)
          : null
        : typeof forward === "number"
          ? String(forward)
          : null;
    if (key === null || key === "__proto__") return null;
    values.set(key, { kind: "literal", value });
    return value;
  };
  const statements = t.isBlockStatement(callee.body) ? callee.body.body : [];
  const last = statements.at(-1);
  const result = t.isBlockStatement(callee.body)
    ? t.isReturnStatement(last)
      ? last.argument
      : undefined
    : callee.body;
  // Minified output folds the writes into the returned comma sequence.
  const results = result == null ? [] : operands(result);
  const returned = results.pop();
  const writes = statements.flatMap((statement): t.Node[] =>
    t.isExpressionStatement(statement)
      ? operands(statement.expression)
      : statement === last && result !== undefined
        ? results
        : [statement],
  );
  const complete =
    (returned === undefined
      ? !returnsParameter && result === undefined
      : refersTo(returned, id, state)) &&
    (t.isBlockStatement(callee.body) ? writes : results).every(
      (write) => assign(write, true) !== null,
    );
  return complete
    ? { call, declaration, object, value: { kind: "record", values } }
    : undefined;
};

const operands = (node: t.Node): t.Node[] => {
  const value = unwrapJavaScriptExpression(node).node;
  return t.isSequenceExpression(value) ? [...value.expressions] : [value];
};

const emptyObject = (node: t.Node): t.ObjectExpression | undefined => {
  const value = unwrapJavaScriptExpression(node).node;
  return t.isObjectExpression(value) && value.properties.length === 0
    ? value
    : undefined;
};

const refersTo = (
  node: t.Node,
  bindingId: string,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const value = unwrapJavaScriptExpression(node).node;
  return (
    t.isIdentifier(value) &&
    resolveSemanticBindingState(state, value, value.name)?.bindingId ===
      bindingId
  );
};
