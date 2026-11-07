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
  semanticStaticPropertyName,
  staticJavaScriptTruthiness,
  staticObjectProperty,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { isUnmodifiedGlobalReference } from "./javascriptSemanticAmbientWrites.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  builtinDataEffectMethod,
  builtinModuleSlotUnmodified,
  builtinModuleSubtreeUnmodified,
  dataEffectMemberCallee,
  outerDataEffectBinding,
  traverseDataEffects,
  type DataEffectTraversalContext,
} from "./javascriptSemanticDataEffectHelpers.js";
import {
  BUFFER_ENCODINGS,
  FS_OPEN_FLAGS,
  range,
} from "./javascriptStaticAnalysisHelpers.js";

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
  readonly constructorUncertain?: true;
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
  const acquisitions = collectAcquisitions(program, context)
    .map((candidate): ResourceCandidate =>
      streamOptionsInSecondArgument(candidate) &&
      (!builtinModuleSlotUnmodified(
        "fs",
        [
          candidate.method === "createReadStream"
            ? "ReadStream"
            : "WriteStream",
        ],
        candidate.node,
        state,
      ) ||
        !builtinModuleSubtreeUnmodified(
          "fs",
          [
            candidate.method === "createReadStream"
              ? "ReadStream"
              : "WriteStream",
            "prototype",
          ],
          candidate.node,
          state,
        ))
        ? { ...candidate, constructorUncertain: true }
        : candidate,
    )
    .filter(
      (candidate) =>
        !socketPortInFirstArgument(candidate) ||
        !rejectsSocketPortLiteral(candidate.node, context),
    )
    .filter(
      (candidate) =>
        !streamOptionsInSecondArgument(candidate) ||
        candidate.constructorUncertain === true ||
        !rejectsStreamOptionsLiteral(
          candidate.node,
          candidate.method === "createReadStream",
          context,
        ),
    );
  return [
    ...acquisitions.map(immutableAcquisition),
    ...collectReleases(program, context, acquisitions),
  ];
};

/**
 * `fs.createReadStream` and `fs.createWriteStream` take their options object in slot 1.
 *
 * Node validates `start`, `end`, `fd`, `highWaterMark` and `encoding` there before it
 * constructs the stream, so a value it rejects throws synchronously and no handle
 * exists. Being a stream, that handle is what the release facts attach to, so a
 * wrongly retained acquisition also invents a teardown.
 */
const streamOptionsInSecondArgument = (
  candidate: Pick<AcquisitionReference, "specifier" | "method">,
): boolean =>
  candidate.specifier === "fs" &&
  (candidate.method === "createReadStream" ||
    candidate.method === "createWriteStream");

/**
 * The number a stream-option member evaluates to, or a marker for the shapes that are
 * not numbers at all.
 *
 * `absent` is a member Node skips; `refused` is a present value whose type Node
 * rejects with `ERR_INVALID_ARG_TYPE`. `undefined` is a value this reader cannot price.
 *
 * The unary arm reuses `unaryOperandNumber`, which already resolves `-`, `+` and `~`
 * chains exactly, so `~0` is `-1` and `~-1` is `0` rather than the operand's magnitude.
 * `!`, `typeof` and `delete` yield a boolean or a string, which Node refuses.
 */
type StreamMemberValue =
  | { readonly kind: "absent" }
  | { readonly kind: "refused" }
  | { readonly kind: "number"; readonly value: number }
  | undefined;

