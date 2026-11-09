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
  isObjectPrototypeSetter,
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
  builtinDataEffectIdentity,
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
  readonly builtinAuthority?: "candidate";
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
      !rejectsSocketPort(candidate.node, candidate.specifier, context),
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
      ...(reference.builtinAuthority === undefined
        ? {}
        : { builtinAuthority: reference.builtinAuthority }),
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
      ...(linked.some((value) => value.builtinAuthority === "candidate")
        ? { builtinAuthority: "candidate" as const }
        : {}),
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
  ...(candidate.builtinAuthority === undefined
    ? {}
    : { builtinAuthority: candidate.builtinAuthority }),
  location: range(candidate.node),
  ownerCallableId: candidate.ownerCallableId,
  resultBindingId: candidate.resultBindingId,
  linkedResourceIds: [],
  resolution: "complete",
});

interface AcquisitionReference {
  readonly builtinAuthority?: "candidate";
  readonly specifier: string;
  readonly method: JavaScriptSemanticResourceOperation["method"];
}

const acquisitionMethod = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
): AcquisitionReference | null => {
  for (const specifier of BUILTIN_RESOURCE_SPECIFIERS) {
    const identity = builtinDataEffectIdentity(callee, state, [specifier]);
    const method =
      identity?.path.length === 1 ? (identity.path[0] ?? null) : null;
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
        ...(identity?.builtinAuthority === undefined
          ? {}
          : { builtinAuthority: identity.builtinAuthority }),
        method: method as JavaScriptSemanticResourceOperation["method"],
      };
  }
  return null;
};
const resourceCandidateId = (candidate: ResourceCandidate): string =>
  `resource:acquire:${String(candidate.node.start ?? -1)}:${String(candidate.node.end ?? -1)}`;

/**
 * Whether a `port` value Node provably rejects before a socket exists.
 *
 * `net` and `tls` validate the port before touching the network, so a value Node
 * refuses throws synchronously and no handle exists. Only an exactly readable
 * literal is decided; a computed value may still be valid.
 *
 * `void anything` is `undefined`, which Node reads as an absent option rather than
 * a bad port, so it stays undecided here.
 */
/**
 * Whether a `port` member's exactly readable value is one Node rejects.
 *
 * `null` and booleans are not ports. `NaN`, `Infinity` and a numeric literal that
 * overflows to a non-finite number are all out of range, but `void anything` is
 * `undefined`: Node then treats the port as absent, so it is not a bad port and
 * stays undecided.
 *
 * This is the single reader for both the positional argument and the options
 * member. `net`/`tls` judge the same effective port either way, so a rule learned
 * here applies to both spellings; two readers could drift apart.
 */
const rejectsPortValue = (
  value: t.Node,
  context: DataEffectTraversalContext,
): boolean => {
  if (t.isNullLiteral(value) || t.isBooleanLiteral(value)) return true;
  if (t.isBigIntLiteral(value)) return true;
  if (isNullishJavaScriptSyntax(value)) return false;
  // `NaN` and `Infinity` are unshadowed globals, and neither is a port.
  if (
    t.isIdentifier(value) &&
    (value.name === "NaN" || value.name === "Infinity") &&
    isUnmodifiedGlobalReference(value, context.state, value.name)
  )
    return true;
  if (t.isNumericLiteral(value)) return !isUsablePortNumber(value.value);
  if (t.isStringLiteral(value))
    return value.value.length === 0 || !isUsablePortString(value.value);
  if (t.isTemplateLiteral(value) && value.expressions.length === 0) {
    const cooked = value.quasis[0]?.value.cooked;
    return cooked === null || cooked === undefined
      ? false
      : cooked.length === 0 || !isUsablePortString(cooked);
  }
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
    // decide: `-0` is port zero, which connects, while `+65536` is out of range
    // and throws. Both are signed spellings Node judges by value.
    const signed = value.operator === "-" ? -operand.value : operand.value;
    return !isUsablePortNumber(signed);
  }
  return false;
};

/** Whether a string port reads as one Node accepts; Node coerces with `Number`. */
const isUsablePortString = (text: string): boolean => {
  if (text.trim().length === 0) return false;
  const number = Number(text);
  return isUsablePortNumber(number);
};

