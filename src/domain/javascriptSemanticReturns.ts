import * as t from "@babel/types";

import type {
  JavaScriptSemanticCallable,
  JavaScriptSemanticModuleLink,
  JavaScriptSemanticReturnSite,
  JavaScriptSemanticValue,
} from "./javascriptSemanticIr.js";
import {
  reachSemanticLimit,
  semanticCallableIdForNode,
} from "./javascriptSemanticProjection.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";
import { compareCodePoints, range } from "./javascriptStaticAnalysisHelpers.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

interface ReturnExpression {
  readonly node: t.Node | null;
  readonly location: JavaScriptSemanticReturnSite["location"];
}

/** Evaluate bounded direct returns while excluding every nested callable. */
export const collectSemanticReturns = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  parserPartial: boolean,
): JavaScriptSemanticCallable[] => {
  const nodes = callableNodes(program);
  let retained = 0;
  return state.callables.map((callable) => {
    const node = nodes.get(callable.callableId);
    if (node === undefined)
      return {
        ...callable,
        returnCoverage: {
          status: "partial" as const,
          retainedCount: 0,
          omittedCount: null,
          limitsReached: [],
        },
      };
    const expressions = directReturnExpressions(node);
    const sites: JavaScriptSemanticReturnSite[] = [];
    let omitted = 0;
    for (const expression of expressions) {
      if (retained >= state.limits.maxReturnSites) {
        omitted += 1;
        reachSemanticLimit(state, "maxReturnSites");
        continue;
      }
      retained += 1;
      sites.push({
        returnSiteId: semanticReturnSiteId(
          callable.callableId,
          expression.location,
        ),
        location: expression.location,
        value:
          expression.node === null
            ? { status: "unknown", reason: "Return has no value." }
            : evaluateSemanticExpression(expression.node, state),
      });
    }
    return {
      ...callable,
      returnSites: sites,
      returnCoverage: {
        status:
          omitted > 0 ? "truncated" : parserPartial ? "partial" : "complete",
        retainedCount: sites.length,
        omittedCount: omitted,
        limitsReached: omitted > 0 ? ["maxReturnSites"] : [],
      },
    };
  });
};

const semanticReturnSiteId = (
  callableId: string,
  location: JavaScriptSemanticReturnSite["location"],
): string =>
  `${callableId}:return:${String(location.start.line)}:${String(location.start.column)}:${String(location.end.line)}:${String(location.end.column)}`;

/** Link exports to callables only when lexical resolution is unique and exact. */
export const resolveSemanticModuleCallables = (
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): JavaScriptSemanticModuleLink[] => {
  const callableIds = new Set(callables.map(({ callableId }) => callableId));
  const root = state.scopes.find(({ kind }) => kind === "program");
  return state.moduleLinks.map((link) => {
    if (link.callableId !== null && callableIds.has(link.callableId))
      return link;
    if (link.localName === null || root === undefined)
      return { ...link, callableId: null };
    const named = callables.filter(
      ({ name, containerScopeId }) =>
        name === link.localName && containerScopeId === root.scopeId,
    );
    if (named.length === 1)
      return { ...link, callableId: named[0]?.callableId ?? null };
    const binding = root.bindings.get(link.localName);
    const resolved =
      binding === undefined
        ? []
        : callableIdsForBinding(binding, state, callableIds, new Set());
    return {
      ...link,
      callableId: resolved.length === 1 ? (resolved[0] ?? null) : null,
    };
  });
};

const callableNodes = (program: t.Program): Map<string, t.Node> => {
  const output = new Map<string, t.Node>();
  traverseJavaScriptAst(program, {
    enter: (node) => {
      const id = semanticCallableIdForNode(node);
      if (id !== null) output.set(id, node);
    },
  });
  return output;
};

const directReturnExpressions = (callable: t.Node): ReturnExpression[] => {
  if (
    t.isArrowFunctionExpression(callable) &&
    !t.isBlockStatement(callable.body)
  )
    return [{ node: callable.body, location: range(callable.body) }];
  if (!t.isFunction(callable)) return [];
  const output: ReturnExpression[] = [];
  const visit = (node: t.Node): void => {
    if (t.isFunction(node) || t.isClass(node)) return;
    if (t.isReturnStatement(node)) {
      output.push({ node: node.argument ?? null, location: range(node) });
      return;
    }
    for (const child of childNodes(node)) visit(child);
  };
  for (const child of childNodes(callable.body)) visit(child);
  return output;
};

