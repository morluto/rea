import * as t from "@babel/types";
import {
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";

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
  readExactJavaScriptLiteral,
  isObjectPrototypeSetter,
  primitiveOwnKeys,
  semanticStaticPropertyName,
  staticJavaScriptTruthiness,
  staticObjectPropertyReader,
  staticObjectCopyPropertyReader,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { isUnmodifiedGlobalReference } from "./javascriptSemanticAmbientWrites.js";
import {
  semanticOpaqueBindingEffects,
  semanticOpaqueBindingReadMayHaveChanged,
} from "./javascriptSemanticOpaqueEffects.js";
import {
  semanticBindingAtRead,
  semanticBindingEffectFollowsRead,
  semanticEffectTiming,
} from "./javascriptSemanticMutationInitializers.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticMemberEffect,
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
  /** The initial result is the opening Promise; later writes may replace it. */
  readonly resultIsPromise: boolean;
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
      (!rejectsSocketLiteralArguments(
        candidate.node,
        candidate.specifier,
        context,
      ) &&
        !rejectsTlsProtocolVersionLiteral(
          candidate.node,
          candidate.specifier,
          context.state,
        )),
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
      resultIsPromise:
        reference.builtinAuthority === undefined &&
        reference.specifier === "fs/promises" &&
        reference.method === "open" &&
        !context.ancestors.some(
          (parent) =>
            t.isAwaitExpression(parent) &&
            unwrapJavaScriptExpression(parent.argument).node === node,
        ),
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
    const opaqueReceiver = semanticOpaqueBindingReadMayHaveChanged(
      binding,
      member.object,
      context.state,
    );
    const receiver = candidates.some(({ resultIsPromise }) => resultIsPromise)
      ? semanticBindingAtRead(binding, member.object, context.state).binding
      : binding;
    const knownAcquisitions = new Set<t.Node>(
      candidates
        .filter(({ builtinAuthority }) => builtinAuthority === undefined)
        .map(({ node }) => node),
    );
    const linked = candidates.filter(
      (acquisition) =>
        releaseMethodsFor(acquisition).includes(method) &&
        (!acquisition.resultIsPromise ||
          opaqueReceiver ||
          mayReceiveFulfilledHandle(
            receiver,
            acquisition,
            knownAcquisitions,
            context.state,
          )),
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
        !opaqueReceiver &&
        !releaseMethodMayHaveChanged(
          binding,
          method,
          member,
          context.state,
          knownAcquisitions,
        ) &&
        linked.length === 1 &&
        (binding.kind !== "parameter" ||
          semanticBindingAtRead(binding, member.object, context.state)
            .hasDefiniteInitializer) &&
        holdsOnlyAcquisitions(binding, linked, context.state)
          ? "complete"
          : "partial",
    });
  });
  return output;
};

