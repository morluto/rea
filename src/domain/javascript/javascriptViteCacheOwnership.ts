import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  semanticWriteTargetsSteps,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
  type JavaScriptIntrinsicInvocation,
} from "./javascriptElectronMemberWrites.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { isUnmodifiedGlobalReference } from "./javascriptSemanticAmbientWrites.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import { traverseJavaScriptValueAstSteps } from "./javascriptSemanticTraversal.js";
import { semanticArrayIndex } from "./javascriptSemanticPropertyPaths.js";
import {
  createViteCacheReadProofSteps,
  type ViteCacheReadProof,
} from "./javascriptViteCacheReads.js";
import { ViteCacheIdentities } from "./javascriptViteCacheIdentities.js";
import type {
  ViteCacheAllocation,
  ViteCacheIdentity,
  ViteCacheWrite,
  ViteCacheExposure as CacheExposure,
  ViteCacheValue,
} from "./javascriptViteCacheIdentityTypes.js";
import { readViteCacheDataDescriptorSteps } from "./javascriptViteCacheProperties.js";
import {
  hasJavaScriptViteInheritedProperty,
  type JavaScriptViteCacheTable,
  type JavaScriptViteHelperCandidate,
} from "./javascriptViteHelper.js";
import { collectSemanticEsmExport } from "./javascriptSemanticProjection.js";

type CachePath = readonly (string | null)[];
type Call = t.CallExpression | t.OptionalCallExpression;

const ARRAY_MUTATORS = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);

const identityPaths = (
  identity: ViteCacheIdentity | undefined,
): readonly CachePath[] => {
  if (identity === undefined) return [];
  const paths: CachePath[] =
    identity.inheritedArrayPrototype === true
      ? [["inherited-array-prototype", null]]
      : [];
  if (identity.owner === undefined) return paths;
  const allocation = identity.allocation;
  if (allocation?.kind === "container" || allocation?.kind === "foreign")
    return paths;
  paths.push([
    allocation?.kind ?? "unknown",
    allocation?.kind === "helper" ? (allocation.owner ?? null) : identity.owner,
  ]);
  return paths;
};

const numericSlot = (key: string | null | undefined): boolean =>
  key === null ||
  key === undefined ||
  key === "length" ||
  semanticArrayIndex(key) !== null;

const arrayInvocation = (
  invocation: JavaScriptIntrinsicInvocation | undefined,
): boolean =>
  invocation?.path.length === 4 &&
  invocation.path.slice(0, 3).join(".") === "intrinsic.Array.prototype";