/**
 * Whether a `net`/`tls` acquisition provably throws before a socket exists.
 *
 * The port can arrive positionally or inside an options object, and which one Node
 * validates depends on the receiver and on the argument shapes. Measured on
 * Node 24.22.1:
 *
 * - `net` reads the first argument only. A numeric port is validated there and a
 *   later options object never overrides it.
 * - `tls` accepts a port positionally *or* in an options object, and validates
 *   whichever is effective after its option merge.
 *
 * A `path` in the options object selects a Unix socket, so the port is not read.
 * For `tls`, a supplied `socket` is wrapped instead of connecting.
 */
const rejectsSocketPort = (
  node: t.CallExpression | t.OptionalCallExpression,
  specifier: string,
  context: DataEffectTraversalContext,
): boolean => {
  const first = node.arguments[0];
  if (first === undefined || t.isSpreadElement(first)) return false;
  const head = unwrapJavaScriptExpression(first).node;
  if (t.isObjectExpression(head)) {
    // `tls` merges exactly one later argument, chosen by position, and later
    // arguments are never merged. `net` ignores later options entirely.
    const objects = socketOptionsObjects(node, specifier, context.state);
    if (objects === undefined) return false;
    return rejectsOptionsPortLiteral(objects, specifier, context);
  }
  // A positional port, Unix socket path or empty path. `net` validates argument 0 and
  // ignores later options; `tls` still merges its options object, which can replace the
  // value. Measured on Node 24.22.1, `tls.connect("", {port: 80})` and
  // `tls.connect("", {path: "/tmp/x"})` both connect while `tls.connect("", {})` throws,
  // and `net.connect("", {port: 80})` throws because `net` reads no later options.
  if (!socketPortPositional(head) && !socketEmptyPath(head)) return false;
  const objects = socketOptionsObjects(node, specifier, context.state);
  if (objects === undefined) return false;
  if (specifier === "net") return rejectsPortValue(head, context);
  // `tls` merges the options over the positional port, so a member that rescues the
  // port check applies here too: `tls.connect(-1, {path:"/tmp/x"})` connects. An
  // unreadable path or socket leaves the answer unknown, so keep the acquisition.
  const rescue = optionsRescuePort(objects, specifier, context.state);
  if (rescue === "rejects") return true;
  if (rescue !== "validates") return false;
  // The merged options win when they carry an effective `port`; otherwise the
  // positional value is the one validated. `tls.connect(-1, {})` still throws.
  const merged = mergedOptionsProperty(objects, "port");
  if (merged.status === "explicit")
    return rejectsPortValue(
      unwrapJavaScriptExpression(merged.value as t.Node).node,
      context,
    );
  if (merged.status === "dynamic") return false;
  return rejectsPortValue(head, context);
};

/** Whether a first argument is an empty Unix socket path, which Node rejects. */
const socketEmptyPath = (value: t.Node): boolean => {
  if (t.isStringLiteral(value)) return value.value.length === 0;
  if (t.isTemplateLiteral(value) && value.expressions.length === 0) {
    const cooked = value.quasis[0]?.value.cooked;
    return cooked !== null && cooked !== undefined && cooked.length === 0;
  }
  return false;
};

/** Whether a first argument is a positional port rather than a path. */
const socketPortPositional = (value: t.Node): boolean => {
  if (t.isNumericLiteral(value)) return true;
  if (
    t.isUnaryExpression(value) &&
    (value.operator === "+" || value.operator === "-")
  )
    return true;
  if (
    t.isIdentifier(value) &&
    (value.name === "NaN" || value.name === "Infinity")
  )
    return true;
  if (
    t.isNullLiteral(value) ||
    t.isBooleanLiteral(value) ||
    t.isBigIntLiteral(value)
  )
    return true;
  // A string is a Unix socket path, and Node does not validate it as a port.
  return false;
};
const socketPortInFirstArgument = (
  candidate: Pick<AcquisitionReference, "specifier">,
): boolean => candidate.specifier === "net" || candidate.specifier === "tls";

/**
 * Whether a member value is absent, which Node reads as "this option was not passed".
 *
 * `null` and `void …` are absent by syntax. The bare `undefined` name is absent only
 * while nothing has rebound it: under `const undefined = false` the member carries
 * `false`, so the option is present.
 */
