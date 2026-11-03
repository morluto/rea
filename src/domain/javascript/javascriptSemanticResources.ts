import * as t from "@babel/types";

import {
  BUILTIN_RESOURCE_SPECIFIERS,
  BUILTIN_RESOURCE_METHODS,
  BUILTIN_RESOURCE_RELEASE_METHODS,
} from "./javascriptBuiltinResourceMethods.js";
import type {
  JavaScriptSemanticCallable,
  JavaScriptSemanticResourceOperation,
} from "./javascriptSemanticIr.js";
import {
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { isUnmodifiedGlobalReference } from "./javascriptSemanticAmbientWrites.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  builtinDataEffectMethod,
  dataEffectMemberCallee,
  outerDataEffectBinding,
  traverseDataEffects,
  type DataEffectTraversalContext,
} from "./javascriptSemanticDataEffectHelpers.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import { SEMANTIC_EXPRESSION_DEPTH_LIMIT } from "./javascriptSemanticResourceLimits.js";

const RELEASE_METHODS = ["close", "destroy", "end"] as const;

/**
 * Release methods the value from this acquisition actually has. An unlisted
 * specifier/method pair admits none, so a call to it emits no release fact.
 */
const releaseMethodsFor = (
  acquisition: ResourceCandidate,
): readonly ("close" | "destroy" | "end")[] => {
  const key = `${acquisition.specifier}:${acquisition.method}`;
  const table: Readonly<
    Record<string, readonly ("close" | "destroy" | "end")[]>
  > = BUILTIN_RESOURCE_RELEASE_METHODS;
  return table[key] ?? [];
};

interface ResourceCandidate {
  readonly node: t.CallExpression | t.OptionalCallExpression;
  readonly specifier: string;
  readonly method: JavaScriptSemanticResourceOperation["method"];
  readonly ownerCallableId: string | null;
  readonly resultBindingId: string | null;
}

/** Recover built-in filesystem/network acquisition and local release handles. */
export const collectJavaScriptSemanticResources = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): JavaScriptSemanticResourceOperation[] => {
  const context: DataEffectTraversalContext = {
    state,
    callableIds: new Set(callables.map(({ callableId }) => callableId)),
    callableStack: [],
    ancestors: [],
  };
  const acquisitions = collectAcquisitions(program, context).filter(
    (candidate) =>
      !socketPortInFirstArgument(candidate) ||
      !rejectsSocketPortLiteral(candidate.node, context),
  );
  return [
    ...acquisitions.map(immutableAcquisition),
    ...collectReleases(program, context, acquisitions),
  ];
};

const collectAcquisitions = (
  program: t.Program,
  context: DataEffectTraversalContext,
): ResourceCandidate[] => {
  const output: ResourceCandidate[] = [];
  traverseDataEffects(program, context, (node) => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
    const reference = acquisitionMethod(node.callee, context.state);
    if (reference === null) return;
    output.push({
      node,
      specifier: reference.specifier,
      method: reference.method,
      ownerCallableId: context.callableStack.at(-1) ?? null,
      resultBindingId: outerDataEffectBinding(node, context),
    });
  });
  return output;
};

const collectReleases = (
  program: t.Program,
  context: DataEffectTraversalContext,
  acquisitions: readonly ResourceCandidate[],
): JavaScriptSemanticResourceOperation[] => {
  const byBinding = new Map<string, ResourceCandidate[]>();
  for (const acquisition of acquisitions) {
    if (acquisition.resultBindingId === null) continue;
    const existing = byBinding.get(acquisition.resultBindingId) ?? [];
    existing.push(acquisition);
    byBinding.set(acquisition.resultBindingId, existing);
  }
  const output: JavaScriptSemanticResourceOperation[] = [];
  traverseDataEffects(program, context, (node) => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
    const member = dataEffectMemberCallee(node);
    if (member === null || !t.isIdentifier(member.object)) return;
    const method = RELEASE_METHODS.find(
      (candidate) =>
        candidate ===
        semanticStaticPropertyName(member.property, member.computed),
    );
    if (method === undefined) return;
    const binding = resolveSemanticBindingState(
      context.state,
      member.object,
      member.object.name,
    );
    const candidates =
      binding === undefined ? [] : (byBinding.get(binding.bindingId) ?? []);
    if (binding === undefined || candidates.length === 0) return;
    const linked = candidates.filter((acquisition) =>
      releaseMethodsFor(acquisition).includes(method),
    );
    // No linked acquisition exposes this release method, so the call is not a
    // release of it at all: Node throws at the call site instead.
    if (linked.length === 0) return;
    output.push({
      resourceId: `resource:release:${String(node.start ?? -1)}:${String(node.end ?? -1)}`,
      kind: "release",
      method,
      location: range(node),
      ownerCallableId: context.callableStack.at(-1) ?? null,
      resultBindingId: binding.bindingId,
      linkedResourceIds: linked.map(resourceCandidateId).sort(),
      resolution:
        linked.length === 1 &&
        holdsOnlyAcquisitions(binding, linked, context.state)
          ? "complete"
          : "partial",
    });
  });
  return output;
};