/** invalidate admitted Vite caches through shared identity and mutation owners. */
export function* invalidateJavaScriptViteCachesSteps(
  program: t.Program,
  tables: Map<string, JavaScriptViteCacheTable | null>,
  cacheHelpers: ReadonlyMap<string, JavaScriptViteHelperCandidate>,
  initializations: ReadonlySet<t.Node | undefined>,
  admittedNodes: WeakSet<t.Node>,
  state: JavaScriptSemanticAnalysisState,
): Generator<void> {
  const interop = createSemanticModuleInterop(state);
  const identities = new ViteCacheIdentities(
    state,
    interop.intrinsicInvocation,
  );
  const uncertainPrototypes = yield* collectIntrinsicWritesSteps(
    program,
    interop,
    state,
  );
  const objectPrototypeUncertain = uncertainPrototypes.has("Object");
  const { writes, calls, exposures } = yield* indexCacheEffectsSteps(
    program,
    identities,
    initializations,
    admittedNodes,
    state,
  );
  const reads = yield* createViteCacheReadProofSteps(tables, state, (node) =>
    identities.read(node),
  );
  const dataDefinitions = yield* retainObjectWritesSteps(calls, writes, {
    interop,
    objectPrototypeUncertain,
  });
  const context: CacheEffectContext = {
    state,
    identities,
    interop,
    reads,
    objectPrototypeUncertain,
    uncertainPrototypes,
    dataDefinitions,
    admittedNodes: admittedNodes,
    unsafeTargets: new Set(),
  };
  yield* identities.initializeSteps(cacheHelpers);
  yield* identities.solveSteps();
  context.unsafeTargets = yield* unsafeAssignmentTargetsSteps(
    { calls, exposures, writes },
    context,
  );
  const escapes = [
    ...exposures,
    ...(yield* indexCallExposuresSteps(calls, context)),
  ];
  let examined = 0;
  yield* identities.retainSnapshotsSteps(writes, escapes);
  yield* identities.solveSteps();
  let allOwners = false;
  const invalidate = (owner: string | null | undefined): void => {
    if (
      owner === null ||
      (owner !== undefined && identities.ambiguousCacheFamily)
    )
      allOwners = true;
    else if (owner !== undefined && tables.has(owner)) tables.set(owner, null);
  };
  const retain = (node: t.Node, path: CachePath): void => {
    if (initializations.has(node)) return;
    const [kind, owner, key] = path;
    reads.recordWrite(path);
    if (kind === "inherited-array-prototype") {
      // Shared prototype writes may alter every admitted table's lookup or map.
      if (
        key === "map" ||
        key === "constructor" ||
        key === "prototype" ||
        key === "__proto__" ||
        numericSlot(key)
      )
        invalidate(null);
      return;
    }
    if (kind === "helper" && path.length > 2 && key !== "f" && key !== null)
      return;
    if (kind === "cache" && !numericSlot(key)) return;
    invalidate(owner);
  };
  for (const escape of escapes) {
    if (examined++ % 1024 === 0) yield;
    {
      const identity = identities.read(escape.value);
      invalidate(identity?.owner);
      if (
        identity?.inheritedArrayPrototype === true ||
        (identity?.intrinsicPrototype === true &&
          !(yield* localPrototypeOperationSteps(escape, context)))
      )
        invalidate(null);
    }
  }
  yield* retainImplicitReceiverEffectsSteps(program, context, invalidate);
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    state.erasedSyntaxNodes,
    (node, kind) =>
      kind === "member" ? identityPaths(identities.read(node)) : [],
    interop.intrinsicInvocation,
    interop.staticString,
    interop.isFreshObject,
    retain,
  );
  for (const call of calls) {
    if (examined++ % 1024 === 0) yield;
    yield* retainCallEffectsSteps(call, context, invalidate);
  }
  for (const write of writes) {
    if (examined++ % 1024 === 0) yield;
    const receiver = identities.read(write.receiver);
    // storing a cache in an unresolved receiver exposes it to unexamined code.
    if (
      write.value !== undefined &&
      receiver?.allocation?.kind !== "container" &&
      receiver?.allocation?.kind !== "cache" &&
      receiver?.allocation?.kind !== "helper"
    ) {
      const identity = identities.read(write.value);
      invalidate(identity?.owner);
      const selfAssignment =
        receiver?.inheritedArrayPrototype === true &&
        receiver.owner === undefined &&
        t.isIdentifier(write.receiver) &&
        t.isIdentifier(write.value) &&
        write.receiver.name === write.value.name &&
        write.key !== null &&
        !hasJavaScriptViteInheritedProperty(write.key, state);
      if (
        identity?.inheritedArrayPrototype === true ||
        identity?.intrinsicPrototype === true
      )
        if (!selfAssignment) invalidate(null);
    }
  }
  if (
    state.ambientWrites.covers(["global", "Function", "prototype", "f"]) ||
    state.ambientWrites.covers(["global", "Object", "prototype", "f"])
  )
    allOwners = true;
  if (allOwners)
    for (const owner of tables.keys()) {
      if (examined++ % 1024 === 0) yield;
      tables.set(owner, null);
    }
}

type Interop = ReturnType<typeof createSemanticModuleInterop>;

/** retain value exposure separately from known receiver mutation semantics. */
/** These intrinsic operations do not expose a proven ordinary receiver. */
function* localPrototypeOperationSteps(
  escape: CacheExposure,
  context: CacheEffectContext,
): Generator<void, boolean> {
  const node = escape.node;
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
    return false;
  const invocation = context.interop.intrinsicInvocation(node);
  if (invocation?.kind !== "known") return false;
  const path = invocation.path.join(".");
  const directTarget = invocation.arguments?.[0];
  if (
    [
      "intrinsic.Object.defineProperty",
      "intrinsic.Reflect.defineProperty",
    ].includes(path) &&
    directTarget === escape.value &&
    t.isMemberExpression(directTarget) &&
    t.isIdentifier(directTarget.object) &&
    ["Array", "Object"].includes(directTarget.object.name) &&
    semanticStaticPropertyKey(directTarget.property, directTarget.computed) ===
      "prototype" &&
    isUnmodifiedGlobalReference(
      directTarget.object,
      context.state,
      directTarget.object.name,
    )
  ) {
    const key = invocation.arguments?.[1];
    const descriptor = invocation.arguments?.[2];
    return (
      !context.objectPrototypeUncertain &&
      key !== undefined &&
      context.interop.staticString(key) !== undefined &&
      t.isObjectExpression(descriptor) &&
      (yield* ordinaryObjectLiteralSteps(descriptor))
    );
  }
  if (
    ![
      "intrinsic.Object.getPrototypeOf",
      "intrinsic.Reflect.getPrototypeOf",
      "intrinsic.Object.setPrototypeOf",
      "intrinsic.Reflect.setPrototypeOf",
    ].includes(path)
  )
    return false;
  const target = invocation.arguments?.[0];
  return (
    target !== undefined &&
    !t.isSpreadElement(target) &&
    context.identities.read(target)?.allocation?.kind === "container"
  );
}