const streamMemberValue = (
  value: t.Node,
  context: DataEffectTraversalContext,
): StreamMemberValue => {
  if (isAbsentOptionValue(value, context.state)) return { kind: "absent" };
  if (t.isNumericLiteral(value)) return { kind: "number", value: value.value };
  if (t.isUnaryExpression(value)) {
    if (
      value.operator === "!" ||
      value.operator === "typeof" ||
      value.operator === "delete"
    )
      return { kind: "refused" };
    const number = unaryOperandNumber(value, context, 0);
    return number === undefined ? undefined : { kind: "number", value: number };
  }
  if (
    t.isIdentifier(value) &&
    (value.name === "NaN" || value.name === "Infinity")
  )
    return isUnmodifiedGlobalReference(value, context.state, value.name)
      ? {
          kind: "number",
          value: value.name === "NaN" ? Number.NaN : Number.POSITIVE_INFINITY,
        }
      : undefined;
  // Every remaining exactly readable value is a type Node refuses for these members.
  // A method written in shorthand reaches this reader as an `ObjectMethod`, and a class
  // expression has the same runtime type as a function: measured on Node 24.22.1,
  // `createReadStream(p, {start(){}})`, `{start: function(){}}` and `{start: class{}}`
  // all throw `ERR_INVALID_ARG_TYPE`.
  if (
    t.isStringLiteral(value) ||
    t.isTemplateLiteral(value) ||
    t.isBooleanLiteral(value) ||
    t.isBigIntLiteral(value) ||
    t.isObjectExpression(value) ||
    t.isNewExpression(value) ||
    t.isObjectMethod(value) ||
    t.isArrayExpression(value) ||
    t.isFunctionExpression(value) ||
    t.isArrowFunctionExpression(value) ||
    t.isClassExpression(value) ||
    t.isRegExpLiteral(value)
  )
    return { kind: "refused" };
  return undefined;
};

/**
 * Whether an options literal has a member that runs code when Node copies it.
 *
 * Node enumerates the literal's own keys and copies them in declaration order, so a
 * getter listed before a plain member can replace that member's value before it is
 * read. Measured on Node 24.22.1, `createReadStream(p, {get reset(){this.start=0},
 * start:-1})` constructs a stream while the same literal without the getter throws
 * `ERR_OUT_OF_RANGE`, so the getter's presence makes every other member undecided.
 *
 * A computed string key does not help: `{get ["reset"](){this.start=0}, start:-1}`
 * also constructs a stream, because the key is materialised when the literal is
 * created and then enumerated like any other. So every getter counts, computed or not.
 *
 * A `set` accessor is not read during the copy and a plain method is not invoked, so
 * neither affects a later member.
 */
const optionsHasEagerAccessor = (object: t.ObjectExpression): boolean =>
  object.properties.some(
    (property) => t.isObjectMethod(property) && property.kind === "get",
  );

/**
 * Whether a stream's options object provably throws before the handle exists.
 *
 * Measured on Node 24.22.1. Each member has its own check, and the bounds differ:
 *
 * - `start`: an integer in `[0, Number.MAX_SAFE_INTEGER]`, so `Infinity` is out of
 *   range here. `-0` is zero, so the sign alone does not decide.
 * - `end`: the same range plus `Infinity`, which Node reads as "read to the end". A
 *   write stream ignores `end` entirely, so `createWriteStream(p, {end: -1})` still
 *   creates a handle and the `start > end` ordering check does not apply there.
 * - `fd`: an integer in `[0, 2_147_483_647]`, the signed 32-bit range.
 * - `highWaterMark`: a non-negative integer with no upper bound — `1e21` is accepted
 *   while `Infinity` is not.
 * - `encoding`: a nullish or otherwise falsy value is skipped, so only a truthy
 *   literal is decided, and a string must be one `Buffer` accepts.
 *
 * For `start`, `end` and `fd`, a string, boolean, BigInt, object, array, function or
 * regular expression throws `ERR_INVALID_ARG_TYPE`; `null` is present there while
 * `fd` and `highWaterMark` treat it as absent. A member this reader cannot price, and
 * an options expression that is not an object literal, leave the call undecided.
 */