const isAbsentOptionValue = (
  value: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  isNullishJavaScriptSyntax(value) ||
  (t.isIdentifier(value) &&
    value.name === "undefined" &&
    isUnmodifiedGlobalReference(value, state, "undefined"));

/**
 * Whether a value is an exactly readable literal, and therefore cannot carry a
 * `net.Socket`'s stream methods at runtime.
 *
 * A literal `socket` member is what makes `tls.connect` fail its own stream check
 * rather than connect, so it is decided rather than left unknown — with one exception
 * for object literals, handled by `objectLiteralMayInheritStream`.
 */
const isExactlyReadableLiteral = (
  value: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (t.isObjectExpression(value))
    return !objectLiteralMayInheritStream(value, state, 0);
  return (
    isExactlyNonObjectExpression(value, state) || t.isTemplateLiteral(value)
  );
};

/**
 * Whether an object literal may inherit stream methods through a `__proto__` setter.
 *
 * Measured on Node 24.22.1: `tls.connect({port:-1, socket:{__proto__: stream}})` returns
 * a `TLSSocket` when `stream` is a `PassThrough`, because `tls` wraps any object that
 * carries the stream methods and never reads the port. `{}`, `{__proto__: null}`,
 * `{__proto__: {}}`, `{__proto__: 5}` and — because a computed key is an own property
 * rather than a prototype change — `{["__proto__"]: stream}` all throw instead.
 *
 * So only a non-computed `__proto__` whose value is not exactly readable leaves the
 * literal open; every other object literal is decided.
 */
const objectLiteralMayInheritStream = (
  value: t.ObjectExpression,
  state: JavaScriptSemanticAnalysisState,
  depth: number,
): boolean => {
  if (depth > 8) return true;
  return value.properties.some((property) => {
    if (!t.isObjectProperty(property)) return false;
    if (!isObjectPrototypeSetter(property)) return false;
    const prototype = unwrapJavaScriptExpression(property.value).node;
    if (t.isObjectExpression(prototype))
      return objectLiteralMayInheritStream(prototype, state, depth + 1);
    return !isExactlyNonObjectExpression(prototype, state);
  });
};

/** Expressions whose runtime value can never supply an options `port`. */
const isExactlyNonObjectExpression = (
  value: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
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
  // The unbound `undefined` global is `undefined`; a shadowed or reassigned name
  // holds whatever it was bound to, so the value stays undecided.
  if (t.isIdentifier(value) && value.name === "undefined")
    return isUnmodifiedGlobalReference(value, state, "undefined");
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
  state: JavaScriptSemanticAnalysisState,
): readonly t.ObjectExpression[] | undefined => {
  const first = node.arguments[0];
  if (first === undefined || t.isSpreadElement(first)) return undefined;
  const value = unwrapJavaScriptExpression(first).node;
  const base = t.isObjectExpression(value)
    ? [value]
    : socketPortPositional(value) || socketEmptyPath(value)
      ? []
      : undefined;
  if (base === undefined) return undefined;
  if (specifier !== "tls") return base;
  // `tls` merges one later argument over the base, and the merge slot does not
  // depend on what the base is: a non-null object in slot 1 is the override,
  // anything else in slot 1 defers it to slot 2, and slot 3 onward is ignored.
  const merged = tlsMergedOptionsObject(node, state);
  if (merged === undefined) return undefined;
  return merged === null ? base : [...base, merged];
};

/**
 * Whether a value occupies `tls`' single merge slot without supplying option members.
 *
 * An array or a regular expression cannot carry `port`, `path` or `socket`, but it
 * still fills argument 1, and Node then ignores argument 2. Measured on Node
 * 24.22.1: `tls.connect(-1, [], {port:80})` throws — the ignored `port` does not
 * rescue it — while `tls.connect(-1, () => {}, {port:80})` connects, because a
 * callback or a primitive leaves the slot for argument 2.
 */
const occupiesOptionsSlotOnly = (value: t.Node): boolean =>
  t.isArrayExpression(value) || t.isRegExpLiteral(value);

/**
 * The single later options object `tls` merges, `null` for none, or undefined when
 * the slot that decides it could hold an unreadable object.
 *
 * Slot 1 is the override when it is an object literal. When slot 1 is provably not an
 * object (a callback, a primitive, `null`, `undefined`), slot 2 decides instead. An
 * array or a regular expression in slot 1 occupies the slot without supplying
 * members, so slot 2 is still ignored.
 */
const tlsMergedOptionsObject = (
  node: t.CallExpression | t.OptionalCallExpression,
  state: JavaScriptSemanticAnalysisState,
): t.ObjectExpression | null | undefined => {
  const slot = node.arguments[1];
  if (slot === undefined) return null;
  if (t.isSpreadElement(slot)) return undefined;
  const candidate = unwrapJavaScriptExpression(slot).node;
  if (t.isObjectExpression(candidate)) return candidate;
  if (occupiesOptionsSlotOnly(candidate)) return null;
  if (!isExactlyNonObjectExpression(candidate, state)) return undefined;
  const next = node.arguments[2];
  if (next === undefined) return null;
  if (t.isSpreadElement(next)) return undefined;
  const second = unwrapJavaScriptExpression(next).node;
  if (t.isObjectExpression(second)) return second;
  if (occupiesOptionsSlotOnly(second)) return null;
  return isExactlyNonObjectExpression(second, state) ? null : undefined;
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
  // One shared rescue decision, so this branch and the positional branch agree.
  const rescue = optionsRescuePort(objects, specifier, context.state);
  // A truthy literal `socket` makes the wrap throw, so no socket exists whatever the
  // port says.
  if (rescue === "rejects") return true;
  if (rescue !== "validates") return false;
  return rejectsPortValue(
    unwrapJavaScriptExpression(read.value as t.Node).node,
    context,
  );
};

/**
 * A literal whose `ToBoolean` is false, so Node's `socket` read skips the wrap entirely.
 *
 * Measured on Node 24.22.1, `{port: 80, socket: null}`, `{… socket: false}`,
 * `{… socket: 0}` and `{… socket: ""}` all connect, while `{… socket: {}}` and every other
 * truthy literal throw `TypeError` from the stream check.
 */
const isStaticallyFalsyOptionLiteral = (value: t.Node): boolean => {
  if (t.isNullLiteral(value)) return true;
  if (t.isBooleanLiteral(value)) return !value.value;
  if (t.isNumericLiteral(value)) return value.value === 0;
  if (t.isBigIntLiteral(value)) return value.value === 0n;
  if (t.isStringLiteral(value)) return value.value.length === 0;
  if (t.isTemplateLiteral(value) && value.expressions.length === 0) {
    const cooked = value.quasis[0]?.value.cooked;
    return cooked === "" || cooked === null || cooked === undefined;
  }
  if (t.isIdentifier(value)) return value.name === "undefined";
  if (t.isUnaryExpression(value)) {
    if (value.operator === "void") return true;
    if (value.operator === "-") {
      const operand = unwrapJavaScriptExpression(value.argument).node;
      return t.isNumericLiteral(operand) && operand.value === 0;
    }
  }
  return false;
};

/**
 * Whether the merged options make Node skip the port check, or leave it undecided.
 *
 * A non-empty `path` becomes the Unix socket and neutralises the port. For `tls`, a
 * supplied `socket` is wrapped instead of connecting, but only a real stream is.
 *
 * Measured on Node 24.22.1, a truthy literal `socket` member throws `TypeError` from the
 * stream check whether the port is valid or not — `{port: 80, socket: {}}`,
 * `{… socket: "x"}`, `{… socket: 5}`, `{… socket: []}` and `{… socket: () => {}}` all
 * throw — while a falsy one falls through to the port check and connects. So a truthy
 * literal is a rejection in its own right, not a validation of the port.
 *
 * An unreadable `path` may be a non-empty path and an unreadable `socket` may be a real
 * one, so neither proves the port is validated: the caller must keep the acquisition
 * rather than decide against it.
 */
const optionsRescuePort = (
  objects: readonly t.ObjectExpression[],
  specifier: string,
  state: JavaScriptSemanticAnalysisState,
): "rescues" | "validates" | "rejects" | "unknown" => {
  const path = mergedOptionsProperty(objects, "path");
  if (path.status === "dynamic") return "unknown";
  if (path.status === "explicit") {
    if (!t.isStringLiteral(path.value)) return "unknown";
    if (path.value.value.length > 0) return "rescues";
  }
  if (specifier === "tls") {
    const socket = mergedOptionsProperty(objects, "socket");
    if (socket.status === "dynamic") return "unknown";
    if (socket.status === "explicit") {
      const value = unwrapJavaScriptExpression(socket.value as t.Node).node;
      // An absent member is not a wrapped stream, so the port is validated.
      if (isAbsentOptionValue(value, state)) return "validates";
      // A truthy literal cannot be a `net.Socket`, so the wrap throws instead.
      if (!isExactlyReadableLiteral(value, state)) return "unknown";
      return isStaticallyFalsyOptionLiteral(value) ? "validates" : "rejects";
    }
  }
  return "validates";
};

/** Whether a number is a TCP port Node accepts. */
const isUsablePortNumber = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= 65535;
