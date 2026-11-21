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
  isNullishJavaScriptSyntax,
  isObjectPrototypeSetter,
  primitiveOwnKeys,
  semanticStaticPropertyKey,
  semanticStaticPropertyName,
  staticJavaScriptTruthiness,
  staticObjectProperty,
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
      !socketPortInFirstArgument(candidate) ||
      (!rejectsSocketLiteralArguments(
        candidate.node,
        candidate.specifier,
        context,
      ) &&
        !rejectsSocketOptionsPort(
          candidate.node,
          candidate.specifier,
          context,
        ) &&
        !rejectsTlsProtocolVersionLiteral(
          candidate.node,
          candidate.specifier,
          context.state,
        ) &&
        !rejectsSocketHostMember(
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

/** These expressions have typeof "function", including a class constructor. */
const isFunctionValuedSyntax = (value: t.Node): boolean =>
  t.isFunctionExpression(value) ||
  t.isArrowFunctionExpression(value) ||
  t.isClassExpression(value);

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
  return rejectsPortValueNode(
    unwrapJavaScriptExpression(port).node,
    specifier,
    context,
  );
};

/**
 * Whether a port value is one Node rejects.
 *
 * This is the single reader for both the positional argument and the `port` member of an
 * options object, so a rule learned for one spelling cannot drift from the other.
 */
const rejectsPortValueNode = (
  value: t.Node,
  specifier: string,
  context: DataEffectTraversalContext,
): boolean => {
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
 * The value Node reads for one `net`/`tls` option member: a node, `undefined` when
 * the member is absent, or `"unknown"` when an accessor, a prototype write or a
 * dynamic copy could change it. `tls` merges its option arguments (see
 * `tlsOptionMerge`); `net` reads only an options object in argument 0. Returns
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
): ((member: string) => t.Node | "unknown" | undefined) | undefined => {
  let target: t.ObjectExpression | undefined;
  let source: t.Node | undefined;
  if (specifier === "tls") {
    const merge = tlsOptionMerge(node, state);
    if (merge === undefined || merge.target === "unknown") return undefined;
    target = merge.target === "fresh" ? undefined : merge.target;
    source = merge.source;
  } else if (specifier === "net") {
    const first = node.arguments[0];
    if (
      first === undefined ||
      node.arguments.some((argument) => t.isSpreadElement(argument))
    )
      return undefined;
    const options = unwrapJavaScriptExpression(first as t.Node).node;
    if (!t.isObjectExpression(options)) return undefined;
    target = options;
  } else return undefined;
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
  node: t.CallExpression | t.OptionalCallExpression,
  specifier: string,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (specifier !== "tls") return false;
  const effective = socketOptionReader(node, specifier, state);
  if (effective === undefined) return false;
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
  effective: (member: string) => t.Node | "unknown" | undefined,
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
  // A literal read exactly, including a no-substitution template, decides its own
  // truthiness; the shared truthiness reader does not price templates.
  const truthy = literal.found
    ? Boolean(literal.value)
    : staticJavaScriptTruthiness(read);
  if (truthy !== true) return false;
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

/**
 * Whether a `net`/`tls` call carries a `host` option Node rejects.
 *
 * Measured on Node 24.22.1: both connect through `options.host || "localhost"` and
 * throw `ERR_INVALID_ARG_TYPE` from the call when that is not a string, so a truthy
 * non-string host leaves no socket while a falsy one (`0`, `""`, `false`, `null`)
 * connects to localhost. A truthy `path` connects a pipe and a truthy TLS `socket`
 * skips the connect, so neither reads `host`, and an absent one may be inherited
 * from a patched `Object.prototype`. Anything not statically known keeps the
 * acquisition.
 */
const rejectsSocketHostMember = (
  node: t.CallExpression | t.OptionalCallExpression,
  specifier: string,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const effective = socketOptionReader(node, specifier, state);
  if (effective === undefined) return false;
  const falsy = (value: t.Node) =>
    isNullishPlaceholder(value, state) ||
    staticJavaScriptTruthiness(value) === false;
  // Node reads an absent member through the prototype chain, so a write to
  // Object.prototype that may run first can supply a path or socket.
  const inheritable = prototypeMutationMayPrecede(state, "Object", node);
  for (const member of specifier === "tls" ? ["path", "socket"] : ["path"]) {
    const value = effective(member);
    if (value === "unknown" || (value !== undefined && !falsy(value)))
      return false;
    if (value === undefined && inheritable) return false;
  }
  const host = effective("host");
  if (host === undefined || host === "unknown") return false;
  // Every statically truthy shape other than a string literal is a non-string.
  return (
    staticJavaScriptTruthiness(host) === true &&
    !t.isStringLiteral(unwrapJavaScriptExpression(host).node)
  );
};

/**
 * Whether an options object gives `net`/`tls` a port Node rejects.
 *
 * `net.connect` and `tls.connect` judge the same port value whether it arrives positionally
 * or as a member, but only the positional slot was read. Measured on Node 24.22.1:
 *
 * | call | outcome |
 * | --- | --- |
 * | `net.connect({port: -1})`, `{port: 70000}`, `{port: "x"}`, `{port: null}` | THREW `ERR_SOCKET_BAD_PORT` |
 * | `net.connect({port: 8080})`, `{port: "8080"}`, `{port: 0}` | socket created |
 * | `tls.connect({port: -1})` | THREW `ERR_SOCKET_BAD_PORT` |
 * | `net.connect({path: "/tmp/x.sock", port: -1})` | socket created — the path becomes the Unix socket |
 *
 * Two shapes stay undecided rather than guessed:
 *
 * - A later options object. `tls` merges slot 1 over slot 0, so the effective port can come
 *   from either: `tls.connect({port: -1}, {port: 443})` connects while
 *   `tls.connect({port: 443}, {port: -1})` throws. This reader does not model that merge.
 * - An accessor. A getter runs while Node copies the members and can write the port first:
 *   `net.connect({get side() { this.port = 80; }, port: -1})` connects.
 */
const rejectsSocketOptionsPort = (
  node: t.CallExpression | t.OptionalCallExpression,
  specifier: string,
  context: DataEffectTraversalContext,
): boolean => {
  const first = node.arguments[0];
  if (first === undefined || t.isSpreadElement(first)) return false;
  const options = unwrapJavaScriptExpression(first).node;
  if (!t.isObjectExpression(options)) return false;
  // Only `tls` merges a later object over this one; for `net` slot 1 is an optional listener,
  // so it cannot replace the port. Measured on Node 24.22.1, `net.connect({port: -1}, {})` and
  // `net.connect({port: -1}, () => {})` both throw ERR_SOCKET_BAD_PORT.
  // A getter runs while Node copies the members and can write the port first. A setter is
  // never invoked by an `Object.assign` over a plain source, so it decides nothing on its
  // own: measured on Node 24.22.1, `net.connect({set port(_) {}, port: -1})` throws
  // ERR_SOCKET_BAD_PORT.
  const accessorDecides = (value: t.ObjectExpression): boolean =>
    value.properties.some(
      (property) => t.isObjectMethod(property) && property.kind === "get",
    );
  // An inherited getter runs when Node reads a member through the prototype, and it can write
  // the port: measured on Node 24.22.1,
  // `net.connect({__proto__: {get timeout() { this.port = 80; return 0; }}, path: null,
  // port: -1})` connects. A literal that installs a prototype is undecided for that reason.
  if (accessorDecides(options) || installsPrototype(options)) return false;
  const second = node.arguments[1];
  // A spread can expand to the object `tls` merges over the first, so the port is
  // undecided rather than decided by the first object. Measured on Node 24.22.1,
  // `const args = [{ port: 443 }]; tls.connect({ port: -1 }, ...args)` connects.
  if (specifier === "tls" && second !== undefined && t.isSpreadElement(second))
    return false;
  // `tls` copies the third argument into the options when the second is not an object,
  // so it can carry the effective port: measured on Node 24.22.1,
  // `tls.connect({ port: -1 }, undefined, { port: 443 })` connects. That copy is not
  // modelled here, so its presence keeps the port undecided instead of pricing the
  // first object and removing a real acquisition.
  const third = node.arguments[2];
  const secondIsObject =
    second !== undefined &&
    !t.isSpreadElement(second) &&
    t.isObjectExpression(unwrapJavaScriptExpression(second).node);
  if (specifier === "tls" && third !== undefined && !secondIsObject) {
    // A function or `undefined` in slot 1 leaves slot 2 as the copied options; slot 1 being
    // an object already means slot 2 is the connect callback, which changes no member.
    if (t.isSpreadElement(third)) return false;
    const thirdValue = unwrapJavaScriptExpression(third).node;
    if (!isKnownNonObject(thirdValue, context)) return false;
  }
  if (
    specifier === "tls" &&
    second !== undefined &&
    !t.isSpreadElement(second)
  ) {
    const secondValue = unwrapJavaScriptExpression(second).node;
    // `tls` merges a non-null object and ignores everything else, including a known primitive.
    // Measured on Node 24.22.1, `tls.connect({port: -1}, 0)` and `tls.connect({port: -1}, "x")`
    // both throw `ERR_SOCKET_BAD_PORT`, and `tls.connect({port: 443}, 0)` connects.
    if (isKnownNonObject(secondValue, context)) {
      // Nothing is merged, so the first object decides below.
    } else if (
      !t.isObjectExpression(secondValue) &&
      !t.isArrowFunctionExpression(secondValue) &&
      !t.isFunctionExpression(secondValue) &&
      !isNullishJavaScriptSyntax(secondValue) &&
      !isUnmodifiedGlobalReference(secondValue, context.state, "undefined")
    )
      return false;
    if (
      t.isObjectExpression(secondValue) &&
      !isKnownNonObject(secondValue, context)
    ) {
      // The later object replaces a member it writes, so its own `port` is the effective
      // one. `Object.assign` reads that object in order, so a getter or an own `__proto__`
      // only rescues the port when it is copied first. Measured on Node 24.22.1:
      //
      //   tls.connect({}, {get side() { this.port = 80; }, port: -1})                 -> connects
      //   tls.connect({}, {port: -1, get side() { this.port = 80; }})                 -> THREW
      //   tls.connect({}, {["__proto__"]: {set port(_) { this.path = "/tmp/x"; }}, port: -1}) -> connects
      //   tls.connect({}, {port: -1, ["__proto__"]: {set port(_) { this.path = "/tmp/x"; }}}) -> THREW
      const writerPrecedesPort = optionWriterPrecedesMember(
        secondValue,
        "port",
      );
      if (writerPrecedesPort) return false;
      const sourcePort = staticObjectProperty(
        secondValue,
        "port",
        isNullishJavaScriptSyntax,
      );
      // An empty override writes nothing, so argument 0 still decides: measured on Node
      // 24.22.1, `tls.connect({port: -1}, {})` throws `ERR_SOCKET_BAD_PORT`. A missing member is
      // therefore not the same as an unreadable one.
      if (sourcePort.status === "explicit")
        return rejectsPortMember(
          unwrapJavaScriptExpression(sourcePort.value).node,
          specifier,
          context,
        );
      // A member this reader cannot price may hold any port, so the merge stays open.
      if (sourcePort.status !== "missing") return false;
    }
  }
  // A path that is present and not provably empty selects the Unix socket, and the port is
  // never read. A path this reader cannot price may be a real one, so it stays undecided.
  const pathMember = staticObjectProperty(
    options,
    "path",
    isNullishJavaScriptSyntax,
  );
  if (pathMember.status === "explicit") {
    const written = unwrapJavaScriptExpression(pathMember.value).node;
    const empty =
      isNullishJavaScriptSyntax(written) ||
      (t.isStringLiteral(written) && written.value.length === 0) ||
      (t.isTemplateLiteral(written) &&
        written.expressions.length === 0 &&
        (written.quasis[0]?.value.cooked ?? "").length === 0) ||
      (t.isBooleanLiteral(written) && !written.value) ||
      (t.isNumericLiteral(written) && written.value === 0);
    if (!empty) return false;
  } else if (pathMember.status !== "missing") return false;
  const portMember = staticObjectProperty(
    options,
    "port",
    isNullishJavaScriptSyntax,
  );
  if (portMember.status !== "explicit") return false;
  return rejectsPortMember(
    unwrapJavaScriptExpression(portMember.value).node,
    specifier,
    context,
  );
};

/**
 * Whether a string reads as a port Node accepts.
 *
 * A string in the positional slot is a pipe/Unix path, so only an empty one fails there. The
 * `port` member is different: Node coerces it with `Number`, so `"8080"` connects while `"x"`
 * throws `ERR_SOCKET_BAD_PORT`. Measured on Node 24.22.1.
 */
const usablePortText = (text: string): boolean => {
  if (text.trim().length === 0) return false;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 && value <= 65535;
};

/**
 * Whether a value written as a `port` member is one Node rejects.
 *
 * The member spelling differs from the positional one in three ways, so it cannot reuse
 * `rejectsPortValueNode` alone:
 *
 * - Node coerces a string with `Number`, so `"8080"` connects while `"x"` throws
 *   `ERR_SOCKET_BAD_PORT`.
 * - A known non-scalar value is a type error rather than a range failure:
 *   `{port: {}}` and `{port: []}` throw `ERR_INVALID_ARG_TYPE`.
 *
 * Measured on Node 24.22.1.
 */
const rejectsPortMember = (
  written: t.Node,
  specifier: string,
  context: DataEffectTraversalContext,
): boolean => {
  if (t.isStringLiteral(written)) return !usablePortText(written.value);
  if (t.isTemplateLiteral(written) && written.expressions.length === 0) {
    const cooked = written.quasis[0]?.value.cooked;
    return cooked === null || cooked === undefined
      ? false
      : !usablePortText(cooked);
  }
  // A unary operator over a BigInt or over `undefined` is still not a port. Measured on Node
  // 24.22.1, `net.connect({port: -1n})` and `net.connect({port: ~1n})` throw
  // ERR_INVALID_ARG_TYPE, and `net.connect({port: +undefined})` throws ERR_SOCKET_BAD_PORT.
  if (
    t.isUnaryExpression(written) &&
    (t.isBigIntLiteral(unwrapJavaScriptExpression(written.argument).node) ||
      isUnmodifiedGlobalReference(
        unwrapJavaScriptExpression(written.argument).node,
        context.state,
        "undefined",
      ))
  )
    return true;
  if (rejectsNonScalarPort(written)) return true;
  // A nullish member leaves Node without a port, which it reports rather than ignoring.
  // Measured on Node 24.22.1, `tls.connect({port: undefined})` and `net.connect({port: null})`
  // both throw. The exemption in `rejectsPortValueNode` covers the positional slot, where a
  // nullish value means "not given" and Node falls back to its default.
  if (
    isNullishJavaScriptSyntax(written) ||
    isUnmodifiedGlobalReference(written, context.state, "undefined")
  )
    return true;
  return rejectsPortValueNode(written, specifier, context);
};

/**
 * Whether a getter or a copied `__proto__` is read before the effective `port` write.
 *
 * `Object.assign` walks the source by `OwnPropertyKeys`, not by source order: an array-index key
 * comes first, ascending, and the string keys follow in insertion order. A getter only rescues the
 * port when it runs before that write. Measured on Node 24.22.1:
 *
 *   {get side() { this.port = 80; }, port: -1}                       -> connects
 *   {port: -1, get side() { this.port = 80; }}                       -> THREW
 *   {port: -1, get 0() { this.port = 80; }}                          -> connects
 *   {["__proto__"]: {set port(_) {...}}, port: -1}                    -> connects
 *   {port: -1, ["__proto__"]: {set port(_) {...}}}                    -> THREW
 *   {...{get side() { this.port = 80; }}, port: -1}                  -> THREW
 *
 * A spread is evaluated when the literal is built, so its getters have already run and left plain
 * data properties — they are not writers here. A later data property replaces the descriptor, so a
 * key written as data is no longer a getter.
 */
const optionWriterPrecedesMember = (
  options: t.ObjectExpression,
  member: string,
): boolean => {
  const firstInsertion = new Map<string, number>();
  const lastDescriptor = new Map<
    string,
    { readonly node: t.ObjectProperty | t.ObjectMethod }
  >();
  let position = 0;
  // A getter whose key is not statically known can land anywhere in `OwnPropertyKeys`,
  // so it may precede the member: `const key = 0; {get [key]() { this.port = 80 }, port: -1}`
  // visits `"0"` first and connects.
  let unknownWriter = false;
  const copiedPrototypeKeys = new Set<string>();
  const evaluatedAccessors = new Set<t.Node>();
  for (const property of options.properties) {
    // A spread contributes data properties: its own accessors already ran.
    const spread = t.isSpreadElement(property)
      ? spreadDataEntries(property, evaluatedAccessors)
      : {
          entries: [property] as readonly (t.ObjectProperty | t.ObjectMethod)[],
          copiesPrototypeAccessor: false,
        };
    for (const entry of spread.entries) {
      const name = semanticStaticPropertyKey(entry.key, entry.computed);
      if (name === null) {
        // The key is not statically known, so it may be `__proto__`, and a value that is not
        // a primitive then installs a setter-bearing prototype before `port` is read.
        // Measured on Node 24.22.1,
        // `const key = "__proto__"; tls.connect({}, {[key]: {set port(_) {…}}, port: -1})`
        // connects, while `{ [key]: 5, port: -1 }` throws.
        const writesPrototype =
          t.isObjectProperty(entry) &&
          entry.computed &&
          primitiveOwnKeys(
            unwrapJavaScriptExpression(entry.value).node,
            isNullishJavaScriptSyntax,
          ) === null;
        if (
          (t.isObjectMethod(entry) && entry.kind === "get") ||
          writesPrototype
        )
          unknownWriter = true;
        continue;
      }
      if (spread.copiesPrototypeAccessor && name === "__proto__")
        copiedPrototypeKeys.add(name);
      if (!firstInsertion.has(name)) firstInsertion.set(name, position);
      lastDescriptor.set(name, { node: entry });
      position += 1;
    }
  }
  const orderOf = (name: string): readonly [number, number] => {
    const key = Number(name);
    const isArrayIndex =
      Number.isInteger(key) &&
      String(key) === name &&
      key >= 0 &&
      key < 2 ** 32 - 1;
    return isArrayIndex
      ? [0, key]
      : [1, firstInsertion.get(name) ?? Number.MAX_SAFE_INTEGER];
  };
  const before = (
    left: readonly [number, number],
    right: readonly [number, number],
  ): boolean =>
    left[0] !== right[0] ? left[0] < right[0] : left[1] < right[1];
  let writerOrder: readonly [number, number] | undefined;
  let memberOrder: readonly [number, number] | undefined;
  for (const [name, { node }] of lastDescriptor) {
    const order = orderOf(name);
    const writesThroughPrototype =
      name === "__proto__" &&
      (copiedPrototypeKeys.has(name) ||
        (t.isObjectProperty(node) && node.shorthand) ||
        node.computed);
    if (
      (t.isObjectMethod(node) &&
        node.kind === "get" &&
        !evaluatedAccessors.has(node)) ||
      writesThroughPrototype
    ) {
      if (writerOrder === undefined || before(order, writerOrder))
        writerOrder = order;
    }
    if (name === member) memberOrder = order;
  }
  if (unknownWriter) return true;
  return (
    writerOrder !== undefined &&
    (memberOrder === undefined || before(writerOrder, memberOrder))
  );
};

/**
 * The data entries a spread contributes, plus the `__proto__` accessors it copies.
 *
 * A spread reads its source's own keys and creates data properties on the result, so the
 * source's accessors have already run. A `__proto__` accessor is the exception the caller
 * needs to know about: the copy is an own data key named `__proto__`, which sets the merge
 * target's prototype when it is written there.
 */
const spreadDataEntries = (
  property: t.SpreadElement,
  evaluatedAccessors: Set<t.Node>,
): {
  readonly entries: readonly (t.ObjectProperty | t.ObjectMethod)[];
  readonly copiesPrototypeAccessor: boolean;
} => {
  const spread = unwrapJavaScriptExpression(property.argument).node;
  if (!t.isObjectExpression(spread))
    return { entries: [], copiesPrototypeAccessor: false };
  let copiesPrototypeAccessor = false;
  const entries = spread.properties.filter(
    (entry): entry is t.ObjectProperty | t.ObjectMethod => {
      if (t.isSpreadElement(entry)) return false;
      // Every own key of the source is copied, so an accessor keeps its insertion position as
      // a data key: redefining that name later as a getter then stays where the spread put it.
      // Measured on Node 24.22.1,
      // `{...{get side() { return 0; }}, port: -1, get side() { this.port = 80; }}` connects.
      if (t.isObjectMethod(entry) && entry.kind !== "method") {
        // The spread already ran this accessor, so the copied value is data. It keeps its
        // position but is not a writer at the merge target.
        evaluatedAccessors.add(entry);
        if (
          semanticStaticPropertyKey(entry.key, entry.computed) === "__proto__"
        )
          copiesPrototypeAccessor = true;
      }
      return true;
    },
  );
  return { entries, copiesPrototypeAccessor };
};

/** Whether an object literal copies an own `__proto__` key rather than setting its own prototype. */
const copiesPrototypeKey = (options: t.ObjectExpression): boolean =>
  options.properties.some(
    (property) =>
      !t.isSpreadElement(property) &&
      // A shorthand `{__proto__}` copies a variable as an own enumerable key, so it counts like
      // the computed spelling. Measured on Node 24.22.1,
      // `const __proto__ = {set port(_) { this.path = "/tmp/x"; }}; tls.connect({}, {...{__proto__}, port: -1})`
      // connects while `{...{__proto__: {...}}}` throws.
      (property.computed ||
        (t.isObjectProperty(property) && property.shorthand)) &&
      semanticStaticPropertyKey(property.key, property.computed) ===
        "__proto__",
  );

/** Whether a value is a literal that `tls` provably does not merge. */
const isKnownNonObject = (
  value: t.Node,
  context: DataEffectTraversalContext,
): boolean =>
  // Only scalars. An object literal is exactly what `tls` merges, so it must not land here.
  t.isNumericLiteral(value) ||
  t.isStringLiteral(value) ||
  t.isBooleanLiteral(value) ||
  t.isBigIntLiteral(value) ||
  t.isNullLiteral(value) ||
  (t.isTemplateLiteral(value) && value.expressions.length === 0) ||
  isUnmodifiedGlobalReference(value, context.state, "undefined");

/**
 * Whether copying this object onto a merge target replaces the target's prototype.
 *
 * An own `__proto__` key is read by `Object.assign` as a normal key, but assigning it to the
 * target runs the prototype accessor, so the target's prototype becomes this value and its
 * setters fire for every remaining key.
 *
 * A spread produces the same own key as the direct spelling. Measured on Node 24.22.1,
 * `tls.connect({}, {...{["__proto__"]: {set port(_) { this.path = "/tmp/x"; }}}, port: -1})`
 * connects while `tls.connect({}, {...{}, port: -1})` throws `ERR_SOCKET_BAD_PORT`.
 */
const installsPrototype = (options: t.ObjectExpression): boolean =>
  options.properties.some((property) => {
    if (t.isSpreadElement(property)) {
      const spread = unwrapJavaScriptExpression(property.argument).node;
      // Inside a spread source only the computed spelling is an own key. Measured on Node
      // 24.22.1, `{...{__proto__: {set port(_) { this.path = "/tmp/x"; }}}}` copies nothing and
      // `tls.connect({}, {...}, port: -1)` throws `ERR_SOCKET_BAD_PORT`, while the computed
      // `["__proto__"]` spelling does install the prototype.
      return t.isObjectExpression(spread) && copiesPrototypeKey(spread);
    }
    return (
      semanticStaticPropertyKey(property.key, property.computed) === "__proto__"
    );
  });

/**
 * Whether a known non-number, non-string port member is a type error.
 *
 * Measured on Node 24.22.1, `net.connect({port: {}})` and `net.connect({port: []})` throw
 * `ERR_INVALID_ARG_TYPE` rather than reaching the port range check.
 */
const rejectsNonScalarPort = (value: t.Node): boolean =>
  t.isObjectExpression(value) ||
  t.isArrayExpression(value) ||
  t.isRegExpLiteral(value) ||
  t.isArrowFunctionExpression(value) ||
  t.isFunctionExpression(value) ||
  t.isClassExpression(value) ||
  t.isUnaryExpression(value, { operator: "!" }) ||
  t.isUnaryExpression(value, { operator: "typeof" });
/** Only `net`/`tls` sockets take a port in argument 0. */
const socketPortInFirstArgument = (
  candidate: Pick<AcquisitionReference, "specifier">,
): boolean => candidate.specifier === "net" || candidate.specifier === "tls";
