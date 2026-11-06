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
  isNullishJavaScriptSyntax,
  readExactJavaScriptLiteral,
  semanticStaticPropertyName,
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
      // socket exists. `tls` merges a later options object over the first, so the
      // effective port is read across every options argument.
      const objects = socketOptionsObjects(candidate.node, candidate.specifier);
      if (objects === undefined) return true;
      return !rejectsOptionsPortLiteral(objects, candidate.specifier, context);
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
  if (t.isNumericLiteral(value)) return !isUsablePortNumber(value.value);
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
 * Whether a later argument may evaluate to an options object.
 *
 * Measured on Node 24.22.1: `tls.connect({port:-1}, null)`, `(…, undefined)`,
 * `(…, 0)`, `(…, "x")` and `(…, [80])` all still throw, so only an object
 * argument overrides the port. Those primitive shapes are decided exactly; an
 * expression that could hold an object stays undecided.
 */
const laterArgumentMayBeOptionsObject = (argument: t.Node): boolean => {
  if (t.isSpreadElement(argument)) return true;
  const value = unwrapJavaScriptExpression(argument).node;
  if (t.isObjectExpression(value)) return true;
  if (isExactlyNonObjectExpression(value)) return false;
  return true;
};

/** Expressions whose runtime value can never supply an options `port`. */
const isExactlyNonObjectExpression = (value: t.Node): boolean => {
  if (
    t.isFunctionExpression(value) ||
    t.isArrowFunctionExpression(value) ||
    t.isStringLiteral(value) ||
    t.isNumericLiteral(value) ||
    t.isBooleanLiteral(value) ||
    t.isBigIntLiteral(value) ||
    t.isRegExpLiteral(value) ||
    isNullishJavaScriptSyntax(value)
  )
    return true;
  // An array literal owns only index keys, so merging it never replaces `port`,
  // `path` or `socket`: `tls.connect({port:-1}, [80])` still throws on Node 24.22.1.
  if (t.isArrayExpression(value)) return true;
  // The unbound `undefined` global is `undefined`; a shadowed or reassigned name is
  // not decided here.
  if (t.isIdentifier(value) && value.name === "undefined") return true;
  return (
    t.isUnaryExpression(value) &&
    (value.operator === "-" || value.operator === "+" || value.operator === "!")
  );
};

/**
 * The options objects whose own `port` Node validates, in argument order.
 *
 * Only a first argument that is an object literal reaches this path. A positional
 * port or Unix socket path in slot 0 takes precedence, so
 * `net.connect(80, { port: -1 })` still connects and its options `port` is never
 * validated.
 *
 * `net` reads argument 0 alone: `net.connect({ port: -1 }, { port: 80 })` still
 * throws. `tls` merges exactly one later argument, and which one is decided by
 * position rather than by content. Measured on Node 24.22.1:
 *
 *   tls.connect({port:80},{port:80},{port:-1})  -> socket (argument 1 wins)
 *   tls.connect({port:80},{port:-1},{port:80})  -> THREW  (argument 1 wins)
 *   tls.connect({port:80}, null, {port:-1})     -> THREW  (argument 2 used)
 *   tls.connect({port:80}, undefined, {port:-1})-> THREW  (argument 2 used)
 *   tls.connect({port:80}, 0, {port:-1})        -> THREW  (argument 2 used)
 *
 * So a non-null object in slot 1 is the only override, and anything else in slot 1
 * makes slot 2 the override. Later arguments are never merged.
 *
 * Returns undefined when the deciding argument could hold an object that is not an
 * exactly readable literal, because the effective port is then undecided.
 */
