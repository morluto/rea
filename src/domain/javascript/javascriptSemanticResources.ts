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
  readExactJavaScriptLiteral,
  staticObjectProperty,
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
import { FS_OPEN_FLAGS, range } from "./javascriptStaticAnalysisHelpers.js";

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
    (candidate) => {
      if (!socketPortInFirstArgument(candidate)) return true;
      if (rejectsSocketPortLiteral(candidate.node, context)) return false;
      // `net.connect({ port })` and `tls.connect({ port })` validate the same
      // values inside an options object, so a provably bad one throws before a
      // socket exists.
      const options = socketOptionsObject(candidate.node);
      if (options === undefined) return true;
      return !rejectsOptionsPortLiteral(options, candidate.specifier, context);
    },
  );
  return [
    ...acquisitions.map(immutableAcquisition),
    ...collectReleases(program, context, acquisitions),
  ];
};

/**
 * `fs.open`/`fs.openSync` validate the flag before touching the filesystem, so
 * a flag Node rejects at the call site throws synchronously and no descriptor
 * exists. Node accepts only a known flag string, a nullish value (which defaults
 * to `"r"`), or a bitmask integer; everything else throws. A computed value may
 * still be valid, so only an exactly readable literal is decided.
 */
const rejectsOpenFlagLiteral = (
  node: t.CallExpression | t.OptionalCallExpression,
  context: DataEffectTraversalContext,
): boolean => {
  // A spread before the flag slot shifts the runtime position, so argument 1 is
  // not provably the flag. `openSync(...args, "0600")` with
  // `args = [path, "w"]` opens with mode `"0600"`, not with an invalid flag.
  if (t.isSpreadElement(node.arguments[0])) return false;
  const flag = node.arguments[1];
  if (flag === undefined || t.isSpreadElement(flag)) return false;
  const value = unwrapJavaScriptExpression(flag).node;
  // A no-expression template literal is exactly readable, so it is the same flag
  // string Node receives.
  const flagText = t.isStringLiteral(value)
    ? value.value
    : t.isTemplateLiteral(value) && value.expressions.length === 0
      ? value.quasis[0]?.value.cooked
      : undefined;
  if (flagText !== undefined && flagText !== null)
    return !FS_OPEN_FLAGS.has(flagText);
  // A non-integer or out-of-int32 value is not a usable bitmask. The sign alone
  // does not decide: Node accepts some signed bitmasks such as `-2147483648` and
  // rejects others such as `-1`, so an in-range negative is left undecided.
  const bits = staticFlagBits(value);
  if (bits !== undefined)
    return (
      bits !== null &&
      (!Number.isInteger(bits) || bits > 2_147_483_647 || bits < -2_147_483_648)
    );
  // `NaN` and `Infinity` are unshadowed globals, and neither is a bitmask.
  if (
    t.isIdentifier(value) &&
    (value.name === "NaN" || value.name === "Infinity") &&
    isUnmodifiedGlobalReference(value, context.state, value.name)
  )
    return true;
  // BigInt, boolean, object and array literals all fail Node's flag check.
  return (
    t.isBigIntLiteral(value) ||
    t.isBooleanLiteral(value) ||
    t.isObjectExpression(value) ||
    t.isArrayExpression(value)
  );
};

/**
 * The number a literal flag argument evaluates to, or `null` when it evaluates to
 * `undefined`. Returns `undefined` when the value is not exactly readable.
 *
 * `void <expr>` is `undefined`, which Node accepts as the default read flag, so
 * it must never be judged by its operand. `!`, `typeof` and `delete` yield a
 * boolean or a string rather than a bitmask.
 */
const staticFlagBits = (value: t.Node): number | null | undefined => {
  if (t.isNumericLiteral(value)) return value.value;
  if (!t.isUnaryExpression(value)) return undefined;
  if (value.operator === "void") return null;
  if (
    value.operator === "!" ||
    value.operator === "typeof" ||
    value.operator === "delete"
  )
    return Number.NaN;
  const operand = unwrapJavaScriptExpression(value.argument).node;
  if (!t.isNumericLiteral(operand)) return undefined;
  if (value.operator === "-") return -operand.value;
  if (value.operator === "+") return operand.value;
  if (value.operator === "~") return ~operand.value;
  return undefined;
};

/** `fs.open`, `fs.openSync` and `fs/promises.open` take the flag in slot 1. */
const openFlagInFirstArgument = (reference: AcquisitionReference): boolean =>
  reference.method === "open" || reference.method === "openSync"
    ? reference.specifier === "fs" || reference.specifier === "fs/promises"
    : false;

