import { createHash } from "node:crypto";

import * as t from "@babel/types";

import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import {
  propertyName,
  semanticStaticPropertyKey,
} from "./javascriptAstValues.js";
import { stringValue } from "./javascriptStaticAnalysisHelpers.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

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
export const collectJavaScriptExports = (
  node: t.Node,
  bindings?: JavaScriptSemanticAnalysisState,
): StaticExports => {
  const exports = new Set<string>();
  const factoryExports =
    bindings !== undefined &&
    t.isFunction(node) &&
    t.isIdentifier(node.params[1])
      ? resolveSemanticBindingState(
          bindings,
          node.params[1],
          node.params[1].name,
        )?.bindingId
      : undefined;
  const isExportsAlias = (reference: t.Node | null): boolean => {
    if (!t.isIdentifier(reference)) return false;
    if (factoryExports === undefined) return reference.name === "exports";
    return (
      bindings !== undefined &&
      resolveSemanticBindingState(bindings, reference, reference.name)
        ?.bindingId === factoryExports
    );
  };
  traverseJavaScriptAst(node, {
    enter: (current) => {
      if (t.isAssignmentExpression(current))
        collectAssignmentExports(
          current.left,
          current.right,
          exports,
          isExportsAlias,
        );
      if (t.isCallExpression(current))
        collectCallExports(current, exports, isExportsAlias);
      return undefined;
    },
  });
  return {
    values: [...exports].sort(compareUnicodeCodePoints),
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
  isExportsAlias: (root: t.Node | null) => boolean,
): void => {
  const path = memberPath(left);
  if (path === null) return;
  const root = memberRoot(left);
  const exportsAlias = isExportsAlias(root);
  // Rebinding the CommonJS alias does not replace module.exports.
  if (path.length === 1 && exportsAlias) return;
  const exportOffset = exportsAlias
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
  // A CommonJS export assignment exposes the first property below the
  // exports object. Deeper writes mutate that exported value, rather than
  // creating an export whose name is the dotted member path.
  addExport(output, path[exportOffset]!);
};

const collectCallExports = (
  call: t.CallExpression,
  output: Set<string>,
  isExportsAlias: (root: t.Node | null) => boolean,
): void => {
  const callee = memberPath(call.callee);
  if (callee === null) return;
  const definePropertyCall =
    callee.length === 2 &&
    callee[0] === "Object" &&
    callee[1] === "defineProperty";
  const declarationCall = callee.length >= 2 && callee.at(-1) === "d";
  if (!definePropertyCall && !declarationCall) return;
  const targetNode = call.arguments[0];
  const target = memberPath(targetNode);
  const exportTarget =
    isExportsAlias(targetNode ?? null) ||
    (target !== null &&
      target.length === 2 &&
      target[0] === "module" &&
      target[1] === "exports");
  if (!exportTarget) return;
  if (definePropertyCall) {
    const name = stringValue(call.arguments[1]);
    if (name !== undefined) addExport(output, name);
    return;
  }
  const declarations = call.arguments[1];
  if (t.isObjectExpression(declarations))
    collectObjectKeys(declarations, output);
};

const memberRoot = (node: t.Node | null | undefined): t.Node | null => {
  let current = node;
  while (
    current !== null &&
    current !== undefined &&
    (t.isMemberExpression(current) || t.isOptionalMemberExpression(current))
  )
    current = current.object;
  return current ?? null;
};

const collectObjectKeys = (
  object: t.ObjectExpression,
  output: Set<string>,
): void => {
  for (const property of object.properties) {
    if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) continue;
    const name = semanticStaticPropertyKey(property.key, property.computed);
    // In an object literal, a non-computed `__proto__: value` sets the
    // prototype instead of creating an own property. Shorthand, computed,
    // and method forms do create own properties.
    if (
      name !== null &&
      !(
        t.isObjectProperty(property) &&
        !property.computed &&
        !property.shorthand &&
        name === "__proto__"
      )
    )
      addExport(output, name);
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
  if (current === undefined || current === null) return null;
  const root = t.isIdentifier(current)
    ? current.name
    : t.isThisExpression(current)
      ? "this"
      : null;
  return root === null ? null : [root, ...properties.reverse()];
};