function* indexCallExposuresSteps(
  calls: readonly Call[],
  context: CacheEffectContext,
): Generator<void, CacheExposure[]> {
  const exposures: CacheExposure[] = [];
  let examined = 0;
  for (const call of calls) {
    if (examined++ % 1024 === 0) yield;
    const invocation = context.interop.intrinsicInvocation(call);
    const path =
      invocation?.kind === "known" ? invocation.path.join(".") : undefined;
    if (
      (context.dataDefinitions.has(call) ||
        (path === "intrinsic.Object.assign" &&
          (yield* dataOnlyAssignSourcesSteps(
            invocation?.arguments,
            context,
          )))) &&
      (yield* freshAssignDestinationSteps(invocation?.arguments?.[0], context))
    )
      continue;
    const values =
      invocation?.kind === "known"
        ? (invocation.arguments ?? call.arguments)
        : call.arguments;
    if (invocation?.receiver !== undefined && !arrayInvocation(invocation))
      exposures.push({ node: call, value: invocation.receiver });
    // A known callable does not prove argument positions when a spread can
    // supply several slots, including both a destination and a cache source.
    let positionsKnown = invocation?.arguments !== undefined;
    if (positionsKnown)
      for (const value of values) {
        if (examined++ % 1024 === 0) yield;
        if (t.isSpreadElement(value)) {
          positionsKnown = false;
          break;
        }
      }
    // An unproven descriptor can install accessors whose receiver effects are
    // invisible to the property-write collector (including named metadata).
    const selected =
      !positionsKnown ||
      (!context.dataDefinitions.has(call) &&
        (path === "intrinsic.Object.defineProperty" ||
          path === "intrinsic.Reflect.defineProperty" ||
          path === "intrinsic.Object.defineProperties"))
        ? undefined
        : intrinsicValuePositions(path);
    // An admitted helper reads its proven parameters by value. Supplied table
    // and mapper arguments must not register as ordinary call escapes.
    const readOnly = new Set(
      yield* context.identities.readOnlyHelperArgumentsSteps(call),
    );
    // unproven mapped reads can dispatch getters on the selected table.
    // retain that receiver so its effects also invalidate other helper calls.
    const mappedTable =
      yield* context.identities.helperMappedTableEscapeSteps(call);
    if (mappedTable !== undefined)
      exposures.push({ node: call, value: mappedTable });
    for (let index = 0; index < values.length; index++) {
      if (examined++ % 1024 === 0) yield;
      if (selected !== undefined && !selected.has(index)) continue;
      if (
        positionsKnown &&
        index === 0 &&
        (path === "intrinsic.Object.assign" ||
          path === "intrinsic.Object.create")
      )
        continue;
      const value = values[index];
      if (
        value !== undefined &&
        readOnly.has(t.isSpreadElement(value) ? value.argument : value)
      )
        continue;
      if (
        path === "intrinsic.Object.assign" &&
        value !== undefined &&
        context.identities.read(
          t.isSpreadElement(value) ? value.argument : value,
        )?.owner === undefined
      )
        continue;
      if (value !== undefined)
        exposures.push({
          node: call,
          value: t.isSpreadElement(value) ? value.argument : value,
        });
    }
  }
  return exposures;
}

function* dataOnlyAssignSourcesSteps(
  values: JavaScriptIntrinsicInvocation["arguments"],
  context: CacheEffectContext,
): Generator<void, boolean> {
  if (values === undefined || context.objectPrototypeUncertain) return false;
  let examined = 0;
  for (let index = 1; index < values.length; index++) {
    if (examined++ % 1024 === 0) yield;
    const source = values[index];
    if (source === undefined || t.isSpreadElement(source)) return false;
    const allocation = context.identities.read(source)?.allocation;
    if (allocation === null || allocation === undefined) return false;
    if (context.unsafeTargets.has(allocation)) return false;
    if (allocation.kind === "helper" || allocation.kind === "cache") continue;
    if (
      allocation.kind !== "container" ||
      !t.isObjectExpression(allocation.node) ||
      !(yield* ordinaryObjectLiteralSteps(allocation.node))
    )
      return false;
  }
  return true;
}

