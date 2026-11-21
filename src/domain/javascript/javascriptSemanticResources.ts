import * as t from "@babel/types";
import { rejectsSemanticEventListener } from "./javascriptSemanticAsyncEffects.js";

import {
  BUILTIN_RESOURCE_SPECIFIERS,
  BUILTIN_RESOURCE_METHODS,
  builtinResourceReleases,
  type BuiltinResourceReleaseMember,
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
import { isUnmodifiedGlobalReference } from "./javascriptSemanticGlobalReference.js";
import {
  bindingEffectsConfinedToReceiverCalls,
  bindingMethodMayHaveChanged,
  opaqueCodeMayRebindBinding,
  prototypeMutationMayPrecede,
} from "./javascriptSemanticEffectLog.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
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
  requiredModuleChanged,
  traverseDataEffects,
  type DataEffectTraversalContext,
} from "./javascriptSemanticDataEffectHelpers.js";
import { FS_OPEN_FLAGS, range } from "./javascriptStaticAnalysisHelpers.js";

const RELEASE_METHODS = ["close", "destroy", "end"] as const;

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
      !usesSocketArguments(candidate) ||
      candidate.builtinAuthority === "candidate" ||
      !rejectsSocketArguments(candidate.node, candidate.specifier, context),
  );
  return [
    ...acquisitions.map(immutableAcquisition),
    ...collectReleases(program, context, acquisitions),
  ];
};

/** A fresh function value with no user-defined own properties. */
const isFunctionExpressionOrMethod = (value: t.Node): boolean =>
  t.isFunctionExpression(value) ||
  t.isArrowFunctionExpression(value) ||
  t.isObjectMethod(value, { kind: "method" });

const isFunctionValuedSyntax = (value: t.Node): boolean =>
  isFunctionExpressionOrMethod(value) || t.isClassExpression(value);