const collectAcquisitions = (
  program: t.Program,
  context: DataEffectTraversalContext,
): ResourceCandidate[] => {
  const output: ResourceCandidate[] = [];
  traverseDataEffects(program, context, (node) => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
    const reference = acquisitionMethod(node.callee, context.state);
    if (reference === null) return;
    if (
      openFlagInFirstArgument(reference) &&
      rejectsOpenFlagLiteral(node, context)
    )
      return;
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

/**
 * `net` and `tls` validate a numeric port before creating a socket, so a
 * literal port outside `[0, 65535]`, a fractional, non-finite, BigInt, boolean
 * or `null` first argument throws synchronously and no socket exists. A string
 * is a Unix socket path and an object may carry a path, so only an exactly
 * readable non-port literal is decided. `""` is a path with no length, which
 * Node also rejects.
 *
 * `undefined` and an empty object throw `ERR_MISSING_ARGS`, but those are a
 * missing option rather than a bad port, so they stay undecided here.
 */
const rejectsSocketPortLiteral = (
  node: t.CallExpression | t.OptionalCallExpression,
  context: DataEffectTraversalContext,
): boolean => {
  const port = node.arguments[0];
  if (port === undefined || t.isSpreadElement(port)) return false;
  const value = unwrapJavaScriptExpression(port).node;
  if (t.isStringLiteral(value)) return value.value.length === 0;
  if (
    t.isNullLiteral(value) ||
    t.isBigIntLiteral(value) ||
    t.isBooleanLiteral(value)
  )
    return true;
  if (t.isNumericLiteral(value))
    return (
      !Number.isInteger(value.value) || value.value < 0 || value.value > 65535
    );
  // `NaN` and `Infinity` are unshadowed globals, and neither is a port.
  if (
    t.isIdentifier(value) &&
    (value.name === "NaN" || value.name === "Infinity") &&
    isUnmodifiedGlobalReference(value, context.state, value.name)
  )
    return true;
  // `-1` and `-1.5` are unary expressions over numeric literals: always out of
  // range because a port is never negative.
  if (t.isUnaryExpression(value)) {
    const operand = unwrapJavaScriptExpression(value.argument).node;
    return (
      t.isNumericLiteral(operand) &&
      (value.operator === "-" || !Number.isInteger(operand.value))
    );
  }
  return false;
};

/** Only `net`/`tls` sockets take a port in argument 0. */
const socketPortInFirstArgument = (
  candidate: Pick<AcquisitionReference, "specifier">,
): boolean => candidate.specifier === "net" || candidate.specifier === "tls";

/**
 * The options object whose own `port` Node validates, or undefined.
 *
 * Only a first argument that is an object literal reaches this path. A positional
 * port or Unix socket path in slot 0 takes precedence, so
 * `net.connect(80, { port: -1 })` still connects and its options `port` is never
 * validated.
 */
const socketOptionsObject = (
  node: t.CallExpression | t.OptionalCallExpression,
): t.ObjectExpression | undefined => {
  const first = node.arguments[0];
  if (first === undefined || t.isSpreadElement(first)) return undefined;
  const value = unwrapJavaScriptExpression(first).node;
  return t.isObjectExpression(value) ? value : undefined;
};

/**
 * Whether an options-object `port` provably throws before a socket exists.
 *
 * `net.connect`/`net.createConnection`/`tls.connect` accept the port inside an
 * options object too, and validate it the same way. Two members change which value
 * is validated:
 *
 * - a `path` becomes the Unix socket and the port is not read, so a non-empty path
 *   rescues the call (`{port: -1, path: "/tmp/x"}` connects);
 * - for `tls`, an existing `socket` is wrapped instead of connecting, so `socket`
 *   rescues the port check.
 *
 * A `socket` member on `net` is not honoured, so it does not rescue there.
 *
 * `undefined` and `{}` throw `ERR_MISSING_ARGS`, which is a missing option rather
 * than a bad port, so those stay undecided.
 */
const rejectsOptionsPortLiteral = (
  options: t.ObjectExpression,
  specifier: string,
  context: DataEffectTraversalContext,
): boolean => {
  const read = staticObjectProperty(options, "port");
  if (read.status !== "explicit") return false;
  // A non-empty `path` selects a Unix socket; Node never validates the port.
  const path = staticObjectProperty(options, "path");
  if (path.status === "dynamic") return false;
  if (path.status === "explicit") {
    if (!t.isStringLiteral(path.value)) return false;
    if (path.value.value.length > 0) return false;
  }
  // `tls.connect` wraps a supplied socket instead of connecting.
  if (specifier === "tls") {
    const socket = staticObjectProperty(options, "socket");
    if (socket.status !== "missing") return false;
  }
  const value = unwrapJavaScriptExpression(read.value as t.Node).node;
  // `null` and booleans are not ports: both throw `ERR_INVALID_ARG_TYPE`.
  if (t.isNullLiteral(value) || t.isBooleanLiteral(value)) return true;
  if (t.isBigIntLiteral(value)) return true;
  // `NaN` and `Infinity` are unshadowed globals, and neither is a port.
  if (
    t.isIdentifier(value) &&
    (value.name === "NaN" || value.name === "Infinity") &&
    isUnmodifiedGlobalReference(value, context.state, value.name)
  )
    return true;
  // A unary operator over one is the same non-finite number.
  if (t.isUnaryExpression(value)) {
    const operand = unwrapJavaScriptExpression(value.argument).node;
    if (
      t.isIdentifier(operand) &&
      (operand.name === "NaN" || operand.name === "Infinity") &&
      isUnmodifiedGlobalReference(operand, context.state, operand.name)
    )
      return true;
  }
  const literal = readExactJavaScriptLiteral(value);
  if (!literal.found) return false;
  const port = literal.value;
  if (typeof port === "number")
    return !Number.isInteger(port) || port < 0 || port > 65535;
  if (typeof port !== "string") return false;
  // A string port is coerced, so `""` and whitespace throw while `" 80 "`,
  // `"0x50"`, `"1e2"` and `"080"` all read as 80.
  if (port.trim().length === 0) return true;
  const number = Number(port);
  return !Number.isInteger(number) || number < 0 || number > 65535;
};