/** a proven data-only literal allocation cannot dispatch to an unexamined setter. */
function* freshAssignDestinationSteps(
  target: t.Node | undefined,
  context: CacheEffectContext,
): Generator<void, boolean> {
  if (
    context.objectPrototypeUncertain ||
    target === undefined ||
    t.isSpreadElement(target)
  )
    return false;
  const allocation = context.identities.read(target)?.allocation;
  if (
    allocation?.kind !== "container" ||
    context.unsafeTargets.has(allocation) ||
    !t.isObjectExpression(allocation.node)
  )
    return false;
  return yield* ordinaryObjectLiteralSteps(allocation.node);
}

function* ordinaryObjectLiteralSteps(
  expression: t.ObjectExpression,
): Generator<void, boolean> {
  let examined = 0;
  for (const property of expression.properties) {
    if (examined++ % 1024 === 0) yield;
    if (
      !t.isObjectProperty(property) &&
      !(t.isObjectMethod(property) && property.kind === "method")
    )
      return false;
    const key = semanticStaticPropertyKey(property.key, property.computed);
    if (key === null || key === "__proto__") return false;
  }
  return true;
}

function* unsafeAssignmentTargetsSteps(
  events: {
    readonly calls: readonly Call[];
    readonly exposures: readonly CacheExposure[];
    readonly writes: readonly ViteCacheWrite[];
  },
  context: CacheEffectContext,
): Generator<void, ReadonlySet<ViteCacheAllocation>> {
  const inputs: ViteCacheValue[] = [];
  let examined = 0;
  for (const write of events.writes) {
    if (examined++ % 1024 === 0) yield;
    if (
      write.propertySource === undefined &&
      (write.key === null || write.key === "__proto__")
    )
      inputs.push(write.receiver);
  }
  for (const call of events.calls) {
    if (examined++ % 1024 === 0) yield;
    const invocation = context.interop.intrinsicInvocation(call);
    const path =
      invocation?.kind === "known" ? invocation.path.join(".") : undefined;
    if (
      path === "intrinsic.Object.assign" ||
      path === "intrinsic.Object.create" ||
      path === "intrinsic.Object.freeze" ||
      path === "intrinsic.Object.seal" ||
      path === "intrinsic.Object.preventExtensions" ||
      context.dataDefinitions.has(call) ||
      context.identities.read(call.callee)?.allocation?.kind === "helper"
    )
      continue;
    for (const argument of invocation?.arguments ?? call.arguments) {
      if (examined++ % 1024 === 0) yield;
      inputs.push(t.isSpreadElement(argument) ? argument.argument : argument);
    }
    const direct = directArrayMethod(call);
    if (direct !== undefined && invocation === undefined)
      inputs.push(direct.receiver);
  }
  for (const exposure of events.exposures) {
    if (examined++ % 1024 === 0) yield;
    inputs.push(exposure.value);
  }
  return yield* context.identities.escapedAllocationsSteps(inputs);
}

const intrinsicValuePositions = (
  path: string | undefined,
): ReadonlySet<number> | undefined => {
  if (path === "intrinsic.Reflect.deleteProperty") return new Set([1]);
  if (path === "intrinsic.Reflect.set") return new Set([0, 1, 2, 3]);
  if (
    path === "intrinsic.Reflect.set" ||
    path === "intrinsic.Object.defineProperty" ||
    path === "intrinsic.Reflect.defineProperty"
  )
    return new Set([1, 2]);
  if (
    path === "intrinsic.Object.defineProperties" ||
    path === "intrinsic.Object.setPrototypeOf" ||
    path === "intrinsic.Reflect.setPrototypeOf"
  )
    return new Set([1]);
  if (
    path === "intrinsic.Object.freeze" ||
    path === "intrinsic.Object.seal" ||
    path === "intrinsic.Object.preventExtensions"
  )
    return new Set();
  return undefined;
};

