import { createHash } from "node:crypto";

import * as t from "@babel/types";

import { compareCodePoints } from "../canonicalOrdering.js";
import type { JavaScriptSemanticCallAnalysis } from "./javascriptSemanticCalls.js";
import type {
  JavaScriptSemanticCallable,
  JavaScriptSemanticChildProcessInteraction,
  JavaScriptSemanticChildProcessSpawn,
  JavaScriptSemanticEventOperation,
  JavaScriptSemanticFunctionFingerprint,
  JavaScriptSemanticPromiseOperation,
  JavaScriptSemanticRequestOperation,
  JavaScriptSemanticResourceOperation,
  JavaScriptSemanticTimerOperation,
} from "./javascriptSemanticIr.js";
import { semanticCallableIdForNode } from "./javascriptSemanticProjection.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

interface SemanticFingerprintCollectionInput {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly callables: readonly JavaScriptSemanticCallable[];
  readonly calls: JavaScriptSemanticCallAnalysis;
  readonly promises: readonly JavaScriptSemanticPromiseOperation[];
  readonly events: readonly JavaScriptSemanticEventOperation[];
  readonly timers: readonly JavaScriptSemanticTimerOperation[];
  readonly childProcessSpawns: readonly JavaScriptSemanticChildProcessSpawn[];
  readonly childProcessInteractions: readonly JavaScriptSemanticChildProcessInteraction[];
  readonly requestOperations: readonly JavaScriptSemanticRequestOperation[];
  readonly resourceOperations: readonly JavaScriptSemanticResourceOperation[];
  readonly parserPartial: boolean;
}

/** Build bounded rename- and formatting-resistant components per callable. */
export const collectJavaScriptSemanticFingerprints = (
  input: SemanticFingerprintCollectionInput,
): JavaScriptSemanticFunctionFingerprint[] => {
  const {
    state,
    callables,
    calls,
    promises,
    events,
    timers,
    childProcessSpawns,
    childProcessInteractions,
    requestOperations,
    resourceOperations,
    parserPartial,
  } = input;
  return callables.flatMap((callable) => {
    if (callable.kind === "class") return [];
    const node = state.callableNodesById.get(callable.callableId);
    if (node === undefined) return [];
    const syntax = fingerprintSyntax(node, callable.callableId);
    const promiseEffects = promises.filter(
      ({ ownerCallableId }) => ownerCallableId === callable.callableId,
    );
    const eventEffects = events.filter(
      ({ ownerCallableId }) => ownerCallableId === callable.callableId,
    );
    const timerEffects = timers.filter(
      ({ ownerCallableId }) => ownerCallableId === callable.callableId,
    );
    const childProcessEffects = [
      ...childProcessSpawns,
      ...childProcessInteractions,
    ].filter(({ ownerCallableId }) => ownerCallableId === callable.callableId);
    const networkEffects = requestOperations.filter(
      ({ ownerCallableId }) => ownerCallableId === callable.callableId,
    );
    const resourceEffects = resourceOperations.filter(
      ({ ownerCallableId }) => ownerCallableId === callable.callableId,
    );
    return [
      {
        callableId: callable.callableId,
        status:
          parserPartial || callable.returnCoverage.status !== "complete"
            ? "partial"
            : "complete",
        components: {
          parameterArity: callableParameterArity(node),
          normalizedAstSha256: digest(syntax.normalizedTokens),
          controlFlowSha256: digest(syntax.controlFlowTokens),
          relationShapeSha256: digest(
            relationShape(callable, calls, promiseEffects),
          ),
          literalSetSha256: digest(
            [...new Set(syntax.literals)].sort(compareCodePoints),
          ),
          effects: [
            ...(isAsyncCallable(node) ? (["async"] as const) : []),
            ...(childProcessEffects.length > 0
              ? (["child-process"] as const)
              : []),
            ...(eventEffects.length > 0 ? (["event"] as const) : []),
            ...(networkEffects.length > 0 ? (["network"] as const) : []),
            ...(promiseEffects.length > 0 ? (["promise"] as const) : []),
            ...(resourceEffects.length > 0 ? (["resource"] as const) : []),
            ...(timerEffects.length > 0 ? (["timer"] as const) : []),
          ],
        },
        limitations: [
          "The fingerprint is a static candidate and does not prove behavioral equivalence.",
          ...(parserPartial
            ? ["Incomplete semantic recovery makes this fingerprint partial."]
            : []),
        ],
      },
    ];
  });
};

interface FingerprintSyntax {
  readonly normalizedTokens: readonly string[];
  readonly controlFlowTokens: readonly string[];
  readonly literals: readonly string[];
}