const socketOptionsObjects = (
  node: t.CallExpression | t.OptionalCallExpression,
  specifier: string,
): readonly t.ObjectExpression[] | undefined => {
  const first = node.arguments[0];
  if (first === undefined || t.isSpreadElement(first)) return undefined;
  const value = unwrapJavaScriptExpression(first).node;
  if (!t.isObjectExpression(value)) return undefined;
  if (specifier !== "tls") return [value];
  // `tls` merges one later argument. A non-null object in slot 1 is that argument;
  // any other slot-1 value defers the merge to slot 2, and slot 3 onward is ignored.
  const slot = node.arguments[1];
  if (slot === undefined || t.isSpreadElement(slot)) return [value];
  const candidate = unwrapJavaScriptExpression(slot).node;
  if (t.isObjectExpression(candidate)) return [value, candidate];
  if (!isExactlyNonObjectExpression(candidate)) return undefined;
  // Slot 1 cannot be an override, so slot 2 becomes the deciding argument.
  const next = node.arguments[2];
  if (next === undefined) return [value];
  if (t.isSpreadElement(next)) return undefined;
  const second = unwrapJavaScriptExpression(next).node;
  if (t.isObjectExpression(second)) return [value, second];
  return isExactlyNonObjectExpression(second) ? [value] : undefined;
};

/** The effective member across merged options objects; later ones win. */
const mergedOptionsProperty = (
  objects: readonly t.ObjectExpression[],
  name: string,
): ReturnType<typeof staticObjectProperty> => {
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const read = staticObjectProperty(objects[index]!, name);
    if (read.status !== "missing") return read;
  }
  return { status: "missing" };
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
 * An absent port throws `ERR_MISSING_ARGS`, which is a missing option rather than a
 * bad port, so it stays undecided.
 */
const rejectsOptionsPortLiteral = (
  objects: readonly t.ObjectExpression[],
  specifier: string,
  context: DataEffectTraversalContext,
): boolean => {
  const read = mergedOptionsProperty(objects, "port");
  if (read.status !== "explicit") return false;
  // A non-empty `path` selects a Unix socket; Node never validates the port.
  const path = mergedOptionsProperty(objects, "path");
  if (path.status === "dynamic") return false;
  if (path.status === "explicit") {
    if (!t.isStringLiteral(path.value)) return false;
    if (path.value.value.length > 0) return false;
  }
  // `tls.connect` wraps a supplied socket instead of connecting.
  if (specifier === "tls") {
    const socket = mergedOptionsProperty(objects, "socket");
    if (socket.status !== "missing") return false;
  }
  return rejectsOptionsPortValue(
    unwrapJavaScriptExpression(read.value as t.Node).node,
    context,
  );
};

/** Whether a number is a TCP port Node accepts. */
const isUsablePortNumber = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= 65535;

/**
 * Whether a `port` member's exactly readable value is one Node rejects.
 *
 * `null` and booleans are not ports. `NaN`, `Infinity` and a numeric literal that
 * overflows to a non-finite number are all out of range, but `void anything` is
 * `undefined`: Node then treats the port as absent, so it is not a bad port and
 * stays undecided.
 */
const rejectsOptionsPortValue = (
  value: t.Node,
  context: DataEffectTraversalContext,
): boolean => {
  if (t.isNullLiteral(value) || t.isBooleanLiteral(value)) return true;
  if (t.isBigIntLiteral(value)) return true;
  // `null`-like syntax reads as an absent port, which throws `ERR_MISSING_ARGS`.
  if (isNullishJavaScriptSyntax(value)) return false;
  // `NaN` and `Infinity` are unshadowed globals, and neither is a port.
  if (
    t.isIdentifier(value) &&
    (value.name === "NaN" || value.name === "Infinity") &&
    isUnmodifiedGlobalReference(value, context.state, value.name)
  )
    return true;
  if (t.isNumericLiteral(value)) return !isUsablePortNumber(value.value);
  // A sign over one is the same non-finite number, but `void` is `undefined`: it
  // is not a sign, so only `+` and `-` are decided here.
  if (
    t.isUnaryExpression(value) &&
    (value.operator === "+" || value.operator === "-")
  ) {
    const operand = unwrapJavaScriptExpression(value.argument).node;
    if (
      t.isIdentifier(operand) &&
      (operand.name === "NaN" || operand.name === "Infinity")
    )
      return isUnmodifiedGlobalReference(operand, context.state, operand.name);
    if (!t.isNumericLiteral(operand)) return false;
    // Compute the signed value and apply the whole check. The sign alone does not
    // decide: `-0` is port zero, which connects, while `+65536` is out of range and
    // throws. Both are signed spellings Node judges by value.
    const signed = value.operator === "-" ? -operand.value : operand.value;
    return !isUsablePortNumber(signed);
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