/** normalize supported object writes once while preserving their target identity. */
function* retainObjectWritesSteps(
  calls: readonly Call[],
  writes: ViteCacheWrite[],
  context: {
    readonly interop: Interop;
    readonly objectPrototypeUncertain: boolean;
  },
): Generator<void, ReadonlySet<Call>> {
  const { interop } = context;
  const dataDefinitions = new Set<Call>();
  let examined = 0;
  for (const call of calls) {
    if (examined++ % 1024 === 0) yield;
    const invocation = interop.intrinsicInvocation(call);
    if (invocation?.kind !== "known") continue;
    const path = invocation.path.join(".");
    if (
      path === "intrinsic.Object.setPrototypeOf" ||
      path === "intrinsic.Reflect.setPrototypeOf"
    ) {
      const target = invocation.arguments?.[0];
      const value = invocation.arguments?.[1];
      if (t.isExpression(target))
        writes.push({
          node: call,
          receiver: target,
          key: "__proto__",
          ...(t.isExpression(value) ? { value } : {}),
        });
      continue;
    }
    if (
      path === "intrinsic.Object.defineProperty" ||
      path === "intrinsic.Reflect.defineProperty"
    ) {
      const target = invocation.arguments?.[0];
      const key = interop.staticString(invocation.arguments?.[1]);
      const descriptor = context.objectPrototypeUncertain
        ? undefined
        : yield* readViteCacheDataDescriptorSteps(invocation.arguments?.[2]);
      if (
        t.isExpression(target) &&
        key !== undefined &&
        descriptor?.value !== undefined
      ) {
        writes.push({
          node: call,
          receiver: target,
          key,
          value: descriptor.value,
          enumerable: descriptor.enumerable,
        });
        dataDefinitions.add(call);
      }
      continue;
    }
    if (path !== "intrinsic.Object.assign") continue;
    const target = invocation.arguments?.[0];
    if (!t.isExpression(target)) continue;
    const properties: t.SpreadElement[] = [];
    for (const source of invocation.arguments?.slice(1) ?? []) {
      if (examined++ % 1024 === 0) yield;
      properties.push(
        t.spreadElement(
          t.isSpreadElement(source)
            ? source.argument
            : t.isExpression(source)
              ? source
              : t.identifier("undefined"),
        ),
      );
    }
    const value = t.objectExpression(properties);
    writes.push({
      node: call,
      receiver: target,
      key: null,
      value,
      propertySource: value,
    });
  }
  return dataDefinitions;
}

interface CacheEffectContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly identities: ViteCacheIdentities;
  readonly interop: Interop;
  readonly reads: ViteCacheReadProof;
  readonly objectPrototypeUncertain: boolean;
  readonly uncertainPrototypes: ReadonlySet<string>;
  readonly dataDefinitions: ReadonlySet<Call>;
  readonly admittedNodes: WeakSet<t.Node>;
  unsafeTargets: ReadonlySet<ViteCacheAllocation>;
}

function* indexCacheEffectsSteps(
  program: t.Program,
  identities: ViteCacheIdentities,
  initializations: ReadonlySet<t.Node | undefined>,
  admittedNodes: WeakSet<t.Node>,
  state: JavaScriptSemanticAnalysisState,
): Generator<
  void,
  {
    writes: ViteCacheWrite[];
    calls: Call[];
    exposures: CacheExposure[];
  }