const fingerprintSyntax = (
  root: t.Node,
  targetCallableId: string,
): FingerprintSyntax => {
  const normalizedTokens: string[] = [];
  const controlFlowTokens: string[] = [];
  const literals: string[] = [];
  const callableStack: string[] = [];
  traverseJavaScriptAst(root, {
    enter: (node, parent) => {
      const callableId = semanticCallableIdForNode(node);
      if (callableId !== null) callableStack.push(callableId);
      if (callableStack.at(-1) !== targetCallableId) return;
      normalizedTokens.push(normalizedNodeToken(node, parent));
      const control = controlFlowToken(node);
      if (control !== null) controlFlowTokens.push(control);
      const literal = semanticLiteral(node);
      if (literal !== null) literals.push(literal);
    },
    exit: (node) => {
      const callableId = semanticCallableIdForNode(node);
      if (callableId !== null && callableStack.at(-1) === callableId)
        callableStack.pop();
    },
  });
  return { normalizedTokens, controlFlowTokens, literals };
};

const normalizedNodeToken = (node: t.Node, parent: t.Node | null): string => {
  if (t.isIdentifier(node))
    return propertyIdentity(node, parent)
      ? `property:${node.name}`
      : "identifier";
  if (t.isStringLiteral(node))
    return propertyIdentity(node, parent)
      ? `property:${node.value}`
      : "string-literal";
  const attributes = [
    primitiveAttribute(node, "operator"),
    primitiveAttribute(node, "kind"),
    primitiveAttribute(node, "computed"),
    primitiveAttribute(node, "optional"),
    primitiveAttribute(node, "async"),
    primitiveAttribute(node, "generator"),
  ].filter((value): value is string => value !== null);
  return [node.type, ...attributes].join(":");
};

const primitiveAttribute = (node: t.Node, key: string): string | null => {
  const value: unknown = Reflect.get(node, key);
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? `${key}=${String(value)}`
    : null;
};

const propertyIdentity = (node: t.Node, parent: t.Node | null): boolean => {
  if (parent === null) return false;
  if (
    (t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) &&
    parent.property === node
  )
    return !parent.computed || t.isStringLiteral(node);
  if (
    (t.isObjectProperty(parent) ||
      t.isObjectMethod(parent) ||
      t.isClassMethod(parent) ||
      t.isClassProperty(parent)) &&
    parent.key === node
  )
    return !parent.computed || t.isStringLiteral(node);
  return false;
};

const controlFlowToken = (node: t.Node): string | null => {
  if (
    !t.isIfStatement(node) &&
    !t.isConditionalExpression(node) &&
    !t.isSwitchStatement(node) &&
    !t.isSwitchCase(node) &&
    !t.isLoop(node) &&
    !t.isTryStatement(node) &&
    !t.isCatchClause(node) &&
    !t.isReturnStatement(node) &&
    !t.isThrowStatement(node) &&
    !t.isAwaitExpression(node) &&
    !t.isYieldExpression(node) &&
    !t.isLogicalExpression(node)
  )
    return null;
  const operator = primitiveAttribute(node, "operator");
  return operator === null ? node.type : `${node.type}:${operator}`;
};

const semanticLiteral = (node: t.Node): string | null => {
  if (t.isStringLiteral(node)) return `string:${node.value}`;
  if (t.isNumericLiteral(node)) return `number:${String(node.value)}`;
  if (t.isBooleanLiteral(node)) return `boolean:${String(node.value)}`;
  if (t.isNullLiteral(node)) return "null";
  if (t.isBigIntLiteral(node)) return `bigint:${node.value}`;
  if (t.isRegExpLiteral(node)) return `regexp:${node.pattern}/${node.flags}`;
  if (t.isTemplateElement(node))
    return `template:${node.value.cooked ?? node.value.raw}`;
  return null;
};

const relationShape = (
  callable: JavaScriptSemanticCallable,
  calls: JavaScriptSemanticCallAnalysis,
  promises: readonly JavaScriptSemanticPromiseOperation[],
): string[] => [
  `returns:${String(callable.returnSites.length)}:${callable.returnCoverage.status}`,
  ...calls.callSites
    .filter(({ callerCallableId }) => callerCallableId === callable.callableId)
    .map(
      ({ kind, resolution, arguments: args, calleeCallableIds }) =>
        `call:${kind}:${resolution}:${String(args.length)}:${String(calleeCallableIds.length)}`,
    ),
  `captures:${String(
    calls.closureCaptures.filter(
      ({ callableId }) => callableId === callable.callableId,
    ).length,
  )}`,
  ...promises.map(
    ({ kind, method, ownership, sourceResolution }) =>
      `promise:${kind}:${method}:${ownership}:${sourceResolution}`,
  ),
];

const callableParameterArity = (node: t.Node): number =>
  t.isFunction(node) ? node.params.length : 0;

const isAsyncCallable = (node: t.Node): boolean =>
  t.isFunction(node) && node.async;

const digest = (value: readonly string[]): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
