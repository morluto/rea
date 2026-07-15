import * as t from "@babel/types";

import type { ElectronStaticValue } from "./electronStaticAnalysisTypes.js";
import {
  compareCodePoints,
  propertyName,
  sourceSlice,
} from "./javascriptStaticAnalysisHelpers.js";

const MAX_EXPRESSION_CHARACTERS = 4_096;

/** Preserve one literal value or the exact bounded inert expression. */
export const electronStaticValue = (
  source: string,
  node: t.Node | null | undefined,
): ElectronStaticValue => {
  const literal = literalValue(node);
  return literal.found
    ? { status: "literal", value: literal.value, expression: null }
    : {
        status: "dynamic",
        value: null,
        expression: boundedExpression(source, node),
      };
};

/** Return an actionable bounded expression without evaluating it. */
export const boundedExpression = (
  source: string,
  node: t.Node | null | undefined,
): string => {
  if (node === null || node === undefined) return "[missing-expression]";
  const expression = sourceSlice(source, node).trim();
  return (expression === "" ? `[${node.type}]` : expression).slice(
    0,
    MAX_EXPRESSION_CHARACTERS,
  );
};

/** Read one named object property without following spreads or bindings. */
export const objectProperty = (
  object: t.ObjectExpression,
  name: string,
): t.ObjectProperty | undefined =>
  object.properties.find(
    (property): property is t.ObjectProperty =>
      t.isObjectProperty(property) && propertyName(property.key) === name,
  );

/** Classify a handler argument while retaining its exact source range. */
export const handlerKind = (
  node: t.Node | null | undefined,
):
  | "inline-function"
  | "identifier"
  | "member-expression"
  | "dynamic-expression"
  | "missing" => {
  if (node === null || node === undefined) return "missing";
  if (
    t.isArrowFunctionExpression(node) ||
    t.isFunctionExpression(node) ||
    t.isFunctionDeclaration(node)
  )
    return "inline-function";
  if (t.isIdentifier(node)) return "identifier";
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
    return "member-expression";
  return "dynamic-expression";
};

/** Collect bounded dotted keys from one literal contextBridge API object. */
export const collectContextBridgeMembers = (
  node: t.Node | null | undefined,
  maximum = 128,
): {
  readonly status: "object-literal" | "dynamic" | "missing";
  readonly members: readonly string[];
  readonly unknown: number;
  readonly omitted: number;
} => {
  if (node === null || node === undefined)
    return {
      status: "missing",
      members: [],
      unknown: 0,
      omitted: 0,
    };
  if (!t.isObjectExpression(node))
    return {
      status: "dynamic",
      members: [],
      unknown: 1,
      omitted: 0,
    };
  const state = { members: [] as string[], unknown: 0 };
  collectMembersAt(node, "", 0, state);
  const members = [...new Set(state.members)].sort(compareCodePoints);
  return {
    status: "object-literal",
    members: members.slice(0, maximum),
    unknown: state.unknown,
    omitted: Math.max(0, members.length - maximum),
  };
};

const collectMembersAt = (
  object: t.ObjectExpression,
  prefix: string,
  depth: number,
  state: { members: string[]; unknown: number },
): void => {
  if (depth >= 8) {
    state.unknown += 1;
    return;
  }
  for (const property of object.properties) {
    if (t.isSpreadElement(property)) {
      state.unknown += 1;
      continue;
    }
    const name = propertyName(property.key);
    if (name === "" || property.computed) {
      state.unknown += 1;
      continue;
    }
    const path = (prefix === "" ? name : `${prefix}.${name}`).slice(
      0,
      MAX_EXPRESSION_CHARACTERS,
    );
    state.members.push(path);
    if (t.isObjectProperty(property) && t.isObjectExpression(property.value))
      collectMembersAt(property.value, path, depth + 1, state);
  }
};

const literalValue = (
  node: t.Node | null | undefined,
):
  | { readonly found: true; readonly value: string | number | boolean | null }
  | { readonly found: false } => {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node))
    return { found: true, value: node.value };
  if (t.isBooleanLiteral(node)) return { found: true, value: node.value };
  if (t.isNullLiteral(node)) return { found: true, value: null };
  if (t.isTemplateLiteral(node) && node.expressions.length === 0)
    return {
      found: true,
      value: (
        node.quasis[0]?.value.cooked ??
        node.quasis[0]?.value.raw ??
        ""
      ).slice(0, MAX_EXPRESSION_CHARACTERS),
    };
  if (
    t.isUnaryExpression(node, { operator: "-" }) &&
    t.isNumericLiteral(node.argument)
  )
    return { found: true, value: -node.argument.value };
  return { found: false };
};
