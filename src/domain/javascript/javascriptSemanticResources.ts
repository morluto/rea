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
    (candidate) =>
      !socketPortInFirstArgument(candidate) ||
      (!tlsOptionsRejectCall(candidate, context) &&
        (tlsOptionsReplaceFirstArgument(candidate, context) ||
          !rejectsSocketPortLiteral(candidate, context))),
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
  const bits = staticFlagBits(value, context);
  if (bits !== undefined)
    return (
      bits !== null &&
      (!Number.isInteger(bits) || bits > 2_147_483_647 || bits < -2_147_483_648)
    );
  // `NaN` and `Infinity` are unshadowed globals, and neither is a bitmask; a unary
  // operator over one is the same non-finite number.
  if (isNonFiniteNumber(value, context)) return true;
  // BigInt, boolean, object and array literals all fail Node's flag check. A
  // unary operator over a BigInt literal is a BigInt too.
  return (
    t.isBigIntLiteral(value) ||
    t.isBooleanLiteral(value) ||
    t.isRegExpLiteral(value) ||
    t.isObjectExpression(value) ||
    t.isArrayExpression(value) ||
    (t.isUnaryExpression(value) &&
      t.isBigIntLiteral(unwrapJavaScriptExpression(value.argument).node))
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
const staticFlagBits = (
  value: t.Node,
  context: DataEffectTraversalContext,
  depth = 0,
): number | null | undefined => {
  if (t.isNumericLiteral(value)) return value.value;
  if (!t.isUnaryExpression(value)) return undefined;
  if (value.operator === "void") return null;
  // `!` yields a boolean and `typeof` a string. Neither is a bitmask, so a caller
  // that reads the flag or mode rejects it. This arm is only reachable from the
  // top-level entry: `unaryOperandNumber` never returns one of these as a number.
  if (
    value.operator === "!" ||
    value.operator === "typeof" ||
    value.operator === "delete"
  )
    return Number.NaN;
  // A unary chain resolves through its innermost readable operand, so `~-1` is `0`
  // and `-(-1.5)` is `1.5`. The depth bound keeps a pathological chain from
  // recursing without limit.
  if (depth > 8) return undefined;
  const operand = unwrapJavaScriptExpression(value.argument).node;
  const number = unaryOperandNumber(operand, context, depth + 1);
  if (number === undefined) return undefined;
  if (value.operator === "-") return -number;
  if (value.operator === "+") return number;
  if (value.operator === "~") return ~number;
  return undefined;
};

/**
 * The number an operand of a unary operator evaluates to, or `undefined` when it is
 * not exactly readable.
 *
 * This is separate from `staticFlagBits` because that function answers two different
 * questions: a numeric bitmask, and "this is a boolean or a string rather than a
 * bitmask". The second answer has no number, and a real `NaN` is a number, so they
 * cannot share a return slot. A nested `!`, `typeof` or `delete` therefore stays
 * undecided here: `+!0` is `1` at runtime, but deciding it needs the operand's
 * truthiness rather than a bitmask reading.
 */
const unaryOperandNumber = (
  value: t.Node,
  context: DataEffectTraversalContext,
  depth: number,
): number | undefined => {
  if (depth > 8) return undefined;
  if (t.isNumericLiteral(value)) return value.value;
  if (t.isUnaryExpression(value)) {
    if (
      value.operator === "!" ||
      value.operator === "typeof" ||
      value.operator === "delete" ||
      value.operator === "void"
    )
      return undefined;
    const inner = unaryOperandNumber(
      unwrapJavaScriptExpression(value.argument).node,
      context,
      depth + 1,
    );
    if (inner === undefined) return undefined;
    if (value.operator === "-") return -inner;
    if (value.operator === "+") return inner;
    if (value.operator === "~") return ~inner;
    return undefined;
  }
  return primitiveToNumber(value) ?? nonFiniteGlobalNumber(value, context);
};

/**
 * The number an unshadowed `NaN` or `Infinity` evaluates to, or `undefined` when the
 * operand names neither. A `~` over one is a finite int32, which is why the bitwise
 * result must be computed rather than treated as non-finite.
 */
const nonFiniteGlobalNumber = (
  value: t.Node,
  context: DataEffectTraversalContext,
): number | undefined => {
  if (
    !t.isIdentifier(value) ||
    (value.name !== "NaN" && value.name !== "Infinity") ||
    !isUnmodifiedGlobalReference(value, context.state, value.name)
  )
    return undefined;
  return value.name === "NaN" ? Number.NaN : Number.POSITIVE_INFINITY;
};

/**
 * The number JavaScript's unary coercion produces for an exactly readable
 * non-numeric primitive, or `undefined` when the operand is not one. `-true` is
 * `-1` and `+"bad"` is `NaN`, so neither is a socket port or an fs flag.
 */
const primitiveToNumber = (value: t.Node): number | undefined => {
  if (t.isStringLiteral(value)) return Number(value.value);
  if (t.isBooleanLiteral(value)) return Number(value.value);
  if (t.isNullLiteral(value)) return 0;
  if (t.isTemplateLiteral(value) && value.expressions.length === 0) {
    const cooked = value.quasis[0]?.value.cooked;
    return cooked === undefined || cooked === null ? undefined : Number(cooked);
  }
  return undefined;
};

/**
 * Whether an exactly readable expression is a non-finite number: an unshadowed
 * `NaN` or `Infinity`, or a unary operator applied to one. `void` is excluded
 * because it yields `undefined`, which both slots accept as the default.
 */
const isNonFiniteNumber = (
  value: t.Node,
  context: DataEffectTraversalContext,
): boolean => {
  const unshadowed = (node: t.Node): boolean =>
    t.isIdentifier(node) &&
    (node.name === "NaN" || node.name === "Infinity") &&
    isUnmodifiedGlobalReference(node, context.state, node.name);
  if (unshadowed(value)) return true;
  return (
    t.isUnaryExpression(value) &&
    value.operator !== "void" &&
    unshadowed(unwrapJavaScriptExpression(value.argument).node)
  );
};

/** `fs.open`, `fs.openSync` and `fs/promises.open` take the mode in slot 2. */
const rejectsOpenModeLiteral = (
  node: t.CallExpression | t.OptionalCallExpression,
  context: DataEffectTraversalContext,
): boolean => {
  // A spread before the mode slot shifts the runtime position.
  if (
    t.isSpreadElement(node.arguments[0]) ||
    t.isSpreadElement(node.arguments[1])
  )
    return false;
  const mode = node.arguments[2];
  if (mode === undefined || t.isSpreadElement(mode)) return false;
  const value = unwrapJavaScriptExpression(mode).node;
  // `null`, `undefined` and `void <expr>` all default the mode.
  if (t.isNullLiteral(value)) return false;
  // A no-expression template literal is exactly readable, so it is the same
  // string Node would receive.
  const octal = t.isStringLiteral(value)
    ? value.value
    : t.isTemplateLiteral(value) && value.expressions.length === 0
      ? value.quasis[0]?.value.cooked
      : undefined;
  if (octal !== undefined && octal !== null) {
    if (!/^[0-7]+$/u.test(octal)) return true;
    // Leading zeros pad the text without changing the value, so the bound reads the
    // significant digits. Eleven octal digits cover the whole uint32 range, so a
    // longer significant run cannot fit and an eleven-digit one is exact.
    const digits = octal.replace(/^0+/u, "");
    return digits.length > 11 || Number.parseInt(digits, 8) > 4_294_967_295;
  }
  // A numeric mode is validated as an unsigned 32-bit integer.
  const bits = staticFlagBits(value, context);
  if (bits !== undefined) {
    if (bits === null) return false;
    // Values in `[2^31, 2^32-1]` abort the process rather than throwing, so
    // they stay undecided instead of being claimed as a synchronous throw.
    return !Number.isInteger(bits) || bits < 0 || bits > 4_294_967_295;
  }
  // `NaN` and `Infinity` are unshadowed globals, and neither is a mode; a unary
  // operator over one is the same non-finite number.
  if (isNonFiniteNumber(value, context)) return true;
  // BigInt, boolean, object and array literals all fail Node's mode check. A
  // unary operator over a BigInt literal is a BigInt too, and the range helpers
  // above only price numeric operands.
  return (
    t.isBigIntLiteral(value) ||
    t.isBooleanLiteral(value) ||
    t.isRegExpLiteral(value) ||
    t.isObjectExpression(value) ||
    t.isArrayExpression(value) ||
    (t.isUnaryExpression(value) &&
      t.isBigIntLiteral(unwrapJavaScriptExpression(value.argument).node))
  );
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
    if (openFlagInFirstArgument(reference)) {
      if (rejectsOpenFlagLiteral(node, context)) return;
      if (rejectsOpenModeLiteral(node, context)) return;
    }
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
 * The number JavaScript's unary coercion produces for an exactly readable
 * non-numeric primitive, or `undefined` when the operand is not one.
 */
const primitiveToNumber = (value: t.Node): number | undefined => {
  if (t.isStringLiteral(value)) return Number(value.value);
  if (t.isBooleanLiteral(value)) return Number(value.value);
  if (t.isNullLiteral(value)) return 0;
  if (t.isTemplateLiteral(value) && value.expressions.length === 0) {
    const cooked = value.quasis[0]?.value.cooked;
    return cooked === undefined || cooked === null ? undefined : Number(cooked);
  }
  return undefined;
};

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
      : // Node trims a port string before coercing it, so a whitespace-only
        // port is `ERR_SOCKET_BAD_PORT` while `" 80 "` is a valid port.
        value.value.trim().length === 0 || !usablePort(Number(value.value));
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
    // `typeof` yields a non-empty type name. In a positional slot Node reads it as a
    // Unix socket path, but an options `port` is coerced and validated, so
    // `net.connect({ port: typeof 1 })` throws `ERR_SOCKET_BAD_PORT`.
    if (value.operator === "typeof") return !stringIsPath;
    // `void` yields `undefined` and `!` yields a boolean; both throw before a
    // socket exists.
    if (value.operator === "void" || value.operator === "!") return true;
    const operand = unwrapJavaScriptExpression(value.argument).node;
    // JavaScript coerces a unary operand over an exact non-numeric primitive, so
    // `-true` is `-1` and `+"bad"` is `NaN`; neither is a usable port.
    if (!t.isNumericLiteral(operand)) {
      const coerced = primitiveToNumber(operand);
      if (coerced === undefined) return false;
      const result =
        value.operator === "-"
          ? -coerced
          : value.operator === "+"
            ? coerced
            : value.operator === "~"
              ? ~coerced
              : undefined;
      return result === undefined ? false : !usablePort(result);
    }
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
/** A literal whose value Node treats as absent in an options slot. */
const isFalsyLiteral = (value: t.Node): boolean =>
  t.isNullLiteral(value) ||
  (t.isBooleanLiteral(value) && !value.value) ||
  (t.isNumericLiteral(value) && value.value === 0) ||
  (t.isStringLiteral(value) && value.value === "");

/**
 * The prototype an object literal installs, when that is knowable.
 *
 * `null` means no `__proto__` member, so nothing is inherited. An object expression is
 * the knowable prototype, and `undefined` means the value is `null` (no inherited
 * member either). `false` means the value is not readable.
 */
const objectPrototype = (
  object: t.ObjectExpression,
): t.ObjectExpression | null | undefined | false => {
  let prototype: t.ObjectExpression | null | undefined | false = null;
  for (const property of object.properties) {
    if (
      !t.isObjectProperty(property) ||
      property.computed ||
      semanticStaticPropertyName(property.key, false) !== "__proto__"
    )
      continue;
    const value = unwrapJavaScriptExpression(property.value).node;
    prototype = t.isNullLiteral(value)
      ? undefined
      : t.isObjectExpression(value)
        ? value
        : false;
  }
  return prototype;
};

const lastMemberValue = (
  object: t.ObjectExpression,
  name: string,
  // `net.connect` reads an object argument through the prototype chain; `tls.connect`
  // copies only own fields, so an inherited one is absent for it.
  inherit = true,
): t.Node | null | undefined => {
  // A `__proto__` member installs a prototype, so a member this object does not spell
  // may still exist through inheritance: `{ __proto__: { path: "/tmp/x" }, port: -1 }`
  // connects to that path. Own fields still settle the answer first, so
  // `{ __proto__: null, path: "", port: -1 }` decides through its own empty `path`.
  for (let index = object.properties.length - 1; index >= 0; index -= 1) {
    const property = object.properties[index];
    if (property === undefined) continue;
    if (!t.isObjectProperty(property) || property.computed) return null;
    if (semanticStaticPropertyName(property.key, false) !== name) continue;
    return unwrapJavaScriptExpression(property.value).node;
  }
  if (!inherit) return undefined;
  const prototype = objectPrototype(object);
  if (prototype === false) return null;
  if (prototype === null || prototype === undefined) return undefined;
  return lastMemberValue(prototype, name);
};

/**
 * What a readable `path` member makes Node do before it validates `port`.
 *
 * - `socket`: a non-empty string selects a Unix socket, so `port` is ignored.
 * - `port`: a readable falsy value (`""`, `null`, `false`, `0`) does not select
 *   a socket, so `port` is still validated.
 * - `invalid`: any other readable value throws `ERR_INVALID_ARG_TYPE` before a
 *   socket exists, because Node only accepts a string path.
 * - `unknown`: the member is not exactly readable, so nothing is decided.
 */
type SocketOptionsIntent = "socket" | "port" | "invalid" | "unknown";

const socketOptionsIntent = (
  object: t.ObjectExpression,
  inherit = true,
): SocketOptionsIntent => {
  const path = lastMemberValue(object, "path", inherit);
  if (path === null) return "unknown";
  if (path === undefined) return "port";
  if (t.isStringLiteral(path)) return path.value === "" ? "port" : "socket";
  if (t.isNullLiteral(path)) return "port";
  if (t.isBooleanLiteral(path)) return path.value ? "invalid" : "port";
  if (t.isNumericLiteral(path)) return path.value === 0 ? "port" : "invalid";
  if (t.isArrayExpression(path) || t.isObjectExpression(path)) return "invalid";
  return "unknown";
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
  const port = lastMemberValue(object, "port", false);
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
  candidate: Pick<ResourceCandidate, "specifier" | "node">,
  context: DataEffectTraversalContext,
): boolean => {
  const node = candidate.node;
  const port = node.arguments[0];
  if (port === undefined || t.isSpreadElement(port)) return false;
  const value = unwrapJavaScriptExpression(port).node;
  // `net.connect({ port })` validates the member the same way the positional
  // form validates the argument, but a readable `path` decides first: a Unix
  // socket ignores `port`, a falsy path still validates it, and any other
  // readable path throws before a socket exists.
  if (t.isObjectExpression(value)) {
    // `tls.connect` wraps an existing socket and never connects, so it also
    // never validates `port`; `net.connect` still rejects the same object.
    if (candidate.specifier === "tls") {
      const socket = lastMemberValue(value, "socket", false);
      // Only a readable non-falsy `socket` supplies an existing socket. `socket:
      // null` and `socket: false` leave `port` to be validated, so
      // `tls.connect({ socket: null, port: -1 })` throws `ERR_SOCKET_BAD_PORT`.
      if (socket === null) return false;
      if (socket !== undefined && !isFalsyLiteral(socket)) return false;
    }
    // `tls.connect` copies only own fields from the object it receives, while
    // `net.connect` reads it through the prototype chain.
    const ownFieldsOnly = candidate.specifier === "tls";
    const intent = socketOptionsIntent(value, !ownFieldsOnly);
    if (intent === "socket" || intent === "unknown") return false;
    if (intent === "invalid") return true;
    const member = lastMemberValue(value, "port", !ownFieldsOnly);
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
 * `tls.connect` validates an options `path` as a string before it merges the
 * object, so a readable non-string `path` throws regardless of the first
 * argument or any `port`. `net.connect` accepts the same object, so this
 * rejection applies to `tls` only.
 */
/** A first argument that selects a Unix socket, which makes Node ignore `port`. */
const isUnixSocketPathArgument = (argument: t.Node | undefined): boolean => {
  if (argument === undefined || t.isSpreadElement(argument)) return false;
  const value = unwrapJavaScriptExpression(argument).node;
  return t.isStringLiteral(value) && value.value !== "";
};

const tlsOptionsRejectCall = (
  candidate: ResourceCandidate,
  context: DataEffectTraversalContext,
): boolean => {
  if (candidate.specifier !== "tls") return false;
  const options = candidate.node.arguments[1];
  if (options === undefined || !t.isObjectExpression(options)) return false;
  const intent = socketOptionsIntent(options, false);
  if (intent === "invalid" || intent === "socket") return intent === "invalid";
  // A non-empty string first argument is a Unix socket path, and Node keeps it while
  // ignoring `port`, so the merged options cannot reject the call.
  if (isUnixSocketPathArgument(candidate.node.arguments[0])) return false;
  // The options object is merged over the first argument, so its own `port` is
  // validated too: `tls.connect(443, { port: -1 })` throws even though 443 is valid.
  const port = lastMemberValue(options, "port", false);
  return (
    port !== undefined &&
    port !== null &&
    rejectsPortValue(port, context, false)
  );
};

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
  const intent = socketOptionsIntent(options, false);
  // A socket path or an unreadable member set may replace the argument; a
  // readable non-socket path throws on its own, so the first argument still
  // decides.
  if (intent === "socket" || intent === "unknown") return true;
  const port = optionsSupplyPort(options, context);
  return port !== false;
};