/** Receiver identity alone cannot prove a release method survived mutation. */
const releaseMethodMayHaveChanged = (
  binding: JavaScriptSemanticBindingState,
  method: string,
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
  acquisitions: ReadonlySet<t.Node>,
): boolean => {
  const prototype = (key: JavaScriptSemanticPropertyPath[number]) =>
    semanticPropertyPathKeyMatches(key, "__proto__");
  const initializer = binding.initializers[0];
  const fresh =
    binding.initializers.length === 1 &&
    initializer !== undefined &&
    acquisitions.has(resourceInitializer(initializer.node).value);
  const mayPrecede = (effect: t.Node | undefined): boolean =>
    semanticEffectTiming(read, effect, state) !== "after" &&
    !(
      fresh &&
      effect !== undefined &&
      semanticBindingEffectFollowsRead(
        binding,
        read,
        effect,
        state.parentsByNode,
      )
    );
  const targetsAcquisition = (
    effect: JavaScriptSemanticMemberEffect,
  ): boolean => {
    const capture = effect.receiverAt ?? effect.node;
    if (capture === undefined) return true;
    const selected = semanticBindingAtRead(binding, capture, state);
    if (selected.status !== "ordered") return true;
    // Empty incoming values cannot be the fresh acquisition selected later.
    // Keep ambiguous aliases and projections unless the owner excludes them.
    return [
      ...selected.binding.initializers,
      ...selected.binding.referenceInitializers,
    ].some(
      ({ node, projection }) =>
        projection.length > 0 ||
        !binding.initializers.some((source) => source.node === node) ||
        acquisitions.has(resourceInitializer(node).value),
    );
  };
  return (
    // A const binding still exposes mutable receiver properties to direct eval.
    [...semanticOpaqueBindingEffects(binding, state, "reference")].some(
      mayPrecede,
    ) ||
    binding.memberWrites.some((effect) => {
      const { path, node } = effect;
      return (
        targetsAcquisition(effect) &&
        (path.length === 0 ||
          (path.length === 1 &&
            semanticPropertyPathKeyMatches(path[0]!, method)) ||
          prototype(path[0]!)) &&
        mayPrecede(node)
      );
    }) ||
    binding.escapedPaths.some((effect) => {
      const { path, node } = effect;
      // Passing the function itself cannot replace its native [[Call]].
      return (
        targetsAcquisition(effect) &&
        (path.length === 0 || prototype(path[0]!)) &&
        // This invocation receives the receiver after selecting its method.
        node !== state.parentsByNode.get(read) &&
        mayPrecede(node)
      );
    })
  );
};

/** Unwrap only direct awaits; a standalone await does not write its operand. */
const resourceInitializer = (node: t.Node) => {
  let value = unwrapJavaScriptExpression(node).node;
  let awaited = false;
  while (t.isAwaitExpression(value)) {
    awaited = true;
    value = unwrapJavaScriptExpression(value.argument).node;
  }
  return { value, awaited };
};

