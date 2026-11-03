import * as t from "@babel/types";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";

import {
  semanticStaticPropertyKey,
  semanticWriteTargetsSteps,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { semanticArrayIndex } from "./javascriptSemanticPropertyPaths.js";
import {
  semanticEffectStatementPosition,
  semanticReadStatementPosition,
  semanticStatementPositionPrecedes,
  type StatementPosition,
} from "./javascriptSemanticMutationInitializers.js";
import { semanticLoopValueSource } from "./javascriptSemanticIterationSources.js";
import { isUnmodifiedGlobalReference } from "./javascriptSemanticAmbientWrites.js";
import type { JavaScriptIntrinsicInvocation } from "./javascriptElectronMemberWrites.js";
import {
  hasJavaScriptViteInheritedProperty,
  isJavaScriptViteDefaultUndefined,
  readJavaScriptViteTableSlotsSteps,
  javaScriptViteTableHasOwnSlot,
  type JavaScriptViteHelperCandidate,
} from "./javascriptViteHelper.js";

import {
  FOREIGN,
  UNKNOWN,
  type ViteCacheAllocation,
  type ViteCacheIdentity,
  type ViteCacheWrite,
  type ViteCacheValue,
  type ViteCacheExposure,
  type Vertex,
  type VertexKey,
  type Input,
} from "./javascriptViteCacheIdentityTypes.js";
import {
  ViteCacheProperties,
  viteCacheObjectOperation,
} from "./javascriptViteCacheProperties.js";
type Key = string | null;
type CopyMode = "enumerable" | "iteration";
interface CopyEffectIndex {
  readonly size: number;
  readonly count: number;
  readonly tree: readonly (Vertex | undefined)[];
  readonly groups: Map<
    readonly t.Statement[],
    { start: number; end: number; positions: readonly StatementPosition[] }
  >;
}
type DefaultInput = Extract<Input, { kind: "default" }>;

const providedDefaultInput = (
  input: DefaultInput,
  source: ViteCacheIdentity | undefined,
): boolean =>
  input.defined ||
  (source?.allocation != null && source.allocation.kind !== "foreign");

const mayBeInheritedPrototypeKey = (
  value: ReturnType<typeof evaluateSemanticExpression>,
): boolean => {
  const isInherited = (item: string | number | boolean | null): boolean =>
    item === "__proto__" || item === "constructor";
  return value.status === "literal"
    ? isInherited(value.value)
    : value.status === "union"
      ? value.values.some(isInherited)
      : true;
};

const OBJECT_TARGET_RESULTS = new Set([
  "assign",
  "defineProperty",
  "defineProperties",
  "setPrototypeOf",
  "freeze",
  "seal",
  "preventExtensions",
]);

const joinOwner = (
  left: ViteCacheIdentity["owner"],
  right: ViteCacheIdentity["owner"],
): ViteCacheIdentity["owner"] =>
  left === undefined
    ? right
    : right === undefined || left === right
      ? left
      : null;

const joinIdentity = (
  left: ViteCacheIdentity | undefined,
  right: ViteCacheIdentity,
): ViteCacheIdentity => {
  if (left === undefined) return right;
  const allocation =
    left.allocation === right.allocation ? left.allocation : null;
  const owner = joinOwner(left.owner, right.owner);
  const children = joinOwner(left.children, right.children);
  const inheritedArrayPrototype =
    left.inheritedArrayPrototype === true ||
    right.inheritedArrayPrototype === true
      ? true
      : undefined;
  const intrinsicPrototype =
    left.intrinsicPrototype === true || right.intrinsicPrototype === true
      ? true
      : undefined;
  const childrenInheritedArrayPrototype =
    left.childrenInheritedArrayPrototype === true ||
    right.childrenInheritedArrayPrototype === true
      ? true
      : undefined;
  const childrenIntrinsicPrototype =
    left.childrenIntrinsicPrototype === true ||
    right.childrenIntrinsicPrototype === true
      ? true
      : undefined;
  const exactPrototype =
    left.exactPrototype === true && right.exactPrototype === true
      ? true
      : undefined;
  const intrinsicObject =
    left.intrinsicObject === right.intrinsicObject
      ? left.intrinsicObject
      : undefined;
  return allocation === left.allocation &&
    owner === left.owner &&
    children === left.children &&
    inheritedArrayPrototype === left.inheritedArrayPrototype &&
    intrinsicPrototype === left.intrinsicPrototype &&
    childrenInheritedArrayPrototype === left.childrenInheritedArrayPrototype &&
    childrenIntrinsicPrototype === left.childrenIntrinsicPrototype &&
    exactPrototype === left.exactPrototype &&
    intrinsicObject === left.intrinsicObject
    ? left
    : {
        allocation,
        owner,
        children,
        ...(inheritedArrayPrototype === true
          ? { inheritedArrayPrototype }
          : {}),
        ...(intrinsicPrototype === true ? { intrinsicPrototype } : {}),
        ...(childrenInheritedArrayPrototype === true
          ? { childrenInheritedArrayPrototype }
          : {}),
        ...(childrenIntrinsicPrototype === true
          ? { childrenIntrinsicPrototype }
          : {}),
        ...(exactPrototype === true ? { exactPrototype } : {}),
        ...(intrinsicObject === undefined ? {} : { intrinsicObject }),
      };
};

/** normalize expressions once; joins never retain a helper-owner set per alias. */
export class ViteCacheIdentities {
  private readonly vertices = new Map<VertexKey, Vertex>();
  private readonly normalizeQueue: t.Node[] = [];
  private readonly allocations = new Map<string, Vertex>();
  private readonly helperValues = new WeakMap<t.Node, Vertex>();
  private readonly cacheInitializations = new WeakSet<t.Node>();
  private readonly helperResults = new WeakMap<
    t.CallExpression | t.OptionalCallExpression,
    Vertex
  >();
  private readonly defaultChoices: { target: Vertex; input: DefaultInput }[] =
    [];
  private readonly helperArgumentReads = new WeakMap<
    t.CallExpression | t.OptionalCallExpression,
    {
      readonly freshIndexes: boolean;
      readonly table: t.Node | undefined;
      readonly mapper: t.Node | undefined;
      readonly providedTable: DefaultInput | undefined;
      readonly mapperTable: Vertex | undefined;
    }
  >();
  ambiguousCacheFamily = false;
  private readonly reads = new Map<Vertex, Map<Key, Map<t.Node, Vertex>>>();
  private readonly pending: Vertex[] = [];
  private readonly queued = new Set<Vertex>();
  private readonly allocationVertices = new Map<ViteCacheAllocation, Vertex>();
  private snapshots = false;
  private readonly writeReceivers = new Map<Vertex, ViteCacheWrite[]>();
  private readonly retainedWrites = new Map<
    ViteCacheWrite,
    ViteCacheAllocation
  >();
  private readonly exposureReceivers = new Map<Vertex, ViteCacheExposure[]>();
  private readonly retainedExposures = new Map<
    ViteCacheExposure,
    ViteCacheAllocation
  >();

  private readonly properties: ViteCacheProperties;
  private unknownInheritedRead: boolean | undefined;
  private readonly copyMutationHazards = {
    enumerable: new Map<t.Node | undefined, Vertex>(),
    iteration: new Map<t.Node | undefined, Vertex>(),
  };
  private readonly copyEffects: {
    node: t.Node;
    source: Vertex;
    write?: ViteCacheWrite;
  }[] = [];
  private readonly copyEffectIndexes = new Map<CopyMode, CopyEffectIndex>();
  constructor(
    private readonly state: JavaScriptSemanticAnalysisState,
    private readonly invocation: (
      node: t.CallExpression | t.OptionalCallExpression,
    ) => JavaScriptIntrinsicInvocation | undefined,
  ) {
    this.properties = new ViteCacheProperties(state, {
      vertex: () => this.vertex({}),
      normalize: (node) => this.normalize(node),
      project: (source, path, read) => this.project(source, path, read),
      connect: (target, input) => this.connect(target, input),
      enqueue: (vertex) => this.enqueue(vertex),
      objectCall: (node) => viteCacheObjectOperation(node, this.invocation),
      objectArguments: (node) => this.invocation(node)?.arguments,
      invocation: this.invocation,
    });
  }

  read(node: ViteCacheValue): ViteCacheIdentity | undefined {
    return ("inputs" in node ? node : this.vertices.get(node))?.fact;
  }

  /** awaiting iterated values exposes contained references, not the array itself. */
  containedValues(node: t.Node): ViteCacheValue {
    const values = this.vertex({});
    this.connect(values, {
      kind: "iteration-family",
      source: this.normalize(node),
    });
    return values;
  }

  /** module projection owns runtime exports and default-expression captures. */
  *retainExportedValuesSteps(exposures: ViteCacheExposure[]): Generator<void> {
    let examined = 0;
    for (const link of this.state.moduleLinks) {
      if (examined++ % 1024 === 0) yield;
      if (link.kind !== "export") continue;
      const expression = this.state.defaultExportExpressions.get(link);
      const binding = this.state.moduleLinkBindings.get(link);
      if (expression !== undefined)
        exposures.push({ node: expression, value: this.normalize(expression) });
      else if (binding !== undefined)
        exposures.push({
          node: this.state.program,
          value: this.vertex(binding.bindingId),
        });
    }
  }

  /** Parsed call facts distinguish read-only parameters from opaque calls. */
  *readOnlyHelperArgumentsSteps(
    call: t.CallExpression | t.OptionalCallExpression,
  ): Generator<void, readonly t.Node[]> {
    const proof = this.helperArgumentReads.get(call);
    if (
      proof === undefined ||
      this.read(call.callee)?.allocation?.kind !== "helper"
    )
      return [];
    const reads: t.Node[] = [];
    // A mapped argument is read by value only when its proven container holds
    // plain data slots; accessors and spreads can hide unexamined writes.
    if (
      proof.table !== undefined &&
      (yield* this.plainDataSlotsSteps(proof.table))
    )
      reads.push(proof.table);
    const tableAllocation = proof.mapperTable?.fact?.allocation;
    const provided = proof.providedTable;
    if (
      proof.mapper !== undefined &&
      ((provided !== undefined &&
        providedDefaultInput(provided, provided.source.fact)) ||
        (tableAllocation != null &&
          tableAllocation.kind !== "foreign" &&
          (yield* this.plainDataSlotsSteps(proof.mapper))))
    )
      reads.push(proof.mapper);
    return reads;
  }

  /** mapped getters expose their selected receiver across every helper call. */
  *helperMappedTableEscapeSteps(
    call: t.CallExpression | t.OptionalCallExpression,
  ): Generator<void, Vertex | undefined> {
    const proof = this.helperArgumentReads.get(call);
    if (
      proof === undefined ||
      this.read(call.callee)?.allocation?.kind !== "helper"
    )
      return undefined;
    const mapped = this.helperResults.get(call)?.seed?.allocation?.helperResult;
    if (mapped === undefined) return undefined;
    if (!proof.freshIndexes) return mapped.table;
    const node = mapped.table.fact?.allocation?.node;
    const slots = t.isArrayExpression(node)
      ? yield* readJavaScriptViteTableSlotsSteps(node)
      : undefined;
    for (const [index, key] of mapped.keys.entries()) {
      if (index > 0 && index % 1024 === 0) yield;
      if (key === undefined || javaScriptViteTableHasOwnSlot(key, slots))
        continue;
      if (
        key === null
          ? yield* this.unknownInheritedReadSteps()
          : hasJavaScriptViteInheritedProperty(key, this.state)
      )
        return mapped.table;
    }
    if (
      mapped.unknownFrom !== undefined &&
      (yield* this.unknownInheritedReadSteps())
    )
      return mapped.table;
    return undefined;
  }

  private *unknownInheritedReadSteps(): Generator<void, boolean> {
    if (this.unknownInheritedRead !== undefined)
      return this.unknownInheritedRead;
    let examined = 0;
    for (const { path } of this.state.ambientWriteEffects) {
      if (examined++ % 1024 === 0) yield;
      const [root, namespace, property] = path;
      if (
        (root === "global" || root === null) &&
        (namespace == null ||
          namespace === "Array" ||
          namespace === "Object") &&
        (property == null || property === "prototype")
      ) {
        this.unknownInheritedRead = true;
        return true;
      }
    }
    this.unknownInheritedRead = false;
    return false;
  }

  /** Only array or plain data object literals keep mapped reads free of getters. */
  private *plainDataSlotsSteps(
    argument: t.Node | undefined,
  ): Generator<void, boolean> {
    if (argument === undefined) return false;
    const node = this.read(argument)?.allocation?.node;
    if (t.isArrayExpression(node)) return true;
    if (!t.isObjectExpression(node)) return false;
    let examined = 0;
    for (const property of node.properties) {
      if (examined++ % 1024 === 0) yield;
      if (!t.isObjectProperty(property)) return false;
      const key = semanticStaticPropertyKey(property.key, property.computed);
      if (
        key === null ||
        (!property.computed && !property.shorthand && key === "__proto__")
      )
        return false;
    }
    return true;
  }

  /** propagate unexamined exposure through normalized aliases and contained values. */
  *escapedAllocationsSteps(
    nodes: readonly ViteCacheValue[],
  ): Generator<void, ReadonlySet<ViteCacheAllocation>> {
    const allocations = new Set<ViteCacheAllocation>();
    const seen = new Set<Vertex>();
    const pending: Vertex[] = [];
    let examined = 0;
    const retain = (vertex: Vertex, includeAllocation = true): void => {
      if (includeAllocation && vertex.fact?.allocation != null)
        allocations.add(vertex.fact.allocation);
      if (!seen.has(vertex)) {
        seen.add(vertex);
        pending.push(vertex);
      }
    };
    for (const node of nodes) {
      if (examined++ % 1024 === 0) yield;
      const vertex = "inputs" in node ? node : this.vertices.get(node);
      if (vertex !== undefined) retain(vertex);
    }
    for (let index = 0; index < pending.length; index++) {
      if (examined++ % 1024 === 0) yield;
      const vertex = pending[index];
      if (vertex === undefined) continue;
      for (const input of vertex.inputs) {
        if (examined++ % 1024 === 0) yield;
        // A selection whose resolved value is a known foreign constant (a
        // literal string, for example) cannot carry escaped receivers with it.
        // Following its source would mark unrelated owners unsafe through a
        // harmless read and erase valid dependency paths.
        if (
          !(
            input.kind === "select" &&
            vertex.fact?.allocation?.kind === "foreign"
          )
        )
          retain(
            input.kind === "iteration-family" &&
              !this.state.arrayIterationUnknown
              ? (input.source.fact?.allocation?.elementFamily ?? input.source)
              : input.source,
            input.kind !== "copy-family" ||
              input.source.fact?.allocation?.kind !== "cache",
          );
        if (
          input.kind === "default" &&
          !providedDefaultInput(input, input.source.fact)
        )
          retain(input.fallback);
      }
    }
    return allocations;
  }

  normalize(node: t.Node): Vertex {
    const previous = this.vertices.get(node);
    if (previous !== undefined) return previous;
    const vertex = this.vertex(node);
    this.normalizeQueue.push(node);
    return vertex;
  }

  *initializeSteps(
    tables: ReadonlyMap<string, JavaScriptViteHelperCandidate>,
  ): Generator<void> {
    let examined = 0;
    const admitted = new Set<string>();
    const patternWrites = new WeakMap<t.AssignmentExpression, Set<string>>();
    for (const [owner, { table, helper: helperNode }] of tables) {
      if (examined++ % 1024 === 0) yield;
      admitted.add(owner);
      const helper: ViteCacheAllocation = { kind: "helper", owner };
      const cache = this.vertex({});
      const elementFamily = this.newElementFamily();
      cache.seed = {
        allocation: { kind: "cache", owner, node: table, elementFamily },
        owner,
      };
      this.allocations.set(owner, cache);
      const tableVertex = this.normalize(table);
      this.connect(elementFamily, {
        kind: "iteration-family",
        source: tableVertex,
      });
      this.connect(cache, { kind: "family", source: tableVertex });
      const initialization = this.state.parentsByNode.get(table);
      if (initialization !== undefined)
        this.cacheInitializations.add(initialization);
      this.allocationVertices.set(cache.seed.allocation!, cache);
      const helperVertex = this.vertex(owner);
      helperVertex.seed = { allocation: helper, owner };
      this.helperValues.set(helperNode, helperVertex);
      this.allocationVertices.set(helper, helperVertex);
      this.connect(helperVertex, { kind: "family", source: cache });
    }
    for (const binding of this.state.bindingsById.values()) {
      if (examined++ % 1024 === 0) yield;
      if (admitted.has(binding.bindingId)) continue;
      const target = this.vertex(binding.bindingId);
      const groups: readonly (readonly JavaScriptSemanticBindingState["referenceInitializers"][number][])[] =
        [binding.initializers, binding.referenceInitializers];
      for (const initializers of groups)
        for (const initializer of initializers) {
          if (examined++ % 1024 === 0) yield;
          const expression = initializer.node;
          if (
            t.isAssignmentExpression(expression, { operator: "=" }) &&
            (t.isObjectPattern(expression.left) ||
              t.isArrayPattern(expression.left)) &&
            initializer.projection.length === 0
          ) {
            let written = patternWrites.get(expression);
            if (written === undefined) {
              written = new Set();
              patternWrites.set(expression, written);
              const destinations = written;
              yield* semanticWriteTargetsSteps(expression.left, (target) => {
                if (t.isIdentifier(target)) {
                  const selected = resolveSemanticBindingState(
                    this.state,
                    target,
                    target.name,
                  );
                  if (selected !== undefined)
                    destinations.add(selected.bindingId);
                }
                return false;
              });
            }
            // An opaque pattern initializer denotes an unknown selected leaf,
            // not the RHS wrapper allocation. Retain its possible cache family.
            if (written.has(binding.bindingId)) {
              target.seed = UNKNOWN;
              this.connect(target, {
                kind: "family",
                source: this.normalize(expression.right),
              });
              continue;
            }
          }
          const source = this.project(
            this.normalize(initializer.node),
            initializer.projection,
            initializer.node,
          );
          if (initializer.copyKind === undefined)
            this.connect(target, { kind: "alias", source });
          else {
            const offset =
              initializer.copyProjectionOffset ?? initializer.projection.length;
            const beforeCopy = this.project(
              this.normalize(initializer.node),
              initializer.projection.slice(0, offset),
              initializer.node,
            );
            const copy = this.vertex({});
            copy.seed = {
              allocation: {
                kind: "container",
                node: initializer.node,
                copy: { source: beforeCopy, initializer },
              },
              owner: undefined,
            };
            this.allocationVertices.set(copy.seed.allocation!, copy);
            this.connect(copy, {
              kind: "copy-family",
              source: beforeCopy,
              read: initializer.node,
              enumerableOnly: initializer.copyKind === "object-rest",
            });
            this.connect(target, {
              kind: "alias",
              source: this.project(
                copy,
                initializer.projection.slice(offset + 1),
                initializer.node,
              ),
            });
          }
        }
      if (target.inputs.length === 0) target.seed = UNKNOWN;
    }
  }

  /** index local slot effects before the snapshot pass; effects remain source facts. */
  *retainSnapshotsSteps(
    writes: readonly ViteCacheWrite[],
    escapes: readonly ViteCacheExposure[],
  ): Generator<void> {
    let examined = 0;
    for (const write of writes) {
      if (examined++ % 1024 === 0) yield;
      // The admitted initializer already defines this cache allocation and its
      // literal slots; it is not a later replacement of the helper's f property.
      if (this.cacheInitializations.has(write.node)) continue;
      const receiver = this.normalize(write.receiver);
      this.copyEffects.push({ node: write.node, source: receiver, write });
      const receivers = this.writeReceivers.get(receiver) ?? [];
      receivers.push(write);
      this.writeReceivers.set(receiver, receivers);
      this.retainWrite(write);
    }
    yield* this.properties.retainRestrictionsSteps();
    for (const escape of escapes) {
      if (examined++ % 1024 === 0) yield;
      const source =
        "inputs" in escape.value
          ? escape.value
          : this.vertices.get(escape.value);
      if (source === undefined) continue;
      this.copyEffects.push({ node: escape.node, source });
      const receivers = this.exposureReceivers.get(source) ?? [];
      receivers.push(escape);
      this.exposureReceivers.set(source, receivers);
      yield* this.retainExposureSteps(source, escape);
    }
    this.snapshots = true;
    this.reads.clear();
    for (const vertex of this.vertices.values()) {
      if (examined++ % 1024 === 0) yield;
      delete vertex.fact;
      this.enqueue(vertex);
    }
    for (const [allocation, retained] of this.properties.writes) {
      const target = this.allocationVertices.get(allocation);
      if (target === undefined) continue;
      for (const write of retained) {
        if (examined++ % 1024 === 0) yield;
        if (write.value !== undefined)
          this.connect(target, {
            kind: "family",
            source: this.normalize(write.value),
          });
      }
    }
  }

  private retainWrite(write: ViteCacheWrite): void {
    const allocation = this.read(write.receiver)?.allocation;
    if (
      allocation?.kind !== "container" &&
      allocation?.kind !== "cache" &&
      allocation?.kind !== "helper"
    )
      return;
    const retained = this.properties.writes.get(allocation) ?? [];
    retained.push(write);
    this.retainedWrites.set(write, allocation);
    this.properties.writes.set(allocation, retained);
    this.retainElementWrite(allocation, write);
    if (write.value !== undefined) this.normalize(write.value);
  }

  private newElementFamily(): Vertex {
    const family = this.vertex({});
    family.seed = UNKNOWN;
    this.enqueue(family);
    return family;
  }

  private retainElementWrite(
    allocation: ViteCacheAllocation,
    write: ViteCacheWrite,
  ): void {
    if (
      allocation.elementFamily !== undefined &&
      write.value !== undefined &&
      (write.key === null || semanticArrayIndex(write.key) !== null)
    )
      this.connect(allocation.elementFamily, {
        kind: "family",
        source: this.normalize(write.value),
      });
  }

  private *retainExposureSteps(
    source: Vertex,
    exposure: ViteCacheExposure,
  ): Generator<void> {
    const allocation = source.fact?.allocation;
    if (
      allocation?.kind !== "container" ||
      this.retainedExposures.get(exposure) === allocation
    )
      return;
    this.retainedExposures.set(exposure, allocation);
    yield* this.properties.retainEscapeSteps(allocation, exposure.node, source);
  }

  *solveSteps(): Generator<void> {
    let examined = 0;
    let defaultsCursor = 0;
    const unresolvedDefaults = new Set<DefaultInput>();
    for (const vertex of this.vertices.values()) {
      if (examined++ % 1024 === 0) yield;
      this.enqueue(vertex);
    }
    let cursor = 0;
    for (;;) {
      while (this.normalizeQueue.length > 0 || cursor < this.pending.length) {
        yield* this.normalizeSteps();
        const vertex = this.pending[cursor++];
        if (vertex === undefined) continue;
        this.queued.delete(vertex);
        if (cursor % 1024 === 0) yield;
        let incoming = vertex.seed;
        for (const input of vertex.inputs) {
          if (examined++ % 1024 === 0) yield;
          const value = yield* this.inputValueSteps(
            input,
            vertex,
            unresolvedDefaults,
          );
          if (value !== undefined) incoming = joinIdentity(incoming, value);
        }
        if (incoming === undefined) continue;
        const next = joinIdentity(vertex.fact, incoming);
        if (next === vertex.fact) continue;
        vertex.fact = next;
        if (next.allocation?.kind === "cache" && next.owner === null)
          this.ambiguousCacheFamily = true;
        if (this.snapshots)
          for (const write of this.writeReceivers.get(vertex) ?? []) {
            if (examined++ % 1024 === 0) yield;
            if (
              this.retainedWrites.get(write) === next.allocation ||
              (next.allocation?.kind !== "container" &&
                next.allocation?.kind !== "cache" &&
                next.allocation?.kind !== "helper")
            )
              continue;
            this.retainedWrites.set(write, next.allocation);
            yield* this.properties.retainLateWriteSteps(next.allocation, write);
            this.retainElementWrite(next.allocation, write);
            const container = this.allocationVertices.get(next.allocation);
            if (container !== undefined && write.value !== undefined)
              this.connect(container, {
                kind: "family",
                source: this.normalize(write.value),
              });
          }
        if (this.snapshots)
          yield* this.properties.restrictReceiverSteps(vertex);
        if (this.snapshots)
          for (const exposure of this.exposureReceivers.get(vertex) ?? []) {
            if (examined++ % 1024 === 0) yield;
            yield* this.retainExposureSteps(vertex, exposure);
          }
        for (const listener of vertex.listeners) {
          if (examined++ % 1024 === 0) yield;
          this.enqueue(listener);
        }
      }
      // A bottom alias cycle is still an unproven argument, not proof that its
      // default is absent. Widen only after ready arguments reached a fixed point.
      while (defaultsCursor < this.defaultChoices.length) {
        if (examined++ % 1024 === 0) yield;
        const choice = this.defaultChoices[defaultsCursor++];
        if (choice !== undefined && choice.input.source.fact === undefined) {
          unresolvedDefaults.add(choice.input);
          this.enqueue(choice.target);
        }
      }
      if (cursor === this.pending.length && this.normalizeQueue.length === 0)
        break;
    }
    this.pending.length = 0;
    this.queued.clear();
  }

  private vertex(key: VertexKey): Vertex {
    let vertex = this.vertices.get(key);
    if (vertex === undefined) {
      vertex = { key, inputs: [], listeners: new Set() };
      this.vertices.set(key, vertex);
    }
    return vertex;
  }

  private *inputValueSteps(
    input: Input,
    vertex: Vertex,
    unresolvedDefaults: ReadonlySet<DefaultInput>,
  ): Generator<void, ViteCacheIdentity | undefined> {
    const source =
      input.source.fact ??
      (input.kind === "default" && unresolvedDefaults.has(input)
        ? UNKNOWN
        : undefined);
    if (input.kind === "copy-property") {
      // a known value carries its own identities; an unresolved value keeps
      // the existing conservative receiver hazard as well as known children.
      if (
        source !== undefined &&
        (source.allocation !== null || source.exactPrototype === true)
      )
        return source;
      const receiver = input.receiver.fact;
      return receiver === undefined ? source : joinIdentity(source, receiver);
    }
    if (source === undefined) return undefined;
    if (input.kind === "default")
      return providedDefaultInput(input, source)
        ? source
        : input.fallback.fact === undefined
          ? undefined
          : joinIdentity(source, input.fallback.fact);
    if (input.kind === "helper-result")
      return yield* this.helperResultSteps(source, input, vertex);
    if (input.kind === "select")
      return yield* this.selectSteps(source, input, vertex);
    if (input.kind === "inherited-selection") {
      const allocation = source.allocation;
      const owns =
        allocation !== null &&
        (yield* this.properties.ownsInitialSelectionSteps(
          allocation,
          input.key,
        ));
      const original =
        allocation !== null &&
        (allocation.kind === "container" || allocation.kind === "cache")
          ? yield* this.properties.slotSteps(allocation, input.key)
          : undefined;
      const current =
        original !== undefined && allocation !== null && this.snapshots
          ? yield* this.properties.snapshotSteps(
              original,
              allocation,
              input.key,
              input.read,
            )
          : original;
      current?.listeners.add(vertex);
      const selected = current?.fact;
      if (current !== undefined && selected === undefined) return undefined;
      const unknownSelectedValue = selected?.allocation === null;
      const inheritedSpecial =
        !owns && (input.key === "constructor" || input.key === "__proto__");
      const unknownTable =
        !owns &&
        (allocation === null ||
          allocation.kind === "foreign" ||
          (allocation.kind === "container" &&
            !t.isArrayExpression(allocation.node) &&
            !t.isObjectExpression(allocation.node)));
      const modified =
        !owns &&
        allocation !== null &&
        (yield* this.properties.prototypeChangedSteps(
          allocation,
          input.read,
          vertex,
          input.key,
        ));
      return unknownSelectedValue ||
        inheritedSpecial ||
        unknownTable ||
        modified
        ? { allocation: null, owner: undefined, inheritedArrayPrototype: true }
        : FOREIGN;
    }
    if (input.kind === "prototype")
      return yield* this.prototypeSteps(source, input.read, vertex);
    if (input.kind === "alias") return source;
    if (
      input.kind === "iteration-family" &&
      !this.state.arrayIterationUnknown
    ) {
      const family = source.allocation?.elementFamily;
      if (family !== undefined) {
        family.listeners.add(vertex);
        if (family.fact === undefined) return undefined;
        return {
          allocation: vertex.seed?.allocation ?? null,
          owner: family.fact.owner,
          children: family.fact.owner,
          ...(family.fact.inheritedArrayPrototype === true
            ? { inheritedArrayPrototype: true as const }
            : {}),
          ...(family.fact.inheritedArrayPrototype === true
            ? { childrenInheritedArrayPrototype: true as const }
            : {}),
          ...(family.fact.intrinsicPrototype === true
            ? { intrinsicPrototype: true as const }
            : {}),
          ...(family.fact.intrinsicPrototype === true
            ? { childrenIntrinsicPrototype: true as const }
            : {}),
        };
      }
    }
    const owner =
      input.kind === "copy-family" && source.allocation?.kind === "cache"
        ? source.children
        : source.owner;
    let inherited = source.inheritedArrayPrototype === true;
    let intrinsic = source.intrinsicPrototype === true;
    if (
      input.kind === "copy-family" ||
      (input.kind === "iteration-family" &&
        !this.state.arrayIterationUnknown &&
        source.allocation === null)
    ) {
      let unsafe = false;
      if (
        (inherited || intrinsic) &&
        this.snapshots &&
        source.exactPrototype === true
      ) {
        const hazard = yield* this.copyMutationHazardSteps(
          input.read,
          input.kind === "copy-family" && input.enumerableOnly === true
            ? "enumerable"
            : "iteration",
        );
        hazard.listeners.add(vertex);
        unsafe =
          hazard.fact?.inheritedArrayPrototype === true ||
          hazard.fact?.intrinsicPrototype === true;
      }
      inherited =
        source.childrenInheritedArrayPrototype === true ||
        (inherited && (unsafe || source.exactPrototype !== true));
      intrinsic =
        source.childrenIntrinsicPrototype === true ||
        (intrinsic && (unsafe || source.exactPrototype !== true));
    }
    return {
      allocation: vertex.seed?.allocation ?? null,
      owner,
      children: owner,
      ...(inherited ? { inheritedArrayPrototype: true as const } : {}),
      ...(inherited ? { childrenInheritedArrayPrototype: true as const } : {}),
      ...(intrinsic ? { intrinsicPrototype: true as const } : {}),
      ...(intrinsic ? { childrenIntrinsicPrototype: true as const } : {}),
      ...(input.kind === "mapped-family" && source.intrinsicPrototype === true
        ? {
            inheritedArrayPrototype: true as const,
            childrenInheritedArrayPrototype: true as const,
          }
        : {}),
    };
  }

  /** Only effects that may precede a copy can add enumerable values to it. */
  private *copyMutationHazardSteps(
    read: t.Node | undefined,
    mode: CopyMode,
  ): Generator<void, Vertex> {
    const hazards = this.copyMutationHazards[mode];
    const previous = hazards.get(read);
    if (previous !== undefined) return previous;
    const hazard = this.vertex({});
    hazards.set(read, hazard);
    const index = yield* this.copyEffectIndexSteps(mode);
    const addRange = (start: number, end: number): void => {
      for (
        let left = start + index.size, right = end + index.size;
        left < right;
        left >>= 1, right >>= 1
      ) {
        if (left & 1) {
          const node = index.tree[left++];
          if (node !== undefined)
            this.connect(hazard, { kind: "family", source: node });
        }
        if (right & 1) {
          const node = index.tree[--right];
          if (node !== undefined)
            this.connect(hazard, { kind: "family", source: node });
        }
      }
    };
    const position =
      read === undefined
        ? null
        : semanticReadStatementPosition(read, this.state.parentsByNode);
    const group =
      position === null ? undefined : index.groups.get(position.body);
    if (position === null || group === undefined) addRange(0, index.count);
    else {
      let left = 0;
      let right = group.positions.length;
      while (left < right) {
        const middle = (left + right) >>> 1;
        const effectPosition = group.positions[middle];
        if (
          effectPosition !== undefined &&
          !semanticStatementPositionPrecedes(position, effectPosition)
        )
          left = middle + 1;
        else right = middle;
      }
      addRange(0, group.start + left);
      addRange(group.end, index.count);
    }
    return hazard;
  }

  /** Share effect families across copy positions without quadratic edges. */
  private *copyEffectIndexSteps(
    mode: CopyMode,
  ): Generator<void, CopyEffectIndex> {
    const cached = this.copyEffectIndexes.get(mode);
    if (cached !== undefined) return cached;
    type Entry = { source: Vertex; position: StatementPosition | null };
    const grouped = new Map<readonly t.Statement[] | null, Entry[]>();
    let examined = 0;
    for (const effect of this.copyEffects) {
      if (examined++ % 1024 === 0) yield;
      let source = effect.source;
      if (mode === "enumerable") {
        const write = effect.write;
        if (write?.enumerable === false) continue;
        if (
          write?.value !== undefined &&
          write.key !== null &&
          write.key !== "__proto__"
        ) {
          source = this.vertex({});
          this.connect(source, {
            kind: "copy-property",
            source: this.normalize(write.value),
            receiver: effect.source,
          });
        }
      }
      const position = semanticEffectStatementPosition(
        effect.node,
        this.state.parentsByNode,
      );
      const key = position?.body ?? null;
      const entries = grouped.get(key) ?? [];
      if (!grouped.has(key)) grouped.set(key, entries);
      entries.push({ source, position });
    }
    const entries: Entry[] = [];
    const groups = new Map<
      readonly t.Statement[],
      { start: number; end: number; positions: StatementPosition[] }
    >();
    for (const [body, values] of grouped) {
      let ordered = values;
      if (body !== null) {
        let scratch = new Array<Entry>(values.length);
        for (let width = 1; width < values.length; width *= 2) {
          for (let start = 0; start < values.length; start += width * 2) {
            const middle = Math.min(start + width, values.length);
            const end = Math.min(start + width * 2, values.length);
            let left = start;
            let right = middle;
            for (let index = start; index < end; index++) {
              if (examined++ % 1024 === 0) yield;
              const a = left < middle ? ordered[left] : undefined;
              const b = right < end ? ordered[right] : undefined;
              const precedes =
                a !== undefined &&
                (b === undefined ||
                  a.position!.index < b.position!.index ||
                  (a.position!.index === b.position!.index &&
                    a.position!.declaratorIndex <=
                      b.position!.declaratorIndex));
              scratch[index] = precedes ? ordered[left++]! : ordered[right++]!;
            }
          }
          [ordered, scratch] = [scratch, ordered];
        }
      }
      const start = entries.length;
      const positions: StatementPosition[] = [];
      for (const value of ordered) {
        if (examined++ % 1024 === 0) yield;
        entries.push(value);
        if (value.position !== null) positions.push(value.position);
      }
      if (body !== null)
        groups.set(body, {
          start,
          end: entries.length,
          positions,
        });
    }
    let size = 1;
    while (size < entries.length) size *= 2;
    const tree: (Vertex | undefined)[] = new Array(size * 2);
    for (let i = 0; i < entries.length; i++) {
      if (examined++ % 1024 === 0) yield;
      tree[size + i] = entries[i]?.source;
    }
    for (let i = size - 1; i > 0; i--) {
      if (examined++ % 1024 === 0) yield;
      const left = tree[i * 2];
      const right = tree[i * 2 + 1];
      if (left === undefined) tree[i] = right;
      else if (right === undefined) tree[i] = left;
      else {
        const family = this.vertex({});
        this.connect(family, { kind: "family", source: left });
        this.connect(family, { kind: "family", source: right });
        tree[i] = family;
      }
    }
    const result = { size, count: entries.length, tree, groups };
    this.copyEffectIndexes.set(mode, result);
    return result;
  }

  private *helperResultSteps(
    source: ViteCacheIdentity,
    input: Extract<Input, { kind: "helper-result" }>,
    target: Vertex,
  ): Generator<void, ViteCacheIdentity | undefined> {
    if (source.allocation?.kind !== "helper")
      return { allocation: null, owner: source.owner };
    const owner = source.allocation.owner ?? "";
    const cache = this.allocations.get(owner);
    if (cache === undefined) return UNKNOWN;
    let result = this.helperResults.get(input.call);
    if (result === undefined) {
      result = this.vertex({});
      const elementFamily = this.newElementFamily();
      this.helperResults.set(input.call, result);
      const indexes = input.call.arguments[0];
      const selection =
        indexes === undefined
          ? undefined
          : unwrapJavaScriptExpression(indexes).node;
      const table = yield* this.helperTableSteps(
        input.call,
        cache,
        owner,
        t.isArrayExpression(selection),
      );
      const keys: (string | null | undefined)[] = [];
      let unknownFrom: number | undefined = t.isArrayExpression(selection)
        ? undefined
        : 0;
      let uncertain = !t.isArrayExpression(selection);
      let inheritedValue = false;
      if (t.isArrayExpression(selection)) {
        let examined = 0;
        for (const index of selection.elements) {
          if (examined++ % 1024 === 0) yield;
          if (t.isSpreadElement(index)) {
            const spread = evaluateSemanticExpression(
              index.argument,
              this.state,
              input.call,
            );
            inheritedValue ||=
              this.state.arrayIterationUnknown ||
              spread.status !== "array" ||
              spread.unknownItems ||
              spread.items.some(
                (item) =>
                  item.presence !== "present" ||
                  mayBeInheritedPrototypeKey(item.value),
              );
            unknownFrom = keys.length;
            uncertain = true;
            break;
          }
          const key =
            index === null
              ? hasJavaScriptViteInheritedProperty(keys.length, this.state)
                ? null
                : undefined
              : semanticStaticPropertyKey(index, true);
          keys.push(key);
          if (key === undefined) continue;
          if (key === null) {
            uncertain = true;
            inheritedValue ||=
              index === null ||
              mayBeInheritedPrototypeKey(
                evaluateSemanticExpression(index, this.state, input.call),
              );
          } else {
            const selected = this.project(table, [key], input.call);
            this.connect(result, { kind: "mapped-family", source: selected });
            this.connect(elementFamily, {
              kind: "mapped-family",
              source: selected,
            });
            {
              const inherited = this.vertex({});
              this.connect(inherited, {
                kind: "inherited-selection",
                source: table,
                key,
                read: input.call,
              });
              this.connect(result, { kind: "family", source: inherited });
              this.connect(elementFamily, {
                kind: "family",
                source: inherited,
              });
            }
          }
        }
      }
      if (inheritedValue || !t.isArrayExpression(selection)) {
        // A missing or unknown table key can yield a shared inherited value,
        // such as Array.prototype, even when every owned table slot is a string.
        // Keep that value separate from the cache array's own identity.
        const inherited = this.vertex({});
        inherited.seed = {
          allocation: null,
          owner: undefined,
          inheritedArrayPrototype: true,
        };
        this.enqueue(inherited);
        this.connect(result, { kind: "family", source: inherited });
        this.connect(elementFamily, { kind: "family", source: inherited });
      }
      if (uncertain) {
        this.connect(result, { kind: "copy-family", source: table });
        this.connect(elementFamily, { kind: "copy-family", source: table });
      }
      const allocation: ViteCacheAllocation = {
        kind: "container",
        node: input.call,
        elementFamily,
        helperResult: {
          table,
          keys,
          unknownFrom,
          read: input.call,
          family: result,
        },
      };
      result.seed = { allocation, owner: undefined };
      this.allocationVertices.set(allocation, result);
      this.enqueue(result);
    }
    result.listeners.add(target);
    return result.fact;
  }

  private *helperTableSteps(
    call: t.CallExpression | t.OptionalCallExpression,
    cache: Vertex,
    owner: string,
    freshIndexes: boolean,
  ): Generator<void, Vertex> {
    const arguments_ = call.arguments;
    if (
      arguments_.slice(0, 3).some((argument) => t.isSpreadElement(argument))
    ) {
      this.helperArgumentReads.set(call, {
        freshIndexes,
        table: undefined,
        mapper: undefined,
        providedTable: undefined,
        mapperTable: undefined,
      });
      const table = this.vertex({});
      table.seed = UNKNOWN;
      this.connect(table, { kind: "copy-family", source: cache });
      let examined = 0;
      for (const argument of arguments_) {
        if (examined++ % 1024 === 0) yield;
        this.connect(table, {
          kind: "family",
          source: this.normalize(
            t.isSpreadElement(argument) ? argument.argument : argument,
          ),
        });
      }
      return table;
    }
    const usesDefault = (node: t.Node | undefined): boolean =>
      node === undefined || isJavaScriptViteDefaultUndefined(node, this.state);
    const mapperArgument = arguments_[1];
    let fallback = cache;
    let mapperTable: Vertex | undefined;
    if (mapperArgument !== undefined && !usesDefault(mapperArgument)) {
      const mapper = this.defaultChoice(
        this.normalize(mapperArgument),
        this.vertex(owner),
        mapperArgument,
      ).vertex;
      const contextual = this.vertex({});
      contextual.seed = UNKNOWN;
      this.connect(contextual, { kind: "copy-family", source: cache });
      this.connect(contextual, { kind: "family", source: mapper });
      // A provided mapper can already own a table. Its unproven initializer
      // context retains sharing without pretending its m parameter is default.
      mapperTable = this.project(mapper, ["f"], call);
      fallback = this.defaultChoice(mapperTable, contextual).vertex;
    }
    const tableArgument = arguments_[2];
    const provided =
      tableArgument === undefined || usesDefault(tableArgument)
        ? undefined
        : this.defaultChoice(
            this.normalize(tableArgument),
            fallback,
            tableArgument,
          );
    this.helperArgumentReads.set(call, {
      freshIndexes,
      table: provided === undefined ? undefined : tableArgument,
      mapper: mapperArgument,
      providedTable: provided?.input,
      mapperTable,
    });
    return provided?.vertex ?? fallback;
  }

  private defaultChoice(
    source: Vertex,
    fallback: Vertex,
    node?: t.Node,
  ): { vertex: Vertex; input: DefaultInput } {
    const selected = this.vertex({});
    const input: DefaultInput = {
      kind: "default",
      source,
      fallback,
      defined:
        node !== undefined &&
        (t.isLiteral(node) ||
          t.isArrayExpression(node) ||
          t.isObjectExpression(node) ||
          t.isFunction(node) ||
          t.isClass(node)),
    };
    this.connect(selected, input);
    return { vertex: selected, input };
  }

  private enqueue(vertex: Vertex): void {
    if (this.queued.has(vertex)) return;
    this.queued.add(vertex);
    this.pending.push(vertex);
  }

  private connect(target: Vertex, input: Input): void {
    target.inputs.push(input);
    input.source.listeners.add(target);
    if (input.kind === "copy-property") input.receiver.listeners.add(target);
    if (input.kind === "default") {
      input.fallback.listeners.add(target);
      this.defaultChoices.push({ target, input });
    }
    this.enqueue(target);
  }

  private project(
    source: Vertex,
    path: readonly (string | number | null)[],
    read: t.Node,
  ): Vertex {
    let current = source;
    for (const segment of path) {
      const key = segment === null ? null : String(segment);
      const byKey =
        this.reads.get(current) ?? new Map<Key, Map<t.Node, Vertex>>();
      this.reads.set(current, byKey);
      const byRead = byKey.get(key) ?? new Map<t.Node, Vertex>();
      byKey.set(key, byRead);
      let selected = byRead.get(read);
      if (selected === undefined) {
        selected = this.vertex({});
        byRead.set(read, selected);
        this.connect(selected, { kind: "select", source: current, key, read });
      }
      current = selected;
    }
    return current;
  }

  private *normalizeSteps(): Generator<void> {
    let examined = 0;
    while (this.normalizeQueue.length > 0) {
      if (examined++ % 1024 === 0) yield;
      const node = this.normalizeQueue.pop();
      if (node === undefined) break;
      const vertex = this.vertex(node);
      const expression = unwrapJavaScriptExpression(node).node;
      if (expression !== node) {
        this.connect(vertex, {
          kind: "alias",
          source: this.normalize(expression),
        });
        continue;
      }
      const helper = this.helperValues.get(expression);
      if (helper !== undefined) {
        this.connect(vertex, { kind: "alias", source: helper });
        continue;
      }
      // The intrinsic constructor and its prototype can reach the shared array
      // prototype even when a caller stores them under an arbitrary own key.
      const globalConstructor =
        t.isIdentifier(expression) &&
        (expression.name === "Array" || expression.name === "Object") &&
        resolveSemanticBindingState(this.state, expression, expression.name) ===
          undefined;
      const globalMember =
        (t.isMemberExpression(expression) ||
          t.isOptionalMemberExpression(expression)) &&
        t.isIdentifier(expression.object, { name: "globalThis" }) &&
        resolveSemanticBindingState(
          this.state,
          expression.object,
          "globalThis",
        ) === undefined &&
        ["Array", "Object"].includes(
          semanticStaticPropertyKey(expression.property, expression.computed) ??
            "",
        );
      if (globalConstructor || globalMember) {
        const name = t.isIdentifier(expression)
          ? expression.name
          : t.isMemberExpression(expression) ||
              t.isOptionalMemberExpression(expression)
            ? semanticStaticPropertyKey(
                expression.property,
                expression.computed,
              )
            : null;
        vertex.seed = {
          allocation: null,
          owner: undefined,
          intrinsicPrototype: true,
          ...(name === "Array" || name === "Object"
            ? { intrinsicObject: name }
            : {}),
          ...(name !== null &&
          isUnmodifiedGlobalReference(expression, this.state, name)
            ? { exactPrototype: true as const }
            : {}),
        };
        this.enqueue(vertex);
        continue;
      }
      if (t.isForOfStatement(expression)) {
        const source = semanticLoopValueSource(
          expression,
          this.state.parentsByNode.get(expression) ?? null,
        );
        if (source === undefined) vertex.seed = UNKNOWN;
        else
          this.connect(vertex, {
            kind: "iteration-family",
            source: this.normalize(source.node),
          });
        this.enqueue(vertex);
        continue;
      }
      const invocation =
        t.isCallExpression(expression) || t.isOptionalCallExpression(expression)
          ? this.invocation(expression)
          : undefined;
      if (
        invocation !== undefined &&
        (invocation.path.join(".") === "intrinsic.Object.getPrototypeOf" ||
          invocation.path.join(".") === "intrinsic.Reflect.getPrototypeOf")
      ) {
        const receiver =
          invocation.kind === "known" ? invocation.arguments?.[0] : undefined;
        if (receiver === undefined || t.isSpreadElement(receiver)) {
          vertex.seed = { allocation: null, owner: null };
          this.enqueue(vertex);
        } else
          this.connect(vertex, {
            kind: "prototype",
            source: this.normalize(receiver),
            read: expression,
          });
        continue;
      }
      if (
        invocation?.kind === "known" &&
        invocation.path.length === 3 &&
        invocation.path[0] === "intrinsic" &&
        invocation.path[1] === "Object" &&
        OBJECT_TARGET_RESULTS.has(invocation.path[2] ?? "")
      ) {
        const target = invocation.arguments?.[0];
        if (target === undefined || t.isSpreadElement(target))
          vertex.seed = UNKNOWN;
        else
          this.connect(vertex, {
            kind: "alias",
            source: this.normalize(target),
          });
        continue;
      }
      if (
        t.isObjectExpression(expression) ||
        t.isArrayExpression(expression) ||
        viteCacheObjectOperation(expression, this.invocation) !== undefined
      ) {
        yield* this.normalizeContainerSteps(vertex, expression);
        continue;
      }
      if (
        t.isCallExpression(expression) ||
        t.isOptionalCallExpression(expression)
      ) {
        this.connect(vertex, {
          kind: "helper-result",
          source: this.normalize(expression.callee),
          call: expression,
        });
        continue;
      }
      if (t.isIdentifier(expression)) {
        const binding = resolveSemanticBindingState(
          this.state,
          expression,
          expression.name,
        );
        if (binding === undefined) vertex.seed = UNKNOWN;
        else
          this.connect(vertex, {
            kind: "alias",
            source: this.vertex(binding.bindingId),
          });
      } else if (
        t.isMemberExpression(expression) ||
        t.isOptionalMemberExpression(expression)
      ) {
        this.connect(vertex, {
          kind: "select",
          source: this.normalize(expression.object),
          key: semanticStaticPropertyKey(
            expression.property,
            expression.computed,
          ),
          read: expression,
        });
      } else if (
        t.isConditionalExpression(expression) ||
        t.isLogicalExpression(expression)
      ) {
        for (const child of t.isConditionalExpression(expression)
          ? [expression.consequent, expression.alternate]
          : [expression.left, expression.right])
          this.connect(vertex, {
            kind: "alias",
            source: this.normalize(child),
          });
      } else if (
        t.isSequenceExpression(expression) ||
        t.isAssignmentExpression(expression, { operator: "=" })
      ) {
        const value = t.isSequenceExpression(expression)
          ? expression.expressions.at(-1)
          : expression.right;
        if (value !== undefined)
          this.connect(vertex, {
            kind: "alias",
            source: this.normalize(value),
          });
      } else vertex.seed = foreignAllocation(expression) ? FOREIGN : UNKNOWN;
      this.enqueue(vertex);
    }
  }

  private *normalizeContainerSteps(
    vertex: Vertex,
    expression: t.Node,
  ): Generator<void> {
    const elementFamily = t.isArrayExpression(expression)
      ? this.newElementFamily()
      : undefined;
    const allocation: ViteCacheAllocation = {
      kind: "container",
      node: expression,
      ...(elementFamily === undefined ? {} : { elementFamily }),
    };
    vertex.seed = { allocation, owner: undefined };
    this.allocationVertices.set(allocation, vertex);
    const shallowCopy =
      t.isCallExpression(expression) &&
      viteCacheObjectOperation(expression, this.invocation) === "assign";
    const children = t.isObjectExpression(expression)
      ? expression.properties
      : t.isArrayExpression(expression)
        ? expression.elements
        : t.isCallExpression(expression)
          ? (this.invocation(expression)?.arguments ?? [])
          : [];
    let examined = 0;
    for (const child of children) {
      if (examined++ % 1024 === 0) yield;
      if (child === null) continue;
      const value = t.isSpreadElement(child)
        ? child.argument
        : t.isObjectProperty(child)
          ? child.value
          : child;
      const normalized = this.normalize(value);
      this.connect(vertex, {
        kind:
          t.isSpreadElement(child) && elementFamily !== undefined
            ? "iteration-family"
            : t.isSpreadElement(child) || shallowCopy
              ? "copy-family"
              : "family",
        source: normalized,
        read: t.isSpreadElement(child) ? child : expression,
        enumerableOnly: shallowCopy || t.isObjectExpression(expression),
      });
      if (elementFamily !== undefined)
        this.connect(elementFamily, {
          kind: t.isSpreadElement(child) ? "iteration-family" : "family",
          source: normalized,
          read: child,
        });
    }
    this.enqueue(vertex);
  }

  /** preserve a supplied prototype until intervening effects make it unproven. */
  private *prototypeSteps(
    source: ViteCacheIdentity,
    read: t.Node,
    target: Vertex,
  ): Generator<void, ViteCacheIdentity | undefined> {
    const allocation = source.allocation;
    const sharedUnknown: ViteCacheIdentity = { allocation: null, owner: null };
    if (
      allocation?.kind !== "container" ||
      !t.isCallExpression(allocation.node) ||
      viteCacheObjectOperation(allocation.node, this.invocation) !== "create"
    )
      return sharedUnknown;
    if (yield* this.properties.prototypeChangedSteps(allocation, read, target))
      return sharedUnknown;
    const prototype = this.invocation(allocation.node)?.arguments?.[0];
    if (prototype === undefined || t.isSpreadElement(prototype))
      return sharedUnknown;
    const selected = this.normalize(prototype);
    selected.listeners.add(target);
    return selected.fact;
  }

  private *selectSteps(
    source: ViteCacheIdentity,
    input: Extract<Input, { kind: "select" }>,
    target: Vertex,
  ): Generator<void, ViteCacheIdentity | undefined> {
    const allocation = source.allocation;
    const intrinsic = source.intrinsicObject;
    if (source.exactPrototype === true && intrinsic !== undefined) {
      const path = ["global", ...intrinsic.split("."), input.key];
      if (
        !this.state.ambientWrites.covers(path) &&
        !this.state.ambientEscapes.covers(path)
      ) {
        if (
          (intrinsic === "Array.prototype" && input.key === "length") ||
          ((intrinsic === "Array" || intrinsic === "Object") &&
            (input.key === "name" || input.key === "length"))
        )
          return FOREIGN;
        const selected =
          input.key === "prototype" &&
          (intrinsic === "Array" || intrinsic === "Object")
            ? (`${intrinsic}.prototype` as const)
            : input.key === "constructor" &&
                (intrinsic === "Array.prototype" ||
                  intrinsic === "Object.prototype")
              ? intrinsic === "Array.prototype"
                ? "Array"
                : "Object"
              : undefined;
        if (selected !== undefined)
          return {
            allocation: null,
            owner: undefined,
            intrinsicPrototype: true,
            intrinsicObject: selected,
            exactPrototype: true,
          };
      }
    }
    if (allocation === null)
      return {
        allocation: null,
        owner: source.owner,
        ...(source.inheritedArrayPrototype === true
          ? { inheritedArrayPrototype: true as const }
          : {}),
        ...(source.intrinsicPrototype === true
          ? { intrinsicPrototype: true as const }
          : {}),
        ...(source.exactPrototype === true && input.key === "prototype"
          ? { exactPrototype: true as const }
          : {}),
      };
    if (
      input.key === "__proto__" &&
      (allocation.kind === "cache" ||
        t.isArrayExpression(allocation.node) ||
        allocation.helperResult !== undefined)
    )
      return {
        allocation: null,
        owner: undefined,
        inheritedArrayPrototype: true,
        ...(!hasJavaScriptViteInheritedProperty("__proto__", this.state) &&
        !(yield* this.properties.prototypeChangedSteps(
          allocation,
          input.read,
          target,
        ))
          ? { exactPrototype: true as const }
          : {}),
      };
    if (input.key === "__proto__" && allocation.kind === "helper")
      return { allocation: null, owner: null };
    if (allocation.kind === "helper") {
      const cache = this.allocations.get(allocation.owner ?? "");
      if (input.key === "f" && cache !== undefined) {
        const selected = this.snapshots
          ? yield* this.properties.snapshotSteps(
              cache,
              allocation,
              "f",
              input.read,
            )
          : cache;
        selected.listeners.add(target);
        return selected.fact;
      }
    }
    if (
      allocation.kind !== "container" &&
      allocation.kind !== "cache" &&
      allocation.kind !== "helper"
    )
      return FOREIGN;
    if (input.key === null)
      return {
        allocation: null,
        owner: source.owner,
        ...(source.inheritedArrayPrototype === true
          ? { inheritedArrayPrototype: true as const }
          : {}),
      };
    const slot = yield* this.properties.slotSteps(allocation, input.key);
    const selected = this.snapshots
      ? yield* this.properties.snapshotSteps(
          slot,
          allocation,
          input.key,
          input.read,
        )
      : slot;
    if (!selected.listeners.has(target)) selected.listeners.add(target);
    const fact = selected.fact;
    if (fact === undefined) return undefined;
    if (
      allocation.helperResult !== undefined &&
      fact.intrinsicPrototype === true
    )
      return { ...fact, inheritedArrayPrototype: true };
    return fact.allocation === null && fact.owner === undefined
      ? {
          allocation: null,
          owner: source.owner,
          ...(source.inheritedArrayPrototype === true
            ? { inheritedArrayPrototype: true as const }
            : {}),
          ...(fact.intrinsicPrototype === true ||
          source.intrinsicPrototype === true
            ? { intrinsicPrototype: true as const }
            : {}),
          ...(fact.exactPrototype === true
            ? { exactPrototype: true as const }
            : {}),
        }
      : fact;
  }
}

const foreignAllocation = (node: t.Node): boolean =>
  t.isLiteral(node) ||
  t.isFunction(node) ||
  t.isObjectMethod(node) ||
  t.isClass(node);
