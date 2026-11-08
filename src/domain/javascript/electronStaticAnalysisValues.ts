import * as t from "@babel/types";

import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type { ElectronStaticValue } from "./electronStaticAnalysisTypes.js";
import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { electronMemberPath } from "./javascriptElectronMemberWrites.js";
import { sourceSlice } from "./javascriptStaticAnalysisHelpers.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

/** Resolve a callee only when its root has a proven Electron module identity. */
export const electronCalleePath = (
  callee: t.Node,
  context: JavaScriptFindingContext,
): readonly string[] | undefined => {
  const { root, members } = electronMemberPath(callee);
  if (!members.every((member): member is string => member !== null))
    return undefined;
  const exported = context.electronBindings?.get(root.start ?? -1);
  return exported === undefined ? undefined : [...exported, ...members];
};

/** Preserve one literal value or the exact inert expression. */
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

/** Return an actionable expression without evaluating it. */
export const boundedExpression = (
  source: string,
  node: t.Node | null | undefined,
): string => {
  if (node === null || node === undefined) return "[missing-expression]";
  const expression = sourceSlice(source, node).trim();
  return expression === "" ? `[${node.type}]` : expression;
};

type PresentHandlerKind =
  | "inline-function"
  | "identifier"
  | "member-expression"
  | "dynamic-expression";

/** Classify a handler argument while retaining its exact source range. */
export function handlerKind(node: t.Node): PresentHandlerKind;
export function handlerKind(node: null | undefined): "missing";
export function handlerKind(
  node: t.Node | null | undefined,
): PresentHandlerKind | "missing" {
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
}

/**
 * Nesting bound for dotted contextBridge member paths. Deeper objects count as
 * one unknown member rather than being enumerated.
 */
export const contextBridgeMemberPathDepth = 8;

/**
 * Per-file work and representation budget for contextBridge member enumeration.
 * Bounds shared sub-object DAG expansion before path strings are allocated and
 * records truncated branches as explicit unknown members.
 */
export const contextBridgeMemberVisitLimit = 4_096;
export const contextBridgeMemberByteLimit = 131_072;

export interface ContextBridgeMemberBudget {
  remainingVisits: number;
  remainingBytes: number;
}

export const createContextBridgeMemberBudget =
  (): ContextBridgeMemberBudget => ({
    remainingVisits: contextBridgeMemberVisitLimit,
    remainingBytes: contextBridgeMemberByteLimit,
  });

export type ContextBridgeNestedPropertyResolution =
  | {
      readonly kind: "object";
      readonly object: t.ObjectExpression;
      readonly activeNodes: ReadonlySet<t.Node>;
    }
  | { readonly kind: "leaf" }
  | { readonly kind: "unknown" };

export type ContextBridgeNestedPropertyResolver = (
  value: t.Node,
  activeNodes: ReadonlySet<t.Node>,
) => ContextBridgeNestedPropertyResolution;

/** Collect statically visible dotted keys or direct callable shape from one contextBridge API argument. */
export const collectContextBridgeMembers = (
  node: t.Node | null | undefined,
  resolveNestedProperty?: ContextBridgeNestedPropertyResolver,
  budget: ContextBridgeMemberBudget = createContextBridgeMemberBudget(),
): {
  readonly status: "object-literal" | "function" | "dynamic" | "missing";
  readonly members: readonly string[];
  readonly unknown: number;
} => {
  if (node === null || node === undefined)
    return {
      status: "missing",
      members: [],
      unknown: 0,
    };
  const unwrapped = unwrapJavaScriptExpression(node).node;
  if (
    t.isArrowFunctionExpression(unwrapped) ||
    t.isFunctionExpression(unwrapped) ||
    t.isFunctionDeclaration(unwrapped)
  )
    return {
      status: "function",
      members: [],
      unknown: 0,
    };
  if (!t.isObjectExpression(unwrapped))
    return {
      status: "dynamic",
      members: [],
      unknown: 1,
    };
  const state: { members: string[]; unknown: number } = {
    members: [],
    unknown: 0,
  };
  collectMembersAt(
    unwrapped,
    "",
    0,
    0,
    state,
    new Set([unwrapped]),
    budget,
    resolveNestedProperty,
  );
  const members = [...new Set(state.members)].sort(compareUnicodeCodePoints);
  return {
    status: state.unknown === 0 ? "object-literal" : "dynamic",
    members,
    unknown: state.unknown,
  };
};

const collectMembersAt = (
  object: t.ObjectExpression,
  prefixPath: string,
  prefixDepth: number,
  prefixBytes: number,
  state: { members: string[]; unknown: number },
  activeNodes: ReadonlySet<t.Node>,
  budget: ContextBridgeMemberBudget,
  resolveNestedProperty?: ContextBridgeNestedPropertyResolver,
): void => {
  if (prefixDepth >= contextBridgeMemberPathDepth) {
    state.unknown += 1;
    return;
  }
  for (let index = 0; index < object.properties.length; index += 1) {
    if (budget.remainingVisits <= 0) {
      state.unknown += object.properties.length - index;
      return;
    }
    budget.remainingVisits -= 1;
    const property = object.properties[index];
    if (property === undefined) break;
    if (t.isSpreadElement(property)) {
      state.unknown += 1;
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name === null) {
      state.unknown += 1;
      continue;
    }
    if (
      t.isObjectProperty(property) &&
      !property.computed &&
      !property.shorthand &&
      name === "__proto__"
    )
      continue;
    const nameBytes = Buffer.byteLength(name, "utf8");
    const pathBytes =
      prefixDepth === 0 ? nameBytes : prefixBytes + 1 + nameBytes;
    if (pathBytes > budget.remainingBytes) {
      budget.remainingVisits = 0;
      state.unknown += object.properties.length - index;
      return;
    }
    budget.remainingBytes -= pathBytes;
    const path = prefixDepth === 0 ? name : `${prefixPath}.${name}`;
    state.members.push(path);
    if (!t.isObjectProperty(property)) continue;
    if (resolveNestedProperty !== undefined) {
      const nested = resolveNestedProperty(property.value, activeNodes);
      if (nested.kind === "object")
        collectMembersAt(
          nested.object,
          path,
          prefixDepth + 1,
          pathBytes,
          state,
          nested.activeNodes,
          budget,
          resolveNestedProperty,
        );
      else if (nested.kind === "unknown") state.unknown += 1;
      continue;
    }
    const nestedValue = unwrapJavaScriptExpression(property.value).node;
    if (t.isObjectExpression(nestedValue) && !activeNodes.has(nestedValue)) {
      const nextActive = new Set(activeNodes);
      nextActive.add(nestedValue);
      collectMembersAt(
        nestedValue,
        path,
        prefixDepth + 1,
        pathBytes,
        state,
        nextActive,
        budget,
      );
    }
  }
};

const literalValue = (
  node: t.Node | null | undefined,
):
  | { readonly found: true; readonly value: string | number | boolean | null }
  | { readonly found: false } => {
  if (node === null || node === undefined) return { found: false };
  const literal = readExactJavaScriptLiteral(node);
  if (literal.found) return literal;
  if (
    t.isUnaryExpression(node, { operator: "-" }) &&
    t.isNumericLiteral(node.argument)
  ) {
    const value = -node.argument.value;
    return Number.isFinite(value) && !Object.is(value, -0)
      ? { found: true, value }
      : { found: false };
  }
  return { found: false };
};