/** Unknown receiver writes retain a candidate; known other acquisitions do not alias it. */
const mayReceiveFulfilledHandle = (
  binding: JavaScriptSemanticBindingState,
  acquisition: ResourceCandidate,
  knownAcquisitions: ReadonlySet<t.Node>,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  [...binding.initializers, ...binding.referenceInitializers].some(
    ({ node, projection }) => {
      if (projection.length > 0) return true;
      const { value, awaited } = resourceInitializer(node);
      if (value === acquisition.node) return awaited;
      if (isNullishPlaceholder(value, state)) return false;
      return !knownAcquisitions.has(value);
    },
  );

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
      const { value } = resourceInitializer(node);
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
 * `net` and `tls` validate a numeric port before creating a socket, so a
 * literal port outside `[0, 65535]`, a fractional, non-finite, BigInt, boolean
 * or `null` first argument throws synchronously and no socket exists. A string
 * is a Unix socket path and an object may carry a path, so only an exactly
 * readable non-port literal is decided. `""` is a path with no length, which
 * Node also rejects.
 *
 * `net` also rejects an omitted or undefined port, before it returns a socket.
 * TLS merges later options, so an undefined first argument alone cannot decide
 * its admission. Object arguments and spread positions remain undecided here.
 */
const rejectsSocketLiteralArguments = (
  node: t.CallExpression | t.OptionalCallExpression,
  specifier: string,
  context: DataEffectTraversalContext,
): boolean => {
  const port = node.arguments[0];
  if (port === undefined) return specifier === "net";
  if (t.isSpreadElement(port)) return false;
  const value = unwrapJavaScriptExpression(port).node;
  if (
    specifier === "net" &&
    (t.isUnaryExpression(value, { operator: "void" }) ||
      isUnmodifiedGlobalReference(value, context.state, "undefined"))
  )
    return true;
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
  // Numeric unary operators are judged by their result: `-0` is port zero,
  // and `~(-1.5)` is zero too. `typeof` instead yields a nonempty IPC path.
  if (t.isUnaryExpression(value)) {
    if (value.operator === "!" || value.operator === "delete") return true;
    const number = unaryOperandNumber(value, context, 0);
    return (
      number !== undefined &&
      (!Number.isInteger(number) || number < 0 || number > 65535)
    );
  }
  return false;
};

/**
 * The TLS protocol version names Node accepts for `minVersion` and `maxVersion`.
 *
 * Measured on Node 24.22.1: `"TLSv1"`, `"TLSv1.1"`, `"TLSv1.2"` and `"TLSv1.3"` connect
 * while `"TLSv1.0"`, `"tlsv1"`, `"tlsv1.2"`, `"TLSv1.4"`, `"nope"` and `""` throw
 * `ERR_TLS_INVALID_PROTOCOL_VERSION`. The set is exact and case-sensitive, so it is a
 * closed list rather than a pattern.
 */
const TLS_PROTOCOL_VERSIONS = new Set([
  "TLSv1",
  "TLSv1.1",
  "TLSv1.2",
  "TLSv1.3",
]);

/** Select Node's merge target and source without conflating typeof with own keys. */
const tlsOptionMerge = (
  node: t.CallExpression | t.OptionalCallExpression,
  state: JavaScriptSemanticAnalysisState,
):
  | {
      readonly target: t.ObjectExpression | "fresh" | "unknown";
      readonly source: t.Node | undefined;
    }
  | undefined => {
  if (node.arguments.some((argument) => t.isSpreadElement(argument)))
    return undefined;
  const argument = (index: number): t.Node | undefined => {
    const value = node.arguments[index];
    return value === undefined
      ? undefined
      : unwrapJavaScriptExpression(value as t.Node).node;
  };
  const objectKind = (
    value: t.Node | undefined,
  ): "object" | "non-object" | "unknown" => {
    if (value === undefined) return "non-object";
    if (
      t.isObjectExpression(value) ||
      t.isArrayExpression(value) ||
      t.isRegExpLiteral(value) ||
      t.isNewExpression(value)
    )
      return "object";
    if (
      t.isFunctionExpression(value) ||
      t.isArrowFunctionExpression(value) ||
      t.isClassExpression(value) ||
      primitiveOwnKeys(value, (child) => isNullishPlaceholder(child, state)) !==
        null
    )
      return "non-object";
    return "unknown";
  };
  const first = argument(0);
  const firstKind = objectKind(first);
  const second = argument(1);
  const secondKind = objectKind(second);
  if (firstKind === "unknown" || secondKind === "unknown") return undefined;
  return {
    target:
      firstKind === "non-object"
        ? "fresh"
        : t.isObjectExpression(first)
          ? first
          : "unknown",
    source: secondKind === "object" ? second : argument(2),
  };
};

/**
 * Whether a `tls` call carries a protocol version Node rejects.
 *
 * `tls.connect` resolves the version before it opens a socket, so a bad literal throws
 * from the call itself and no socket exists. Measured on Node 24.22.1: `null` and
 * `undefined` are accepted as "not given", every other non-string value throws
 * `ERR_TLS_INVALID_PROTOCOL_VERSION` (a BigInt throws `TypeError`), and a string is
 * accepted only when it is one of `TLS_PROTOCOL_VERSIONS`.
 *
 * A truthy `secureContext` bypasses version parsing — Node uses
 * `options.secureContext || tls.createSecureContext(options)` — while a falsy one does
 * not, so only a truthy context ends the check.
 *
 * The answer stays undecided, which keeps the acquisition, whenever an accessor could
 * have written the member first. Measured on Node 24.22.1,
 * `{get side() { this.minVersion = "TLSv1.2"; }, minVersion: "nope"}` connects because
 * the getter runs during Node's own copy, and a `set minVersion` in an earlier argument
 * absorbs a later write. Both are bodies this reader does not run.
 *
 * Only `tls` reads these members, so `net` is not consulted.
 */
const rejectsTlsProtocolVersionLiteral = (
  node: t.CallExpression | t.OptionalCallExpression,
  specifier: string,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (specifier !== "tls") return false;
  const merge = tlsOptionMerge(node, state);
  if (merge === undefined || merge.target === "unknown") return false;
  const isNullish = (value: t.Node) => isNullishPlaceholder(value, state);
  const target = merge.target === "fresh" ? undefined : merge.target;
  // A known source value proves the final option only when target writes are
  // ordinary. Target prototypes and copied __proto__ can absorb later writes.
  if (
    target?.properties.some(
      (property) =>
        !t.isSpreadElement(property) &&
        isObjectPrototypeSetter(property) &&
        t.isObjectProperty(property) &&
        primitiveOwnKeys(property.value, isNullish) === null,
    )
  )
    return false;
  const sourceReader = staticObjectCopyPropertyReader(merge.source, isNullish);
  const copiedPrototype = sourceReader("__proto__");
  if (
    copiedPrototype.status === "dynamic" ||
    (copiedPrototype.status === "explicit" &&
      primitiveOwnKeys(copiedPrototype.value, isNullish) === null)
  )
    return false;
  const objects = [target, merge.source].filter(
    (value): value is t.ObjectExpression => t.isObjectExpression(value),
  );
  const accessorWritten = objects.some((options) =>
    options.properties.some(
      (property) => t.isObjectMethod(property) && property.kind !== "method",
    ),
  );
  const readers = [staticObjectPropertyReader(target, isNullish), sourceReader];
  const effective = (member: string): t.Node | "unknown" | undefined => {
    let read: t.Node | "unknown" | undefined;
    for (const reader of readers) {
      const property = reader(member);
      if (property.status === "missing") continue;
      read =
        property.status !== "explicit" || accessorWritten
          ? "unknown"
          : property.value;
    }
    return read;
  };
  // A truthy context means Node never parses the members at all. The shared owner
  // already treats `-0` as falsy. Measured on Node 24.22.1,
  // `{secureContext: -0, minVersion: "nope"}` throws while a real context connects.
  const context = effective("secureContext");
  if (context === "unknown") return false;
  if (
    context !== undefined &&
    !isNullishPlaceholder(context, state) &&
    staticJavaScriptTruthiness(context) !== false
  )
    return false;
  const rejectsValue = (value: t.Node): boolean => {
    const read = unwrapJavaScriptExpression(value).node;
    // `null` and `undefined` mean "not given", which Node accepts.
    if (isNullishPlaceholder(read, state)) return false;
    if (t.isStringLiteral(read)) return !TLS_PROTOCOL_VERSIONS.has(read.value);
    if (t.isTemplateLiteral(read) && read.expressions.length === 0) {
      const cooked = read.quasis[0]?.value.cooked;
      if (cooked === null || cooked === undefined) return false;
      return !TLS_PROTOCOL_VERSIONS.has(cooked);
    }
    // Numeric, boolean and typeof results cannot equal an admitted version
    // string. `void` is the accepted undefined/default case.
    if (t.isUnaryExpression(read)) return read.operator !== "void";
    // `NaN` and `Infinity` are unshadowed globals and neither is a version name, the
    // same way the adjacent port filter treats them.
    if (
      t.isIdentifier(read) &&
      (read.name === "NaN" || read.name === "Infinity") &&
      isUnmodifiedGlobalReference(read, state, read.name)
    )
      return true;
    if (readExactJavaScriptLiteral(read).found) return true;
    // Every other statically known shape is truthy and not a string, so the call throws.
    if (
      t.isObjectMethod(read) ||
      t.isNumericLiteral(read) ||
      t.isBooleanLiteral(read) ||
      t.isBigIntLiteral(read) ||
      t.isObjectExpression(read) ||
      t.isArrayExpression(read) ||
      t.isRegExpLiteral(read) ||
      t.isArrowFunctionExpression(read) ||
      t.isFunctionExpression(read) ||
      t.isClassExpression(read) ||
      t.isNewExpression(read)
    )
      return true;
    return false;
  };
  for (const member of ["minVersion", "maxVersion"] as const) {
    const read = effective(member);
    if (read === undefined || read === "unknown") continue;
    if (rejectsValue(read)) return true;
  }
  return false;
};

/** Only `net`/`tls` sockets take a port in argument 0. */
const socketPortInFirstArgument = (
  candidate: Pick<AcquisitionReference, "specifier">,
): boolean => candidate.specifier === "net" || candidate.specifier === "tls";