const rejectsStreamOptionsLiteral = (
  node: t.CallExpression | t.OptionalCallExpression,
  readStream: boolean,
  context: DataEffectTraversalContext,
): boolean => {
  // A spread before the options slot shifts the runtime position, so slot 1 is not
  // provably the options object.
  if (t.isSpreadElement(node.arguments[0])) return false;
  const options = node.arguments[1];
  if (options === undefined || t.isSpreadElement(options)) return false;
  const value = unwrapJavaScriptExpression(options).node;
  if (!t.isObjectExpression(value)) return false;
  // A getter anywhere in the literal can replace another member before Node reads it,
  // so no member's declared value is what Node sees.
  if (optionsHasEagerAccessor(value)) return false;
  // Node copies into an ordinary object. An inherited setter may intercept a
  // copied value, so a source-visible prototype change before (or possibly
  // before) this call makes the copied members uncertain.
  if (
    context.state.prototypeMutationSites.some(
      (effect) =>
        effect.owner === "Object" &&
        semanticEffectTiming(node, effect.node, context.state) !== "after",
    )
  )
    return false;
  // Node copies own enumerable keys by assignment. An own __proto__ key, including
  // one supplied by a spread or dynamic key, can install setters on the copy before
  // a later option is assigned. The literal's values then do not prove a rejection.
  if (staticObjectProperty(value, "__proto__").status !== "missing")
    return false;
  const member = (name: string): StreamMemberValue => {
    const read = staticObjectProperty(value, name);
    if (read.status !== "explicit") return undefined;
    const memberValue = unwrapJavaScriptExpression(read.value as t.Node).node;
    if (name === "fd" && t.isNewExpression(memberValue)) return undefined;
    // A FileHandle can be the prototype of an object literal, so the literal's
    // shape alone does not prove that Node rejects it as a descriptor.
    if (
      name === "fd" &&
      t.isObjectExpression(memberValue) &&
      staticObjectProperty(memberValue, "__proto__").status !== "missing"
    )
      return undefined;
    return streamMemberValue(memberValue, context);
  };
  const rejectsIndex = (
    name: string,
    max: number,
    nullIsAbsent: boolean,
    unlimited: boolean,
  ): boolean => {
    const read = staticObjectProperty(value, name);
    if (read.status !== "explicit") return false;
    if (t.isNullLiteral(unwrapJavaScriptExpression(read.value as t.Node).node))
      return !nullIsAbsent;
    const found = member(name);
    if (found === undefined || found.kind === "absent") return false;
    if (found.kind === "refused") return true;
    const number = found.value;
    if (unlimited && number === Number.POSITIVE_INFINITY) return false;
    return !Number.isInteger(number) || number < 0 || number > max;
  };
  // `start` and `fd` share the safe-integer range; `end` additionally admits
  // `Infinity`, and only a read stream looks at it at all.
  if (rejectsIndex("start", Number.MAX_SAFE_INTEGER, false, false)) return true;
  if (readStream && rejectsIndex("end", Number.MAX_SAFE_INTEGER, false, true))
    return true;
  if (rejectsIndex("fd", 2_147_483_647, true, false)) return true;
  // No upper bound for a buffer budget, but `Infinity` and a fraction still throw.
  if (rejectsIndex("highWaterMark", Number.POSITIVE_INFINITY, true, false))
    return true;
  // `start` above `end` throws `ERR_OUT_OF_RANGE`. Only a read stream has an `end`,
  // and `Infinity` there is above every readable `start`, so it never trips this.
  if (readStream) {
    const start = member("start");
    const end = member("end");
    if (
      start !== undefined &&
      end !== undefined &&
      start.kind === "number" &&
      end.kind === "number" &&
      Number.isFinite(start.value) &&
      Number.isFinite(end.value) &&
      start.value > end.value
    )
      return true;
  }
  if (rejectsStreamEncoding(value, context)) return true;
  return false;
};

/**
 * Truthiness of a stream-option value, including forms the shared reader leaves open.
 *
 * `staticJavaScriptTruthiness` covers literals, but a unary result is also exactly
 * readable here: measured on Node 24.22.1, `!1` is `false` and `~-1` is `0`, both
 * skipped, while `!0`, `~0` and `typeof 1` are truthy and refused. An unshadowed
 * `Infinity` is truthy and `NaN` is falsy, matching their values.
 */
