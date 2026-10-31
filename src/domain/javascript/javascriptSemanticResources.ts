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
      tlsOptionsReplaceFirstArgument(candidate, context) ||
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

/** Whether a number Node accepts as a TCP port. */
const usablePort = (bits: number): boolean =>
  Number.isInteger(bits) && bits >= 0 && bits <= 65535;

/**
 * Whether an exactly readable value is not a usable port. Omission and an empty
 * object throw `ERR_MISSING_ARGS`, which is a missing option rather than a bad
 * one, so they stay undecided here.
 *
 * A positional string is a Unix socket path, so only the empty string is
 * rejected there. The `port` member of an options object is a port instead, and
 * Node coerces it with `Number`, so `"0x50"` and `"8e1"` are valid while
 * `"65536"` and `"abc"` are not.
 */
const rejectsPortValue = (
  value: t.Node,
  context: DataEffectTraversalContext,
  stringIsPath: boolean,
): boolean => {
  if (t.isStringLiteral(value))
    return stringIsPath
      ? value.value.length === 0
      : value.value === "" || !usablePort(Number(value.value));
  if (
    t.isNullLiteral(value) ||
    t.isBigIntLiteral(value) ||
    t.isBooleanLiteral(value) ||
    t.isObjectExpression(value) ||
    t.isArrayExpression(value)
  )
    return true;
  if (t.isNumericLiteral(value)) return !usablePort(value.value);
  // `NaN` and `Infinity` are unshadowed globals, and neither is a port.
  if (
    t.isIdentifier(value) &&
    (value.name === "NaN" || value.name === "Infinity") &&
    isUnmodifiedGlobalReference(value, context.state, value.name)
  )
    return true;
  // A unary operator is judged by its result, not by its operand.
  if (t.isUnaryExpression(value)) {
    // `typeof` yields a non-empty type name, which Node reads as a Unix socket
    // path rather than a port.
    if (value.operator === "typeof") return false;
    // `void` yields `undefined` and `!` yields a boolean; both throw before a
    // socket exists.
    if (value.operator === "void" || value.operator === "!") return true;
    const operand = unwrapJavaScriptExpression(value.argument).node;
    if (!t.isNumericLiteral(operand)) return false;
    const bits =
      value.operator === "-"
        ? -operand.value
        : value.operator === "+"
          ? operand.value
          : value.operator === "~"
            ? ~operand.value
            : undefined;
    // `-0` and `~-1` are both zero, which is the valid lowest port.
    return bits === undefined ? false : !usablePort(bits);
  }
  return false;
};

/**
 * The value of the last readable member named `name`. `undefined` means the
 * object has no such member and `null` means one is present but not exactly
 * readable, because JavaScript uses the last matching member and a later spread
 * or computed key can add or override one.
 */
const lastMemberValue = (
  object: t.ObjectExpression,
  name: string,
): t.Node | null | undefined => {
  for (let index = object.properties.length - 1; index >= 0; index -= 1) {
    const property = object.properties[index];
    if (property === undefined) continue;
    if (!t.isObjectProperty(property) || property.computed) return null;
    if (semanticStaticPropertyName(property.key, false) !== name) continue;
    return unwrapJavaScriptExpression(property.value).node;
  }
  return undefined;
};

/**
 * Whether an options object proves it selects a Unix socket, in which case Node
 * never validates `port`. `true` is a non-empty literal `path`; `null` means the
 * `path` member is present but not readable, so a socket may still be selected.
 */
const optionsSelectUnixSocket = (
  object: t.ObjectExpression,
): boolean | null => {
  const path = lastMemberValue(object, "path");
  if (path === null) return null;
  if (path === undefined) return false;
  if (!t.isStringLiteral(path)) return null;
  return path.value !== "";
};

/**
 * Whether an options object supplies a usable port of its own, which is what
 * makes `tls.connect(-1, { port: 443 })` succeed. `null` means the member is not
 * readable, so the answer stays open.
 */
const optionsSupplyPort = (
  object: t.ObjectExpression,
  context: DataEffectTraversalContext,
): boolean | null => {
  const port = lastMemberValue(object, "port");
  if (port === undefined) return false;
  if (port === null) return null;
  return !rejectsPortValue(port, context, false);
};

/**
 * `net` and `tls` validate a numeric port before creating a socket, so a
 * literal port Node rejects throws synchronously and no socket exists. Only an
 * exactly readable value is decided.
 */
const rejectsSocketPortLiteral = (
  node: t.CallExpression | t.OptionalCallExpression,
  context: DataEffectTraversalContext,
): boolean => {
  const port = node.arguments[0];
  if (port === undefined || t.isSpreadElement(port)) return false;
  const value = unwrapJavaScriptExpression(port).node;
  // `net.connect({ port })` validates the member the same way the positional
  // form validates the argument, but a Unix socket path member wins over it.
  if (t.isObjectExpression(value)) {
    const socket = optionsSelectUnixSocket(value);
    if (socket !== false) return false;
    const member = lastMemberValue(value, "port");
    return member === undefined || member === null
      ? false
      : rejectsPortValue(member, context, false);
  }
  return rejectsPortValue(value, context, true);
};

/** Only `net`/`tls` sockets take a port in argument 0. */
const socketPortInFirstArgument = (
  candidate: Pick<AcquisitionReference, "specifier">,
): boolean => candidate.specifier === "net" || candidate.specifier === "tls";

/**
 * `tls.connect` merges a later options object over its first argument, so
 * `tls.connect(-1, { port: 443 })` creates a socket even though `-1` is not a
 * port. Only an object that actually supplies its own port or Unix socket path
 * rescues the argument: `tls.connect(-1, {})` and
 * `tls.connect(65536, { servername: "x" })` still throw. Node's `net.connect`
 * keeps validating the argument, so the rescue applies to `tls` only.
 */
const tlsOptionsReplaceFirstArgument = (
  candidate: ResourceCandidate,
  context: DataEffectTraversalContext,
): boolean => {
  if (candidate.specifier !== "tls") return false;
  const options = candidate.node.arguments[1];
  if (options === undefined || !t.isObjectExpression(options)) return false;
  const socket = optionsSelectUnixSocket(options);
  if (socket !== false) return true;
  const port = optionsSupplyPort(options, context);
  return port !== false;
};