> {
  const writes: ViteCacheWrite[] = [];
  const calls: Call[] = [];
  const exposures: CacheExposure[] = [];
  // The identity graph owns the validated map projection's selected values.
  // Default table expressions and their nested functions still expose effects.
  type DeferredEffect =
    | {
        readonly kind: "values";
        readonly node: t.Node;
        readonly values: readonly t.Node[];
      }
    | { readonly kind: "default"; readonly node: t.AssignmentPattern }
    | {
        readonly kind: "write";
        readonly node: t.Node;
        readonly target: t.Node;
        readonly exposed: boolean;
      };
  const deferred: DeferredEffect[] = [];
  let admittedDepth = 0;
  const expose = (node: t.Node, value: ViteCacheValue): void => {
    if (admittedDepth === 0) exposures.push({ node, value });
  };
  yield* traverseJavaScriptValueAstSteps(program, state.erasedSyntaxNodes, {
    enter: (node, parent) => {
      collectSemanticEsmExport(node, state);
      if (admittedNodes.has(node)) admittedDepth++;
      if (t.isExpression(node)) identities.normalize(node);
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
        calls.push(node);
      if (admittedDepth === 0) {
        if (t.isNewExpression(node))
          deferred.push({ kind: "values", node, values: node.arguments });
        if (t.isTaggedTemplateExpression(node)) {
          const tag = unwrapJavaScriptExpression(node.tag).node;
          if (t.isMemberExpression(tag) || t.isOptionalMemberExpression(tag))
            expose(node, tag.object);
          deferred.push({
            kind: "values",
            node,
            values: node.quasi.expressions,
          });
        }
        if (t.isTemplateLiteral(node) && !t.isTaggedTemplateExpression(parent))
          deferred.push({ kind: "values", node, values: node.expressions });
        if (t.isAssignmentPattern(node))
          deferred.push({ kind: "default", node });
      }
      // These operations can invoke user-defined coercion or thenable hooks.
      if (t.isAwaitExpression(node)) expose(node, node.argument);
      if (t.isForOfStatement(node) && node.await)
        expose(node, identities.containedValues(node.right));
      if (
        t.isVariableDeclarator(node) &&
        node.init != null &&
        t.isVariableDeclaration(parent) &&
        (parent.kind === "using" || parent.kind === "await using")
      )
        expose(node, node.init);
      if (t.isImportExpression(node)) {
        expose(node, node.source);
        if (node.options != null) expose(node, node.options);
      }
      if (t.isThrowStatement(node) && node.argument != null)
        expose(node, node.argument);
      if (t.isUnaryExpression(node) && ["+", "-", "~"].includes(node.operator))
        expose(node, node.argument);
      if (t.isUpdateExpression(node)) {
        // Reading the previous value invokes coercion hooks on shared caches.
        expose(node, node.argument);
      }
      // Arithmetic assignments coerce both operands. Logical assignments can
      // transfer their RHS into a slot without a proven replacement identity.
      if (t.isAssignmentExpression(node) && node.operator !== "=") {
        if (!["&&=", "||=", "??="].includes(node.operator))
          expose(node, node.left);
        expose(node, node.right);
      }
      // Class field initializers can store a shared cache behind a class
      // allocation that the identity owner treats as foreign.
      if (
        (t.isClassProperty(node) ||
          t.isClassPrivateProperty(node) ||
          t.isClassAccessorProperty(node)) &&
        node.value != null
      )
        expose(node, node.value);
      if (
        t.isBinaryExpression(node) &&
        !["===", "!=="].includes(node.operator)
      ) {
        expose(node, node.left);
        expose(node, node.right);
      }
      if (
        (t.isMemberExpression(node) ||
          t.isOptionalMemberExpression(node) ||
          t.isObjectProperty(node) ||
          t.isObjectMethod(node) ||
          t.isClassProperty(node) ||
          t.isClassAccessorProperty(node) ||
          t.isClassMethod(node)) &&
        node.computed
      )
        expose(
          node,
          t.isMemberExpression(node) || t.isOptionalMemberExpression(node)
            ? node.property
            : node.key,
        );
      if (
        (t.isReturnStatement(node) || t.isYieldExpression(node)) &&
        node.argument != null
      )
        expose(node, node.argument);
      if (t.isArrowFunctionExpression(node) && !t.isBlockStatement(node.body))
        expose(node, node.body);
      const target = t.isAssignmentExpression(node)
        ? node.left
        : t.isUpdateExpression(node)
          ? node.argument
          : t.isUnaryExpression(node, { operator: "delete" })
            ? node.argument
            : t.isForOfStatement(node) || t.isForInStatement(node)
              ? node.left
              : undefined;
      if (target !== undefined && !initializations.has(node))
        deferred.push({
          kind: "write",
          node,
          target,
          exposed: admittedDepth === 0,
        });
    },
    exit: (node) => {
      if (admittedNodes.has(node)) admittedDepth--;
    },
  });
  yield* identities.retainExportedValuesSteps(exposures);
  let examined = 0;
  for (const effect of deferred) {
    if (examined++ % 1024 === 0) yield;
    const { node } = effect;
    if (effect.kind === "values") {
      for (const value of effect.values) {
        if (examined++ % 1024 === 0) yield;
        exposures.push({
          node,
          value: t.isSpreadElement(value) ? value.argument : value,
        });
      }
    } else if (effect.kind === "default")
      yield* semanticWriteTargetsSteps(effect.node.left, (leaf) => {
        if (t.isIdentifier(leaf)) return false;
        exposures.push({ node, value: effect.node.right });
        return true;
      });
    else {
      const directAssignment =
        t.isAssignmentExpression(node, { operator: "=" }) &&
        (t.isMemberExpression(effect.target) ||
          t.isOptionalMemberExpression(effect.target));
      let exposedPattern = false;
      yield* semanticWriteTargetsSteps(effect.target, (leaf) => {
        const member = unwrapJavaScriptExpression(leaf).node;
        if (
          !t.isMemberExpression(member) &&
          !t.isOptionalMemberExpression(member)
        )
          return false;
        // Pattern leaves receive selected values, never the entire RHS. Until
        // selection is proven, expose their source without assigning its wrapper.
        if (!directAssignment && !exposedPattern) {
          if (effect.exposed) {
            if (t.isAssignmentExpression(node) || t.isForOfStatement(node))
              exposures.push({ node, value: node.right });
          }
          exposedPattern = true;
        }
        writes.push({
          node,
          receiver: member.object,
          key: semanticStaticPropertyKey(member.property, member.computed),
          ...(directAssignment && t.isAssignmentExpression(node)
            ? { value: node.right }
            : {}),
        });
        return false;
      });
    }
  }
  return { writes, calls, exposures };
}