const encodingTruthiness = (
  value: t.Node,
  context: DataEffectTraversalContext,
): boolean | undefined => {
  const shared = staticJavaScriptTruthiness(value);
  if (shared !== undefined) return shared;
  // A shorthand method, a class expression and a regular expression are all objects at
  // runtime, so they are truthy like the function and object literals the shared reader
  // already covers. Measured on Node 24.22.1, `{encoding: /x/}` throws
  // `ERR_INVALID_ARG_VALUE` for both stream methods.
  if (
    t.isObjectMethod(value) ||
    t.isClassExpression(value) ||
    t.isRegExpLiteral(value) ||
    t.isNewExpression(value)
  )
    return true;
  if (
    t.isIdentifier(value) &&
    (value.name === "NaN" || value.name === "Infinity")
  )
    return isUnmodifiedGlobalReference(value, context.state, value.name)
      ? value.name === "Infinity"
      : undefined;
  if (!t.isUnaryExpression(value)) return undefined;
  // `typeof` is a non-empty string and `void` is `undefined`. A `delete`
  // expression can return either boolean, so its truthiness is unknown.
  if (value.operator === "typeof") return true;
  if (value.operator === "delete") return undefined;
  if (value.operator === "void") return false;
  // `!` over an exactly readable operand is the negation of its truthiness.
  if (value.operator === "!") {
    const operand = encodingTruthiness(
      unwrapJavaScriptExpression(value.argument).node,
      context,
    );
    return operand === undefined ? undefined : !operand;
  }
  // `-`, `+` and `~` chains resolve to a number exactly, so `~0` is `-1` and truthy
  // while `~-1` is `0` and falsy. A non-finite result is truthy except for `NaN`.
  const number = unaryOperandNumber(value, context, 0);
  if (number === undefined) return undefined;
  return number !== 0 && !Number.isNaN(number);
};

/**
 * Whether a stream `encoding` member is one Node's `Buffer` refuses.
 *
 * Node skips the member when it is falsy and otherwise requires a string `Buffer`
 * accepts. Truthiness and the string check are separate questions from the numeric
 * bounds the other members use, so this reads them separately instead of reusing the
 * index rules — a boolean or a unary result can be falsy and therefore skipped.
 *
 * Measured on Node 24.22.1: `0`, `-0`, `""`, `false`, `0n`, `NaN`, `!1` (which is
 * `false`), `~-1` (which is `0`) and a `void` member are all skipped, while `-1`, `1.5`,
 * `Infinity`, `-Infinity`, `{}`, `[]`, `!0`, `typeof 1` and a method all throw
 * `ERR_INVALID_ARG_VALUE`.
 *
 * An interpolated template stays undecided: `` `ut${"f8"}` `` produces a valid encoding,
 * so its shape alone does not prove a throw.
 */
const rejectsStreamEncoding = (
  options: t.ObjectExpression,
  context: DataEffectTraversalContext,
): boolean => {
  const read = staticObjectProperty(options, "encoding");
  if (read.status !== "explicit") return false;
  const value = unwrapJavaScriptExpression(read.value as t.Node).node;
  if (isAbsentOptionValue(value, context.state)) return false;
  const text = t.isStringLiteral(value)
    ? value.value
    : t.isTemplateLiteral(value) && value.expressions.length === 0
      ? value.quasis[0]?.value.cooked
      : undefined;
  if (text !== undefined && text !== null)
    return text.length > 0 && !BUFFER_ENCODINGS.has(text.toLowerCase());
  const truthiness = encodingTruthiness(value, context);
  if (truthiness === undefined) return false;
  // A falsy member never reaches Node's check, whatever its type.
  if (!truthiness) return false;
  // A truthy string was decided by the encoding set above; only a truthy non-string
  // reaches here, and Node refuses every one of those.
  return !t.isStringLiteral(value) && !t.isTemplateLiteral(value);
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
        linked[0]?.constructorUncertain !== true &&
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
  resolution: candidate.constructorUncertain === true ? "partial" : "complete",
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