/**
 * A lexical handle identifies its acquisition only while every value written
 * to the binding is that acquisition itself. Any replacement, even a
 * conditional or later one, leaves the released resource a candidate. A
 * nullish placeholder, as in `let h = null; try { h = open() } finally {
 * h?.close() }`, releases nothing else: the call is skipped or throws.
 */
const holdsOnlyAcquisitions = (
  binding: JavaScriptSemanticBindingState,
  linked: readonly ResourceCandidate[],
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  [...binding.initializers, ...binding.referenceInitializers].every(
    ({ node, projection }) => {
      if (projection.length > 0) return false;
      let value = unwrapJavaScriptExpression(node).node;
      if (t.isAwaitExpression(value))
        value = unwrapJavaScriptExpression(value.argument).node;
      return (
        isNullishPlaceholder(value, state) ||
        linked.some((acquisition) => acquisition.node === value)
      );
    },
  );

const isNullishPlaceholder = (
  value: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  t.isNullLiteral(value) ||
  t.isUnaryExpression(value, { operator: "void" }) ||
  isUnmodifiedGlobalReference(value, state, "undefined");

const immutableAcquisition = (
  candidate: ResourceCandidate,
): JavaScriptSemanticResourceOperation => ({
  resourceId: resourceCandidateId(candidate),
  kind: "acquire",
  method: candidate.method,
  location: range(candidate.node),
  ownerCallableId: candidate.ownerCallableId,
  resultBindingId: candidate.resultBindingId,
  linkedResourceIds: [],
  resolution: "complete",
});

interface AcquisitionReference {
  readonly specifier: string;
  readonly method: JavaScriptSemanticResourceOperation["method"];
}

const acquisitionMethod = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
): AcquisitionReference | null => {
  for (const specifier of BUILTIN_RESOURCE_SPECIFIERS) {
    const method = builtinDataEffectMethod(callee, state, [specifier]);
    if (
      method !== null &&
      (
        BUILTIN_RESOURCE_METHODS[
          specifier as keyof typeof BUILTIN_RESOURCE_METHODS
        ] as readonly string[]
      ).includes(method)
    )
      return {
        specifier,
        method: method as JavaScriptSemanticResourceOperation["method"],
      };
  }
  return null;
};
const resourceCandidateId = (candidate: ResourceCandidate): string =>
  `resource:acquire:${String(candidate.node.start ?? -1)}:${String(candidate.node.end ?? -1)}`;

/** One exactly evaluated first argument of a `net`/`tls` socket call. */
type ExactSocketArgument =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "null" }
  | { readonly kind: "undefined" }
  | { readonly kind: "bigint" };

/** ECMAScript ToBoolean of an exact argument; a BigInt's digits are not read. */
const socketArgumentTruthiness = (
  operand: ExactSocketArgument,
): boolean | undefined => {
  switch (operand.kind) {
    case "number":
      return operand.value !== 0 && !Number.isNaN(operand.value);
    case "string":
      return operand.value.length > 0;
    case "boolean":
      return operand.value;
    case "null":
    case "undefined":
      return false;
    case "bigint":
      return undefined;
  }
};

/** ECMAScript ToNumber of an exact argument; strings and BigInts stay undecided. */
const socketArgumentNumber = (
  operand: ExactSocketArgument,
): number | undefined => {
  switch (operand.kind) {
    case "number":
      return operand.value;
    case "boolean":
      return Number(operand.value);
    case "null":
      return 0;
    case "undefined":
      return NaN;
    case "string":
    case "bigint":
      return undefined;
  }
};