function* collectIntrinsicWritesSteps(
  program: t.Program,
  interop: Interop,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, ReadonlySet<string>> {
  const uncertainPrototypes = new Set<string>();
  let examined = 0;
  // Ambient identity owns global effects; an opaque local mutation target is
  // not itself evidence that an intrinsic prototype was changed.
  for (const effect of state.ambientWriteEffects) {
    if (examined++ % 1024 === 0) yield;
    const [root, namespace, property] = effect.path;
    if (root !== "global" && root !== null) continue;
    if (property !== undefined && property !== null && property !== "prototype")
      continue;
    for (const candidate of ["Object", "Array", "Function"])
      if (
        namespace === undefined ||
        namespace === null ||
        namespace === candidate
      )
        uncertainPrototypes.add(candidate);
  }
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    state.erasedSyntaxNodes,
    (node, kind) => {
      if (kind === "opaque-call") return [interop.opaqueMutationPath(node)];
      if (kind === "binding") return [];
      const { root, members } = electronMemberPath(node);
      const path =
        interop.intrinsicPath(root) ?? interop.boundIntrinsic(root)?.path;
      return path === undefined ? [] : [[...path, ...members]];
    },
    interop.intrinsicInvocation,
    interop.staticString,
    interop.isFreshObject,
    (node, path) => interop.retainWrite(node, path),
  );
  return uncertainPrototypes;
}

const directArrayMethod = (
  call: Call,
):
  | { readonly receiver: t.Node; readonly method: string | null }
  | undefined => {
  const callee = unwrapJavaScriptExpression(call.callee).node;
  return t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
    ? {
        receiver: callee.object,
        method: semanticStaticPropertyKey(callee.property, callee.computed),
      }
    : undefined;
};

function* retainCallEffectsSteps(
  call: Call,
  context: CacheEffectContext,
  invalidate: (owner: string | null | undefined) => void,
): Generator<void> {
  const { identities, interop, reads } = context;
  const invocation = interop.intrinsicInvocation(call);
  const direct = directArrayMethod(call);
  if (direct !== undefined && invocation?.kind !== "known") {
    if (
      !(yield* reads.isReadSteps(
        direct.receiver,
        direct.method,
        call.arguments,
      ))
    ) {
      const identity = identities.read(direct.receiver);
      invalidate(identity?.owner);
      if (
        identity?.allocation?.kind === "cache" &&
        reads.sharedWriteAffects(direct.method)
      )
        invalidate(null);
      if (
        identity?.inheritedArrayPrototype === true ||
        identity?.intrinsicPrototype === true
      )
        invalidate(null);
    }
  }
  if (!arrayInvocation(invocation) || invocation?.receiver === undefined)
    return;
  const receiver = identities.read(invocation.receiver);
  const method = invocation.path.at(-1) ?? null;
  if (
    invocation.kind === "known" &&
    receiver?.allocation?.kind === "helper" &&
    ARRAY_MUTATORS.has(method ?? "")
  )
    return;
  if (
    invocation.kind !== "known" ||
    !(yield* reads.isReadSteps(
      invocation.receiver,
      method,
      invocation.arguments,
      true,
    ))
  ) {
    invalidate(receiver?.owner);
    if (
      receiver?.allocation?.kind === "cache" &&
      reads.sharedWriteAffects(method, true)
    )
      invalidate(null);
    if (
      receiver?.inheritedArrayPrototype === true ||
      receiver?.intrinsicPrototype === true
    )
      invalidate(null);
  }
}