/** Literal kinds Node rejects for both open flags and modes. */
const rejectsFlagOrModeLiteral = (value: t.Node): boolean => {
  return (
    isFunctionValuedSyntax(value) ||
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
 * `fs.open`/`fs.openSync` validate the flag before touching the filesystem, so
 * a flag Node rejects at the call site throws synchronously and no descriptor
 * exists. Node accepts only a known flag string, a nullish value (which defaults
 * to `"r"`), or a bitmask integer; everything else throws. A computed value may
 * still be valid, so only an exactly readable literal is decided.
 */
const rejectsOpenFlagLiteral = (
  node: t.CallExpression | t.OptionalCallExpression,
  context: DataEffectTraversalContext,
  callbackForm: boolean,
): boolean => {
  // A spread before the flag slot shifts the runtime position, so argument 1 is
  // not provably the flag. `openSync(...args, "0600")` with
  // `args = [path, "w"]` opens with mode `"0600"`, not with an invalid flag.
  if (t.isSpreadElement(node.arguments[0])) return false;
  const flag = node.arguments[1];
  if (flag === undefined || t.isSpreadElement(flag)) return false;
  const value = unwrapJavaScriptExpression(flag).node;
  // fs.open(path, callback) defaults the flags. Later spreads may all be
  // empty; a fixed third argument is needed to exclude that overload.
  if (
    callbackForm &&
    isFunctionValuedSyntax(value) &&
    node.arguments.every(
      (argument, index) => index < 2 || t.isSpreadElement(argument),
    )
  )
    return false;
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
  return rejectsFlagOrModeLiteral(value);
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
  return (
    primitiveToNumber(value) ?? nonFiniteGlobalNumber(value, context.state)
  );
};

/**
 * The number an unshadowed `NaN` or `Infinity` evaluates to, or `undefined` when the
 * operand names neither. A `~` over one is a finite int32, which is why the bitwise
 * result must be computed rather than treated as non-finite.
 */
const nonFiniteGlobalNumber = (
  value: t.Node,
  state: JavaScriptSemanticAnalysisState,
): number | undefined => {
  if (
    !t.isIdentifier(value) ||
    (value.name !== "NaN" && value.name !== "Infinity") ||
    !isUnmodifiedGlobalReference(value, state, value.name)
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
  callbackForm: boolean,
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
  // Only callback-form fs.open treats a function in this slot as its callback.
  if (callbackForm && isFunctionValuedSyntax(value)) return false;
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
  return rejectsFlagOrModeLiteral(value);
};

/** `fs.open`, `fs.openSync` and `fs/promises.open` take the flag in slot 1. */
const openFlagInFirstArgument = (reference: AcquisitionReference): boolean =>
  reference.method === "open" || reference.method === "openSync"
    ? reference.specifier === "fs" || reference.specifier === "fs/promises"
    : false;

/** Node normalizes fs.open's callback before validating its function type. */
const rejectsOpenCallbackLiteral = (
  node: t.CallExpression | t.OptionalCallExpression,
): boolean => {
  // A spread can change both arity and which operand is the callback.
  if (node.arguments.some((argument) => t.isSpreadElement(argument)))
    return false;
  if (node.arguments.length < 3)
    return rejectsSemanticEventListener(node.arguments[1]);
  // A function-valued mode is the callback; an unknown mode may be one too.
  // Both can supersede a missing or invalid fourth operand.
  if (!rejectsSemanticEventListener(node.arguments[2])) return false;
  return rejectsSemanticEventListener(node.arguments[3]);
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
    if (
      openFlagInFirstArgument(reference) &&
      reference.builtinAuthority !== "candidate"
    ) {
      const callbackForm =
        reference.specifier === "fs" && reference.method === "open";
      if (callbackForm && rejectsOpenCallbackLiteral(node)) return;
      if (rejectsOpenFlagLiteral(node, context, callbackForm)) return;
      if (rejectsOpenModeLiteral(node, context, callbackForm)) return;
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

/** FileHandle.close can run close listeners. Exempt receiver effects only
 * when the binding has no writes or exposures besides direct native closes. */
const hasOnlyDirectCloseInvocations = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  bindingEffectsConfinedToReceiverCalls(binding, (node) => {
    if (!t.isCallExpression(node) || node.arguments.length !== 0) return false;
    const member = dataEffectMemberCallee(node);
    return (
      member !== null &&
      t.isIdentifier(member.object) &&
      semanticStaticPropertyName(member.property, member.computed) ===
        "close" &&
      resolveSemanticBindingState(state, member.object, member.object.name) ===
        binding
    );
  });

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
  const isolatedFileHandles = new Map<string, boolean>();
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
    const opaqueReceiver = opaqueCodeMayRebindBinding(
      binding,
      context.state,
      member.object,
    );
    const receiver = semanticBindingAtRead(
      binding,
      member.object,
      context.state,
    );
    const knownAcquisitions = new Set<t.Node>(
      candidates
        .filter(({ builtinAuthority }) => builtinAuthority === undefined)
        .map(({ node }) => node),
    );
    const selectedSources = [
      ...receiver.binding.initializers,
      ...receiver.binding.referenceInitializers,
    ];
    const fresh =
      receiver.status === "ordered" &&
      receiver.hasDefiniteInitializer &&
      selectedSources.length > 0 &&
      selectedSources.every(
        ({ node, projection }) =>
          projection.length === 0 &&
          knownAcquisitions.has(resourceInitializer(node).value),
      );
    const releasesFor = (acquisition: ResourceCandidate) =>
      builtinResourceReleases(acquisition.specifier, acquisition.method);
    const linked = candidates.filter(
      (acquisition) =>
        releasesFor(acquisition)?.[method] !== undefined &&
        (!acquisition.resultIsPromise ||
          opaqueReceiver ||
          mayReceiveFulfilledHandle(
            receiver.binding,
            acquisition,
            knownAcquisitions,
            context.state,
          )),
    );
    // No linked acquisition exposes this release method, so the call is not a
    // release of it at all: Node throws at the call site instead.
    if (linked.length === 0) return;
    const possibleAcquisitions = new Set(linked.map(({ node }) => node));
    const [first] = linked;
    const members =
      linked.length === 1 && first ? releasesFor(first) : undefined;
    const release = members?.[method];
    const streamConstructor =
      first?.specifier !== "fs"
        ? undefined
        : first.method === "createReadStream"
          ? "ReadStream"
          : first.method === "createWriteStream"
            ? "WriteStream"
            : undefined;
    const streamConstructorMayHaveChanged =
      first !== undefined &&
      streamConstructor !== undefined &&
      requiredModuleChanged(
        "fs",
        [streamConstructor],
        first.node,
        context.state,
      );
    let isolatedNativeCloses = false;
    if (
      fresh &&
      first?.specifier === "fs/promises" &&
      release?.owner === "instance"
    ) {
      isolatedNativeCloses =
        isolatedFileHandles.get(binding.bindingId) ??
        hasOnlyDirectCloseInvocations(binding, context.state);
      isolatedFileHandles.set(binding.bindingId, isolatedNativeCloses);
      isolatedNativeCloses =
        isolatedNativeCloses &&
        !requiredModuleChanged(
          "events",
          ["prototype", "emit"],
          member,
          context.state,
        );
    }
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
        !streamConstructorMayHaveChanged &&
        release !== undefined &&
        !releaseMethodMayHaveChanged(
          binding,
          method,
          member,
          context.state,
          possibleAcquisitions,
          { fresh, release, isolatedNativeCloses },
        ) &&
        !release.delegates?.some((dependency) =>
          releaseMethodMayHaveChanged(
            binding,
            dependency,
            node,
            context.state,
            possibleAcquisitions,
            { fresh, release: members?.[dependency] },
          ),
        ) &&
        (binding.kind !== "parameter" || receiver.hasDefiniteInitializer) &&
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
  {
    fresh,
    release,
    isolatedNativeCloses = false,
  }: {
    fresh: boolean;
    release: BuiltinResourceReleaseMember | undefined;
    isolatedNativeCloses?: boolean;
  },
): boolean => {
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
  return bindingMethodMayHaveChanged(binding, method, read, state, {
    fresh,
    inherited: release?.owner !== "instance",
    definingPrototypeDepth: fresh ? release?.definingPrototypeDepth : undefined,
    isolatedNativeCloses,
    targets: targetsAcquisition,
  });
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
 * Decide synchronous socket argument refusals from one normalized call. TLS may
 * replace a positional port with a later option before the socket reads it.
 */
const rejectsSocketArguments = (
  node: t.CallExpression | t.OptionalCallExpression,
  specifier: string,
  context: DataEffectTraversalContext,
): boolean => {
  const { state } = context;
  const effective = socketOptionReader(node, specifier, state);
  if (effective === undefined) return false;

  const inheritable = prototypeMutationMayPrecede(state, "Object", node);
  const truthiness = (value: SocketOptionValue): boolean | undefined =>
    value === undefined && inheritable
      ? undefined
      : socketOptionTruthiness(value, state);
  const rejectsStringOption = (value: SocketOptionValue): boolean => {
    if (value === undefined || value === "unknown") return false;
    const kind = socketArgumentKind(
      unwrapJavaScriptExpression(value).node,
      state,
    );
    return kind === "object" || kind === "non-object";
  };
  if (specifier === "tls") {
    const lacksFunctionMembers = (value: SocketOptionValue): boolean =>
      value !== undefined &&
      value !== "unknown" &&
      isFunctionExpressionOrMethod(unwrapJavaScriptExpression(value).node) &&
      !inheritable &&
      !prototypeMutationMayPrecede(state, "Function", node);
    // A fresh function has no native `context` member, and TLS checks it
    // when a supplied secure context bypasses version parsing.
    if (lacksFunctionMembers(effective("secureContext"))) return true;
    if (rejectsTlsProtocolVersionLiteral(effective, state)) return true;

    // A supplied socket bypasses transport connection only once it can be wrapped.
    const socket = effective("socket");
    const supplied = truthiness(socket);
    if (supplied !== false)
      return (
        supplied === true &&
        socket !== undefined &&
        socket !== "unknown" &&
        (lacksFunctionMembers(socket) ||
          rejectsSuppliedTlsSocket(socket, node, state, inheritable))
      );
  }
  // A truthy path selects a pipe and Node validates its type before TCP options.
  const path = effective("path");
  const hasPath = truthiness(path);
  if (hasPath === undefined) return false;
  if (hasPath) return rejectsStringOption(path);

  const port = effective("port");
  if (port === undefined && specifier === "net" && node.arguments.length === 0)
    return true;
  if (
    port !== undefined &&
    port !== "unknown" &&
    rejectsSocketPortValue(port, context, path)
  )
    return true;

  const host = effective("host");
  // Node falls back to localhost for falsy hosts. An unknown host cannot prove a refusal.
  return truthiness(host) === true && rejectsStringOption(host);
};

const socketOptionTruthiness = (
  value: SocketOptionValue,
  state: JavaScriptSemanticAnalysisState,
): boolean | undefined => {
  if (value === "unknown") return undefined;
  if (value === undefined || isNullishPlaceholder(value, state)) return false;
  const syntax = unwrapJavaScriptExpression(value).node;
  const literal = readExactJavaScriptLiteral(syntax);
  if (literal.found) return Boolean(literal.value);
  const number = nonFiniteGlobalNumber(syntax, state);
  if (number !== undefined) return Boolean(number);
  if (t.isNewExpression(syntax) || isFunctionValuedSyntax(syntax)) return true;
  return staticJavaScriptTruthiness(syntax);
};

/** Node calls `pause()` when wrapping a supplied stream without a native socket handle. */
const rejectsSuppliedTlsSocket = (
  socket: t.Node,
  call: t.CallExpression | t.OptionalCallExpression,
  state: JavaScriptSemanticAnalysisState,
  inheritable: boolean,
): boolean => {
  const syntax = unwrapJavaScriptExpression(socket).node;
  const isNullish = (value: t.Node) => isNullishPlaceholder(value, state);
  if (t.isObjectExpression(syntax)) {
    const pause = staticObjectPropertyReader(syntax, isNullish)("pause");
    if (pause.status === "missing") return !inheritable;
    return (
      pause.status === "explicit" &&
      primitiveOwnKeys(
        unwrapJavaScriptExpression(pause.value).node,
        isNullish,
      ) !== null
    );
  }
  const scalar =
    primitiveOwnKeys(syntax, isNullish) !== null ||
    nonFiniteGlobalNumber(syntax, state) !== undefined;
  return (
    scalar &&
    !inheritable &&
    !["BigInt", "Boolean", "Number", "String"].some((owner) =>
      prototypeMutationMayPrecede(state, owner, call),
    )
  );
};

/** Validate a TCP port after later options and pipe precedence are resolved. */
const rejectsSocketPortValue = (
  value: t.Node,
  context: DataEffectTraversalContext,
  path: t.Node | "unknown" | undefined,
): boolean => {
  const unwrapped = unwrapJavaScriptExpression(value).node;
  if (t.isStringLiteral(unwrapped)) {
    if (unwrapped.value.trim().length === 0) return true;
    const port = Number(unwrapped.value);
    return !Number.isInteger(port) || port < 0 || port > 65535;
  }
  if (t.isTemplateLiteral(unwrapped) && unwrapped.expressions.length === 0) {
    const cooked = unwrapped.quasis[0]?.value.cooked;
    if (cooked === null || cooked === undefined || cooked.trim().length === 0)
      return true;
    const port = Number(cooked);
    return !Number.isInteger(port) || port < 0 || port > 65535;
  }
  if (
    (t.isUnaryExpression(unwrapped, { operator: "void" }) ||
      isUnmodifiedGlobalReference(unwrapped, context.state, "undefined")) &&
    path !== undefined &&
    path !== "unknown" &&
    !isNullishPlaceholder(path, context.state)
  )
    return false;
  if (
    isNullishPlaceholder(unwrapped, context.state) ||
    t.isBigIntLiteral(unwrapped) ||
    t.isBooleanLiteral(unwrapped) ||
    t.isObjectExpression(unwrapped) ||
    t.isArrayExpression(unwrapped) ||
    t.isRegExpLiteral(unwrapped) ||
    isFunctionValuedSyntax(unwrapped) ||
    t.isNewExpression(unwrapped)
  )
    return true;
  if (
    t.isIdentifier(unwrapped) &&
    (unwrapped.name === "NaN" || unwrapped.name === "Infinity") &&
    isUnmodifiedGlobalReference(unwrapped, context.state, unwrapped.name)
  )
    return true;
  if (t.isNumericLiteral(unwrapped))
    return (
      !Number.isInteger(unwrapped.value) ||
      unwrapped.value < 0 ||
      unwrapped.value > 65535
    );
  if (t.isUnaryExpression(unwrapped)) {
    if (
      unwrapped.operator === "!" ||
      unwrapped.operator === "delete" ||
      unwrapped.operator === "typeof"
    )
      return true;
    const number = unaryOperandNumber(unwrapped, context, 0);
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

const socketArgumentKind = (
  value: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): "object" | "non-object" | "possibly-string" | "unknown" => {
  if (value === undefined) return "non-object";
  if (
    t.isObjectExpression(value) ||
    t.isArrayExpression(value) ||
    t.isRegExpLiteral(value) ||
    t.isNewExpression(value)
  )
    return "object";
  if (
    isFunctionValuedSyntax(value) ||
    nonFiniteGlobalNumber(value, state) !== undefined
  )
    return "non-object";
  const keys = primitiveOwnKeys(value, (child) =>
    isNullishPlaceholder(child, state),
  );
  if (keys === "indices") return "possibly-string";
  return keys === "none" ? "non-object" : "unknown";
};

type SocketOptionValue = t.Node | "unknown" | undefined;
type SocketOptionReader = (member: string) => SocketOptionValue;

/** Node's net._normalizeArgs treats exactly strings coercible to >= 0 as ports. */
const positionalSocketOptions = (
  value: t.Node | undefined,
  possiblyString: boolean,
): { readonly path?: SocketOptionValue; readonly port?: SocketOptionValue } => {
  if (value === undefined) return {};
  if (!possiblyString) return { port: value };
  // typeof always yields a nonnumeric string. Other string-producing syntax
  // may need its runtime value to distinguish a pipe from a TCP port.
  if (t.isUnaryExpression(value, { operator: "typeof" }))
    return { path: value };
  const literal = readExactJavaScriptLiteral(value);
  if (literal.found && typeof literal.value === "string")
    return Number(literal.value) >= 0 ? { port: value } : { path: value };
  return { path: "unknown", port: "unknown" };
};

/**
 * The value Node reads for one `net`/`tls` option member: a node, `undefined` when
 * the member is absent, or `"unknown"` when an accessor, a prototype write or a
 * dynamic copy could change it. TLS merges its second or third argument over
 * the object or positional options selected by net's normalizer. Returns
 * `undefined` when the options themselves are not statically known.
 *
 * The answer stays unknown whenever an accessor could have written the member
 * first. Measured on Node 24.22.1,
 * `{get side() { this.minVersion = "TLSv1.2"; }, minVersion: "nope"}` connects because
 * the getter runs during Node's own copy, and a `set minVersion` in an earlier argument
 * absorbs a later write. Both are bodies this reader does not run.
 */
const socketOptionReader = (
  node: t.CallExpression | t.OptionalCallExpression,
  specifier: string,
  state: JavaScriptSemanticAnalysisState,
): SocketOptionReader | undefined => {
  const argument = (index: number): SocketOptionValue => {
    const value = node.arguments[index];
    if (t.isSpreadElement(value)) return "unknown";
    return value === undefined
      ? undefined
      : unwrapJavaScriptExpression(value as t.Node).node;
  };
  // Each caller reads a fixed prefix. Net only takes the port or path from
  // argument 0 and only copies a positional host if it is a string. TLS
  // can also merge options from argument 1 or 2. A spread beyond the
  // participating slots cannot change those options.
  const first = argument(0);
  if (first === "unknown") return undefined;
  const firstKind = socketArgumentKind(first, state);
  if (
    firstKind === "unknown" ||
    (firstKind === "object" && !t.isObjectExpression(first))
  )
    return undefined;
  const target = t.isObjectExpression(first) ? first : undefined;
  const positional =
    firstKind === "object"
      ? {}
      : positionalSocketOptions(first, firstKind === "possibly-string");
  let source: t.Node | undefined;
  if (specifier === "tls") {
    const second = argument(1);
    if (second === "unknown") return undefined;
    const secondKind = socketArgumentKind(second, state);
    if (secondKind === "unknown") return undefined;
    const merged = secondKind === "object" ? second : argument(2);
    if (merged === "unknown") return undefined;
    source = merged;
  }
  const isNullish = (value: t.Node) => isNullishPlaceholder(value, state);
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
    return undefined;
  const sourceReader = staticObjectCopyPropertyReader(source, isNullish);
  const copiedPrototype = sourceReader("__proto__");
  if (
    copiedPrototype.status === "dynamic" ||
    (copiedPrototype.status === "explicit" &&
      primitiveOwnKeys(copiedPrototype.value, isNullish) === null)
  )
    return undefined;
  const objects = [target, source].filter(
    (value): value is t.ObjectExpression => t.isObjectExpression(value),
  );
  const accessorWritten = objects.some((options) =>
    options.properties.some(
      (property) => t.isObjectMethod(property) && property.kind !== "method",
    ),
  );
  const readers = [staticObjectPropertyReader(target, isNullish), sourceReader];
  return (member) => {
    let read =
      member === "path" || member === "port" ? positional[member] : undefined;
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
 * not, so only a truthy context ends the check. An unknown member keeps the
 * acquisition (see `socketOptionReader`).
 *
 * Only `tls` reads these members, so `net` is not consulted.
 */
const rejectsTlsProtocolVersionLiteral = (
  effective: SocketOptionReader,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  // A truthy context means Node never parses the members at all. The shared owner
  // already treats `-0` as falsy. Measured on Node 24.22.1,
  // `{secureContext: -0, minVersion: "nope"}` throws while a real context connects.
  const context = effective("secureContext");
  if (socketOptionTruthiness(context, state) !== false) return false;
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
      isFunctionValuedSyntax(read) ||
      t.isNumericLiteral(read) ||
      t.isBooleanLiteral(read) ||
      t.isBigIntLiteral(read) ||
      t.isObjectExpression(read) ||
      t.isArrayExpression(read) ||
      t.isRegExpLiteral(read) ||
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
  return rejectsSecureProtocolLiteral(effective, state);
};

/**
 * The `secureProtocol` method names Node accepts. Measured on Node 24.22.1, these
 * connect while `"SSLv2_method"`, `"SSLv3_method"` and their client/server forms,
 * `"TLSv1_3_method"`, `"DTLS_method"`, `"tls_method"`, `"TLS_METHOD"`, `"bogus"`
 * and `""` throw `ERR_TLS_INVALID_PROTOCOL_METHOD`. The set is exact and
 * case-sensitive.
 */
const TLS_SECURE_PROTOCOLS = new Set(
  ["TLS", "TLSv1", "TLSv1_1", "TLSv1_2", "SSLv23"].flatMap((family) => [
    `${family}_method`,
    `${family}_client_method`,
    `${family}_server_method`,
  ]),
);

/**
 * Whether `secureProtocol` makes `tls.connect` throw before a socket exists.
 *
 * Measured on Node 24.22.1, after the same truthy-`secureContext` bypass as the
 * version members:
 *
 *   a string outside TLS_SECURE_PROTOCOLS, including ""  -> THREW ERR_TLS_INVALID_PROTOCOL_METHOD
 *   a non-string value such as 5, true or {}             -> socket (Node ignores it)
 *   a truthy value beside a minVersion or maxVersion that
 *   is not null or undefined, even "TLS_method"          -> THREW ERR_TLS_PROTOCOL_VERSION_CONFLICT
 *   "TLS_method" beside a null or undefined version      -> socket
 *   0 beside a minVersion                                -> socket
 */
const rejectsSecureProtocolLiteral = (
  effective: SocketOptionReader,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const protocol = effective("secureProtocol");
  if (protocol === undefined || protocol === "unknown") return false;
  const read = unwrapJavaScriptExpression(protocol).node;
  if (isNullishPlaceholder(read, state)) return false;
  const literal = readExactJavaScriptLiteral(read);
  if (
    literal.found &&
    typeof literal.value === "string" &&
    !TLS_SECURE_PROTOCOLS.has(literal.value)
  )
    return true;
  if (socketOptionTruthiness(read, state) !== true) return false;
  return (["minVersion", "maxVersion"] as const).some((member) => {
    const version = effective(member);
    if (version === undefined || version === "unknown") return false;
    const value = unwrapJavaScriptExpression(version).node;
    return (
      !isNullishPlaceholder(value, state) &&
      (readExactJavaScriptLiteral(value).found ||
        t.isTemplateLiteral(value) ||
        t.isObjectExpression(value) ||
        t.isArrayExpression(value))
    );
  });
};

/** Only net and TLS acquisitions use Node socket overloads. */
const usesSocketArguments = (
  candidate: Pick<AcquisitionReference, "specifier">,
): boolean => candidate.specifier === "net" || candidate.specifier === "tls";
