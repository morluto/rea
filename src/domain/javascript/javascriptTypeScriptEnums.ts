import * as t from "@babel/types";
import {
  readExactJavaScriptLiteral,
  runtimeFunctionParameters,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import type { SymbolicValue } from "./javascriptSymbolicValues.js";

interface TypeScriptEnum {
  /** Call that assigns the members; a read must follow its completion. */
  readonly call: t.CallExpression;
  /** The binding's own `E = {}` in the call argument, if any. */
  readonly assignment: t.Node | undefined;
  readonly value: SymbolicValue;
}

/**
 * Recognize the binding of a compiled TypeScript enum: tsc's
 * `var E; (function (E) { E["A"] = "a"; E[E["B"] = 0] = "B"; })(E || (E = {}));`
 * or the `var E = function (E) {...; return E; }(E || {})` of Babel and
 * esbuild. The caller rejects any other write to the binding.
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

/** `var E = function (E) {...}(E || {})`, or `let E = exports.E = ...({})`. */
const initializedEnum = (
  initializer: t.Node,
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): TypeScriptEnum | undefined => {
  let call = unwrapJavaScriptExpression(initializer).node;
  while (
    t.isAssignmentExpression(call, { operator: "=" }) &&
    t.isMemberExpression(call.left)
  )
    call = unwrapJavaScriptExpression(call.right).node;
  if (
    !t.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    state.conditionallySkippedExpressions.has(initializer)
  )
    return undefined;
  // The binding is still undefined while its own initializer runs.
  const object = unwrapJavaScriptExpression(call.arguments[0]!).node;
  const fresh =
    isEmptyObject(object) ||
    (t.isLogicalExpression(object, { operator: "||" }) &&
      refersTo(object.left, binding.bindingId, state) &&
      isEmptyObject(object.right));
  return fresh ? enumObject(call, undefined, true, state) : undefined;
};

/** `var E; (function (E) {...})(E || (E = {}))`, or `(E || (exports.E = E = {}))`. */
const assignedEnum = (
  object: t.Node,
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): TypeScriptEnum | undefined => {
  const isBinding = (node: t.Node) => refersTo(node, binding.bindingId, state);
  const assignment = state.parentsByNode.get(object);
  if (
    !isEmptyObject(object) ||
    !t.isAssignmentExpression(assignment, { operator: "=" }) ||
    !isBinding(assignment.left)
  )
    return undefined;
  const stored = state.parentsByNode.get(assignment);
  const operand =
    t.isAssignmentExpression(stored, { operator: "=" }) &&
    t.isMemberExpression(stored.left)
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
    ? enumObject(call, assignment, false, state)
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
  assignment: t.Node | undefined,
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
    const key =
      forward === undefined
        ? semanticStaticPropertyKey(target.property, target.computed)
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
    ? { call, assignment, value: { kind: "record", values } }
    : undefined;
};

const operands = (node: t.Node): t.Node[] => {
  const value = unwrapJavaScriptExpression(node).node;
  return t.isSequenceExpression(value) ? [...value.expressions] : [value];
};

const isEmptyObject = (node: t.Node): boolean => {
  const value = unwrapJavaScriptExpression(node).node;
  return t.isObjectExpression(value) && value.properties.length === 0;
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