/** Property access and iteration can dispatch user code without a call node. */
function* retainImplicitReceiverEffectsSteps(
  program: t.Program,
  context: CacheEffectContext,
  invalidate: (owner: string | null | undefined) => void,
): Generator<void> {
  const selections: { readonly value: t.Node; readonly iteration: boolean }[] =
    [];
  const uncertainPrototypes = context.uncertainPrototypes;
  const unsafeReceivers = new Set<ViteCacheAllocation>();
  const markUnsafe = (value: t.Node | undefined): void => {
    if (value === undefined) return;
    const allocation = context.identities.read(value)?.allocation;
    if (allocation != null) unsafeReceivers.add(allocation);
  };
  let examined = 0;
  yield* traverseJavaScriptValueAstSteps(
    program,
    context.state.erasedSyntaxNodes,
    {
      skip: (node) => context.admittedNodes.has(node),
      enter: (node, parent) => {
        if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
          const invocation = context.interop.intrinsicInvocation(node);
          const path =
            invocation?.kind === "known"
              ? invocation.path.join(".")
              : undefined;
          const target = invocation?.arguments?.[0];
          if (!t.isSpreadElement(target)) {
            if (
              ((path === "intrinsic.Object.defineProperty" ||
                path === "intrinsic.Reflect.defineProperty") &&
                !context.dataDefinitions.has(node)) ||
              path === "intrinsic.Object.defineProperties" ||
              path === "intrinsic.Object.setPrototypeOf" ||
              path === "intrinsic.Reflect.setPrototypeOf"
            )
              markUnsafe(target);
            if (
              target !== undefined &&
              (path === "intrinsic.Object.assign" ||
                path === "intrinsic.Reflect.set")
            )
              selections.push({ value: target, iteration: false });
          }
        }
        if (t.isAssignmentExpression(node)) {
          const target = unwrapJavaScriptExpression(node.left).node;
          if (
            t.isMemberExpression(target) ||
            t.isOptionalMemberExpression(target)
          ) {
            const key = semanticStaticPropertyKey(
              target.property,
              target.computed,
            );
            if (key === null || key === "__proto__") markUnsafe(target.object);
          }
        }
        if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
          // Explicit receiver calls already have the method read proof and effects owner.
          if (
            (t.isCallExpression(parent) ||
              t.isOptionalCallExpression(parent)) &&
            parent.callee === node
          )
            return;
          selections.push({ value: node.object, iteration: false });
        } else if (t.isSpreadElement(node))
          selections.push({
            value: node.argument,
            iteration: !t.isObjectExpression(parent),
          });
        else if (t.isForOfStatement(node))
          selections.push({ value: node.right, iteration: true });
        else {
          const target = t.isVariableDeclarator(node)
            ? node.id
            : t.isAssignmentExpression(node)
              ? node.left
              : undefined;
          const value = t.isVariableDeclarator(node)
            ? node.init
            : t.isAssignmentExpression(node)
              ? node.right
              : undefined;
          if (
            value != null &&
            (t.isObjectPattern(target) || t.isArrayPattern(target))
          )
            selections.push({ value, iteration: t.isArrayPattern(target) });
        }
      },
    },
  );
  const ordinary = new Map<ViteCacheAllocation, boolean>();
  const ordinaryLiteral = function* (
    node: t.ObjectExpression,
  ): Generator<void, boolean> {
    let properties = 0;
    for (const property of node.properties) {
      if (properties++ % 1024 === 0) yield;
      // A spread materializes data descriptors; its source effects are examined separately.
      if (t.isSpreadElement(property)) continue;
      if (t.isObjectMethod(property) && property.kind !== "method")
        return false;
      if (
        t.isObjectProperty(property) &&
        !property.computed &&
        !property.shorthand &&
        semanticStaticPropertyKey(property.key, false) === "__proto__"
      )
        return false;
    }
    return true;
  };
  for (const selection of selections) {
    if (examined++ % 1024 === 0) yield;
    const identity = context.identities.read(selection.value);
    if (identity?.owner === undefined) continue;
    const allocation = identity.allocation;
    if (allocation === null || unsafeReceivers.has(allocation)) {
      invalidate(identity.owner);
      continue;
    }
    const array =
      allocation.kind === "cache" ||
      (allocation.kind === "container" &&
        (t.isArrayExpression(allocation.node) ||
          allocation.helperResult !== undefined ||
          allocation.copy?.initializer.copyKind === "array-rest"));
    const namespace = array
      ? "Array"
      : allocation.kind === "helper"
        ? "Function"
        : "Object";
    if (
      uncertainPrototypes.has("Object") ||
      uncertainPrototypes.has(namespace)
    ) {
      invalidate(identity.owner);
      continue;
    }
    if (selection.iteration) {
      if (!array) invalidate(identity.owner);
      continue;
    }
    let dataOnly = ordinary.get(allocation);
    if (dataOnly === undefined) {
      dataOnly =
        allocation.kind === "cache" ||
        allocation.kind === "helper" ||
        allocation.helperResult !== undefined ||
        allocation.copy !== undefined ||
        t.isArrayExpression(allocation.node) ||
        (t.isObjectExpression(allocation.node) &&
          (yield* ordinaryLiteral(allocation.node)));
      if (!dataOnly && t.isCallExpression(allocation.node)) {
        const invocation = context.interop.intrinsicInvocation(allocation.node);
        const prototype = invocation?.arguments?.[0];
        const prototypeAllocation =
          prototype === undefined || t.isSpreadElement(prototype)
            ? undefined
            : context.identities.read(prototype)?.allocation;
        dataOnly =
          invocation?.kind === "known" &&
          invocation.path.join(".") === "intrinsic.Object.create" &&
          invocation.arguments?.length === 1 &&
          prototypeAllocation?.kind === "helper" &&
          !unsafeReceivers.has(prototypeAllocation) &&
          !uncertainPrototypes.has("Function");
      }
      ordinary.set(allocation, dataOnly);
    }
    if (!dataOnly) invalidate(identity.owner);
  }
}