const childNodes = (node: t.Node): t.Node[] =>
  (t.VISITOR_KEYS[node.type] ?? []).flatMap((key) => {
    const value: unknown = Reflect.get(node, key);
    if (t.isNode(value)) return [value];
    return Array.isArray(value)
      ? value.filter((item): item is t.Node => t.isNode(item))
      : [];
  });

const callableIdsForBinding = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
  admitted: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): string[] => {
  if (seen.has(binding.bindingId) || binding.initializers.length !== 1)
    return [];
  const initializer = binding.initializers[0];
  if (initializer === undefined || initializer.projection.length > 0) return [];
  return callableIdsForNode(
    initializer.node,
    state,
    admitted,
    new Set([...seen, binding.bindingId]),
  );
};

const callableIdsForNode = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  admitted: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): string[] => {
  const direct = semanticCallableIdForNode(node);
  if (direct !== null && admitted.has(direct)) return [direct];
  if (t.isIdentifier(node)) {
    const binding = resolveSemanticBindingState(state, node, node.name);
    return binding === undefined
      ? []
      : callableIdsForBinding(binding, state, admitted, seen);
  }
  if (
    t.isTSAsExpression(node) ||
    t.isTSTypeAssertion(node) ||
    t.isTSNonNullExpression(node)
  )
    return callableIdsForNode(node.expression, state, admitted, seen);
  return [];
};

/** Flatten a semantic value to bounded JSON-pointer leaves for graph projection. */
export const flattenSemanticReturnValue = (
  value: JavaScriptSemanticValue,
): {
  readonly fields: readonly {
    readonly path: string;
    readonly state: "literal" | "union" | "unknown";
    readonly value: unknown;
    readonly reason: string | null;
  }[];
  readonly propertyCoverage: readonly {
    readonly path: string;
    readonly status: "complete" | "partial";
    readonly omitted: number | null;
  }[];
} => {
  const fields: {
    path: string;
    state: "literal" | "union" | "unknown";
    value: unknown;
    reason: string | null;
  }[] = [];
  const propertyCoverage: {
    path: string;
    status: "complete" | "partial";
    omitted: number | null;
  }[] = [];
  flattenValue(value, "", fields, propertyCoverage);
  fields.sort((left, right) => compareCodePoints(left.path, right.path));
  propertyCoverage.sort((left, right) =>
    compareCodePoints(left.path, right.path),
  );
  return { fields, propertyCoverage };
};

const flattenValue = (
  value: JavaScriptSemanticValue,
  path: string,
  fields: {
    path: string;
    state: "literal" | "union" | "unknown";
    value: unknown;
    reason: string | null;
  }[],
  coverage: {
    path: string;
    status: "complete" | "partial";
    omitted: number | null;
  }[],
): void => {
  if (value.status === "literal") {
    fields.push({ path, state: "literal", value: value.value, reason: null });
    return;
  }
  if (value.status === "union") {
    fields.push({
      path,
      state: "union",
      value: [...value.values],
      reason: null,
    });
    return;
  }
  if (value.status === "object") {
    coverage.push({
      path,
      status: value.unknownProperties ? "partial" : "complete",
      omitted: value.omittedProperties,
    });
    for (const property of value.properties)
      flattenValue(
        property.value,
        `${path}/${escapePointer(property.name)}`,
        fields,
        coverage,
      );
    return;
  }
  if (value.status === "array") {
    coverage.push({
      path,
      status: value.unknownItems ? "partial" : "complete",
      omitted: value.omittedItems,
    });
    value.items.forEach((item, index) =>
      flattenValue(item, `${path}/${String(index)}`, fields, coverage),
    );
    return;
  }
  fields.push({ path, state: "unknown", value: null, reason: value.reason });
};

const escapePointer = (value: string): string =>
  value.replaceAll("~", "~0").replaceAll("/", "~1");