/**
 * Apply one unary operator with runtime semantics: `-0` stays negative zero,
 * `~` truncates to a signed 32-bit integer, `!` and `typeof` change the type,
 * and `void` yields `undefined`. `-` and `~` keep a BigInt a BigInt, while `+`
 * on a BigInt throws before the call and `delete`/`throw` are not evaluated;
 * those stay undecided.
 */
const unarySocketArgument = (
  operator: t.UnaryExpression["operator"],
  operand: ExactSocketArgument,
): ExactSocketArgument | undefined => {
  switch (operator) {
    case "!": {
      const truthy = socketArgumentTruthiness(operand);
      return truthy === undefined
        ? undefined
        : { kind: "boolean", value: !truthy };
    }
    case "typeof":
      return {
        kind: "string",
        value: operand.kind === "null" ? "object" : operand.kind,
      };
    case "void":
      return { kind: "undefined" };
    case "-":
    case "+":
    case "~": {
      if (operand.kind === "bigint")
        return operator === "+" ? undefined : operand;
      const value = socketArgumentNumber(operand);
      if (value === undefined) return undefined;
      return {
        kind: "number",
        value: operator === "-" ? -value : operator === "~" ? ~value : value,
      };
    }
    default:
      return undefined;
  }
};

/**
 * Evaluate a socket call's first argument only when its syntax commits to one
 * runtime value: a literal, an unshadowed `NaN` or `Infinity`, or a unary
 * operator over such a value. Everything else stays undecided.
 */
const exactSocketArgument = (
  node: t.Node,
  context: DataEffectTraversalContext,
  depth: number,
): ExactSocketArgument | undefined => {
  const unwrapped = unwrapJavaScriptExpression(node);
  const remaining = depth - unwrapped.depth - 1;
  if (remaining < 0) {
    context.state.valueResourceLimits.add("expression-depth");
    return undefined;
  }
  const value = unwrapped.node;
  if (t.isStringLiteral(value)) return { kind: "string", value: value.value };
  if (t.isNumericLiteral(value)) return { kind: "number", value: value.value };
  if (t.isBooleanLiteral(value)) return { kind: "boolean", value: value.value };
  if (t.isNullLiteral(value)) return { kind: "null" };
  if (t.isBigIntLiteral(value)) return { kind: "bigint" };
  // `NaN` and `Infinity` are unshadowed globals, and neither is a port.
  if (
    t.isIdentifier(value) &&
    (value.name === "NaN" || value.name === "Infinity") &&
    isUnmodifiedGlobalReference(value, context.state, value.name)
  )
    return { kind: "number", value: value.name === "NaN" ? NaN : Infinity };
  if (t.isUnaryExpression(value)) {
    const operand = exactSocketArgument(value.argument, context, remaining);
    return operand === undefined
      ? undefined
      : unarySocketArgument(value.operator, operand);
  }
  return undefined;
};

/**
 * `net` and `tls` validate the first argument before creating a socket, so an
 * exactly known value that Node rejects means no socket exists: a number that
 * is fractional, non-finite or outside `[0, 65535]`, a boolean, `null` or
 * BigInt, or `""` (a path with no length). Negative zero is the accepted port
 * `0`. A non-empty string is a Unix socket path and an object may carry a
 * path, so those stay undecided, as does `undefined`, whose `ERR_MISSING_ARGS`
 * is a missing option rather than a bad port.
 */
const rejectsSocketPortLiteral = (
  node: t.CallExpression | t.OptionalCallExpression,
  context: DataEffectTraversalContext,
): boolean => {
  const port = node.arguments[0];
  if (port === undefined || t.isSpreadElement(port)) return false;
  const argument = exactSocketArgument(
    port,
    context,
    SEMANTIC_EXPRESSION_DEPTH_LIMIT,
  );
  if (argument === undefined) return false;
  switch (argument.kind) {
    case "number":
      return (
        !Number.isInteger(argument.value) ||
        argument.value < 0 ||
        argument.value > 65535
      );
    case "string":
      return argument.value.length === 0;
    case "undefined":
      return false;
    case "boolean":
    case "null":
    case "bigint":
      return true;
  }
};

/** Only `net`/`tls` sockets take a port in argument 0. */
const socketPortInFirstArgument = (
  candidate: Pick<AcquisitionReference, "specifier">,
): boolean => candidate.specifier === "net" || candidate.specifier === "tls";
