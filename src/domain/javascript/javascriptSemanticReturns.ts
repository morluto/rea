import * as t from "@babel/types";

import {
  semanticContainer,
  semanticPropertyPointer,
} from "./javascriptSemanticSlots.js";

import type {
  JavaScriptSemanticCallable,
  JavaScriptSemanticModuleLink,
  JavaScriptSemanticReturnSite,
} from "./javascriptSemanticIr.js";
import type { JavaScriptSemanticValue } from "./javascriptSemanticValueTypes.js";
import type {
  ProjectedPropertyCoverage,
  ProjectedReturnField,
} from "./javascriptExportShapeComparisonSchemas.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { semanticCallableIdForNode } from "./javascriptSemanticProjection.js";
import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import { semanticReturnCoverage } from "./javascriptSemanticCoverage.js";
import {
  childNodes,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

interface ReturnExpression {
  readonly node: t.Node | null;
  readonly location: JavaScriptSemanticReturnSite["location"];
}

/** Evaluate direct returns while excluding every nested callable. */
export const collectSemanticReturns = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  parserPartial: boolean,
): JavaScriptSemanticCallable[] => {
  const nodes = callableNodes(program);
  return state.callables.map((callable) => {
    const node = nodes.get(callable.callableId);
    if (node === undefined)
      return {
        ...callable,
        returnCoverage: {
          status: "partial" as const,
          retainedCount: 0,
          omittedCount: null,
        },
      };
    const expressions = directReturnExpressions(node);
    const sites: JavaScriptSemanticReturnSite[] = [];
    for (const expression of expressions) {
      sites.push({
        returnSiteId: semanticReturnSiteId(
          callable.callableId,
          expression.location,
        ),
        location: expression.location,
        identityReferenceLocation:
          expression.node !== null && t.isIdentifier(expression.node)
            ? range(expression.node)
            : null,
        value:
          expression.node === null
            ? { status: "unknown", reason: "Return has no value." }
            : evaluateSemanticExpression(expression.node, state),
      });
    }
    return {
      ...callable,
      returnSites: sites,
      returnCoverage: semanticReturnCoverage(sites.length, parserPartial),
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
  return state.moduleLinks.map((link) => {
    // Named exports follow their lexical binding, including every assignment.
    // A declaration's ID or a callable's display name cannot prove that link.
    if (link.localName === null)
      return link.callableId !== null && callableIds.has(link.callableId)
        ? link
        : { ...link, callableId: null };
    const binding = state.moduleLinkBindings.get(link);
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

const callableIdsForBinding = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
  admitted: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): string[] => {
  // A single initializer does not prove an assignment executes or replace
  // the unknown incoming value of a parameter/catch binding.
  if (
    seen.has(binding.bindingId) ||
    binding.initializers.length !== 1 ||
    binding.definitions.some(
      ({ kind }) =>
        kind === "assignment" || kind === "parameter" || kind === "catch",
    )
  )
    return [];
  const initializer = binding.initializers[0];
  if (
    initializer === undefined ||
    initializer.projection.length > 0 ||
    state.conditionalInitializers.has(initializer.node)
  )
    return [];
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
  const unwrapped = unwrapJavaScriptExpression(node).node;
  if (unwrapped !== node)
    return callableIdsForNode(unwrapped, state, admitted, seen);
  const direct = semanticCallableIdForNode(node);
  if (direct !== null && admitted.has(direct)) return [direct];
  if (t.isIdentifier(node)) {
    const binding = resolveSemanticBindingState(state, node, node.name);
    return binding === undefined
      ? []
      : callableIdsForBinding(binding, state, admitted, seen);
  }
  return [];
};

/** Flatten a semantic value to bounded JSON-pointer leaves for graph projection. */
export const flattenSemanticReturnValue = (
  value: JavaScriptSemanticValue,
): {
  readonly fields: readonly ProjectedReturnField[];
  readonly propertyCoverage: readonly ProjectedPropertyCoverage[];
} => {
  const fields: ProjectedReturnField[] = [];
  const propertyCoverage: ProjectedPropertyCoverage[] = [];
  flattenValue(value, "", fields, propertyCoverage);
  fields.sort((left, right) => compareUnicodeCodePoints(left.path, right.path));
  propertyCoverage.sort((left, right) =>
    compareUnicodeCodePoints(left.path, right.path),
  );
  return { fields, propertyCoverage };
};

const flattenValue = (
  value: JavaScriptSemanticValue,
  path: string,
  fields: ProjectedReturnField[],
  coverage: ProjectedPropertyCoverage[],
  presence: "present" | "absent" | "unknown-coverage" = "present",
): void => {
  if (presence !== "present") {
    fields.push({
      path,
      presence,
      state: "unknown",
      value: null,
      reason:
        "reason" in value ? value.reason : "Property presence is uncertain.",
    });
    return;
  }
  if (value.status === "literal") {
    fields.push({
      path,
      presence,
      state: "literal",
      value: value.value,
      reason: null,
    });
    return;
  }
  if (value.status === "union") {
    fields.push({
      path,
      presence,
      state: "union",
      value: [...value.values],
      reason: null,
    });
    return;
  }
  if ("reason" in value) {
    fields.push({
      path,
      presence,
      state: "unknown",
      value: null,
      reason: value.reason,
    });
    return;
  }
  const container = semanticContainer(value);
  coverage.push({ path, ...container.coverage });
  for (const slot of container.slots)
    flattenValue(
      slot.value,
      `${path}${semanticPropertyPointer([slot.name])}`,
      fields,
      coverage,
      slot.presence,
    );
};
