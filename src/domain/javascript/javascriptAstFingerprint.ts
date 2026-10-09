import { createHash } from "node:crypto";

import * as t from "@babel/types";

import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

import { compareCodePoints } from "../canonicalOrdering.js";
import {
  propertyName,
  semanticStaticPropertyKey,
} from "./javascriptAstValues.js";
import { stringValue } from "./javascriptStaticAnalysisHelpers.js";

/** Static CommonJS export names. */
export interface StaticExports {
  readonly values: readonly string[];
}

/** Derive a rename-resistant syntax fingerprint without code execution. */
export const fingerprintJavaScriptAst = (node: t.Node): string => {
  const tokens: string[] = [];
  traverseJavaScriptAst(node, {
    enter: (current) => {
      tokens.push(...semanticTokens(current));
      return undefined;
    },
  });
  return createHash("sha256").update(JSON.stringify(tokens)).digest("hex");
};

/** Collect statically declared CommonJS/bundler export names from one factory. */
export const collectJavaScriptExports = (node: t.Node): StaticExports => {
  const exports = new Set<string>();
  traverseJavaScriptAst(node, {
    enter: (current) => {
      if (t.isAssignmentExpression(current))
        collectAssignmentExports(current.left, current.right, exports);
      if (t.isCallExpression(current)) collectCallExports(current, exports);
      return undefined;
    },
  });
  return {
    values: [...exports].sort(compareCodePoints),
  };
};

const semanticTokens = (node: t.Node): string[] => {
  const tokens = [`node:${node.type}`];
  if (t.isStringLiteral(node)) tokens.push(`string:${node.value}`);
  else if (t.isNumericLiteral(node))
    tokens.push(`number:${String(node.value)}`);
  else if (t.isBooleanLiteral(node))
    tokens.push(`boolean:${String(node.value)}`);
  else if (t.isRegExpLiteral(node))
    tokens.push(`regexp:${node.pattern}/${node.flags}`);
  else if (t.isBinaryExpression(node) || t.isLogicalExpression(node))
    tokens.push(`operator:${node.operator}`);
  else if (t.isUnaryExpression(node) || t.isUpdateExpression(node))
    tokens.push(`operator:${node.operator}`);
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const property = propertyName(node.property);
    if (property !== "") tokens.push(`property:${property}`);
  }
  if ((t.isObjectProperty(node) || t.isObjectMethod(node)) && !node.computed) {
    const key = propertyName(node.key);
    if (key !== "") tokens.push(`key:${key}`);
  }
  return tokens;
};

const collectAssignmentExports = (
  left: t.LVal | t.OptionalMemberExpression,
  right: t.Expression,
  output: Set<string>,
): void => {
  const path = memberPath(left);
  if (path === null) return;
  const exportOffset =
    path[0] === "exports"
      ? 1
      : path[0] === "module" && path[1] === "exports"
        ? 2
        : null;
  if (exportOffset === null) return;
  if (path.length === exportOffset) {
    if (t.isObjectExpression(right)) collectObjectKeys(right, output);
    else addExport(output, "default");
    return;
  }
  addExport(output, path.slice(exportOffset).join("."));
};

const collectCallExports = (
  call: t.CallExpression,
  output: Set<string>,
): void => {
  const callee = memberPath(call.callee);
  if (callee === null) return;
  const target = memberPath(call.arguments[0]);
  const exportTarget =
    target !== null &&
    ((target.length === 1 && target[0] === "exports") ||
      (target.length === 2 &&
        target[0] === "module" &&
        target[1] === "exports"));
  if (!exportTarget) return;
  if (
    callee.length === 2 &&
    callee[0] === "Object" &&
    callee[1] === "defineProperty"
  ) {
    const name = stringValue(call.arguments[1]);
    if (name !== undefined) addExport(output, name);
  }
  if (callee.at(-1) !== "d") return;
  const declarations = call.arguments[1];
  if (t.isObjectExpression(declarations))
    collectObjectKeys(declarations, output);
};

const collectObjectKeys = (
  object: t.ObjectExpression,
  output: Set<string>,
): void => {
  for (const property of object.properties) {
    if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) continue;
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name !== null) addExport(output, name);
  }
};

const addExport = (output: Set<string>, name: string): void => {
  output.add(name);
};

const memberPath = (
  node: t.Node | null | undefined,
): readonly string[] | null => {
  const properties: string[] = [];
  let current = node;
  while (
    current !== undefined &&
    current !== null &&
    (t.isMemberExpression(current) || t.isOptionalMemberExpression(current))
  ) {
    const property = semanticStaticPropertyKey(
      current.property,
      current.computed,
    );
    if (property === null) return null;
    properties.push(property);
    current = current.object;
  }
  if (current === undefined || current === null || !t.isIdentifier(current))
    return null;
  return [current.name, ...properties.reverse()];
};
