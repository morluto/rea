import { semanticExactResultOperand } from "./javascriptSemanticExpressionResults.js";
import * as t from "@babel/types";

import {
  javaScriptExactResultOperand,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
} from "./javascriptElectronMemberWrites.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { isImportMetaUrl } from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticBindingAtRead,
  semanticEffectFollowsReference,
  semanticTopLevelEffectFollowsCapture,
  semanticCaptureActivationIsSingle,
} from "./javascriptSemanticMutationInitializers.js";
import { semanticRequireOrigin } from "./javascriptSemanticRequireOrigin.js";
import { semanticPropertyPathKeyMatches } from "./javascriptSemanticPropertyPaths.js";
import {
  semanticInitializerPrecedesRead,
  type SemanticExecutionFrame,
} from "./javascriptSemanticEvaluationOrder.js";
import { webSocketExecutionContexts } from "./javascriptWebSocketExecution.js";
import {
  semanticIterationSources,
  type SemanticIterationSource,
} from "./javascriptSemanticIterationSources.js";
import { joinSemanticPropertyPaths } from "./javascriptSemanticPropertyPaths.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import {
  semanticCopiedReferencePath,
  semanticReferenceIterationUnknown,
  semanticReferenceSourcesInactive,
} from "./javascriptSemanticReferenceSources.js";

const GLOBAL_OBJECT_NAMES = ["globalThis", "global", "window", "self"];

/** The CommonJS ws constructor's repeated self members select the same export. */
export const semanticRequiredWebSocketProjection = (
  path: readonly string[],
): readonly string[] | undefined => {
  const canonical = canonicalAmbientPath(["commonjs-ws", ...path]);
  return canonical.length === 1
    ? path.length === 0
      ? []
      : ["WebSocket"]
    : undefined;
};

const globalObjectName = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): string | undefined =>
  GLOBAL_OBJECT_NAMES.find((name) => isUnshadowedGlobal(node, state, name));

/** Global self references retain object identity, rather than adding a property. */
const canonicalAmbientPath = (
  path: readonly (string | null)[],
  onGlobalSelf?: (name: string) => void,
): readonly (string | null)[] => {
  // The CommonJS ws constructor is its own WebSocket member. Resolve the
  // written receiver first; the collector then appends the actual replaced key.
  if (path[0] === "commonjs-ws") {
    let member = 1;
    while (path[member] === "WebSocket") member += 1;
    return ["commonjs-ws", ...path.slice(member)];
  }
  if (path[0] !== "global") return path;
  let firstProperty = 1;
  while (GLOBAL_OBJECT_NAMES.includes(path[firstProperty] ?? "")) {
    onGlobalSelf?.(path[firstProperty] as string);
    firstProperty += 1;
  }
  return ["global", ...path.slice(firstProperty)];
};

type AmbientPath = readonly (string | null)[];

const retainedAmbientEffects = new WeakMap<
  JavaScriptSemanticAnalysisState,
  Map<t.Node | undefined, Set<string>>
>();

/** Retain canonical ambient effects once, whether discovered by syntax or receiver expansion. */
export const retainSemanticAmbientEffect = (
  state: JavaScriptSemanticAnalysisState,
  kind: "write" | "escape",
  path: AmbientPath,
  node: t.Node | undefined,
): boolean => {
  const selected = kind === "escape" ? [...path, null] : path;
  const byNode = retainedAmbientEffects.get(state) ?? new Map();
  const keys = byNode.get(node) ?? new Set<string>();
  const key = JSON.stringify([kind, selected]);
  if (keys.has(key)) return false;
  keys.add(key);
  byNode.set(node, keys);
  retainedAmbientEffects.set(state, byNode);
  if (kind === "write") {
    state.ambientWrites.retain(selected);
  } else {
    state.ambientEscapes.retain(selected);
  }
  state.ambientReferenceEffects.push({ path: selected, node, kind });
  return true;
};

/** Undefined means a cyclic or conflicting projection can select any depth. */
type AmbientProjection = AmbientPath | undefined;

const joinAmbientProjection = (
  left: AmbientProjection,
  right: AmbientProjection,
): AmbientProjection =>
  left === undefined || right === undefined || left.length !== right.length
    ? undefined
    : left.map((key, index) => (key === right[index] ? key : null));

type AmbientIdentityUnknownReason =
  | "unresolved-value"
  | "widened-projection"
  | "unresolved-call"
  | "mixed-identities";

interface AmbientResolution {
  readonly paths: readonly AmbientPath[];
  readonly ownership: "local" | "ambient" | "unknown";
  readonly unknownReasons: readonly AmbientIdentityUnknownReason[];
}

interface AmbientReferenceFacts {
  readonly stores: WeakMap<
    t.Node,
    Map<SemanticIterationSource, AmbientProjection>
  >;
  readonly prototypeTarget: (node: t.Node) => t.Node | undefined;
  readonly freshObject: (node: t.Node) => boolean;
}

/**
 * Follow local object identities without equating shallow copies with their
 * sources. Writes select aliases at their capture; uncertain execution order
 * retains possible initializers. Intrinsic reads stay strict.
 */
export const createAmbientPathResolver = (
  state: JavaScriptSemanticAnalysisState,
  possibleWrites: boolean,
  facts?: AmbientReferenceFacts,
) => {
  const cached = new WeakMap<t.Node, AmbientResolution>();
  const returnedReferences = createSemanticReturnedReferences(state);
  return (
    node: t.Node,
    capture?: t.Node,
    escapedContents = false,
    projection: AmbientProjection = [],
    localIdentity?: (node: t.Node, path: AmbientProjection) => void,
  ): AmbientResolution => {
    const prior = possibleWrites ? undefined : cached.get(node);
    if (prior !== undefined) return prior;
    const result = new Map<string, AmbientPath>();
    let hasLocalIdentity = false;
    const unknownReasons = new Set<AmbientIdentityUnknownReason>();
    // The caller's write site selects initializers for the written target.
    // Reads reached through an initializer occur at their own position.
    const pending: {
      node: t.Node;
      suffix: AmbientProjection;
      readsAtSelf?: true;
    }[] = [{ node, suffix: projection }];
    // Join projections at their producing expression, rather than enumerating
    // alias histories. Each key can only widen to a wildcard, and conflicting
    // depths widen to unknown, so diamonds and cycles have finite state.
    const expanded = new WeakMap<t.Node, AmbientProjection>();
    const retain = (path: AmbientPath) => {
      let canonical = canonicalAmbientPath(path);
      for (;;) {
        result.set(JSON.stringify(canonical), canonical);
        if (
          possibleWrites &&
          canonical[0] === "global" &&
          canonical[2] === "prototype" &&
          canonical[3] === "constructor"
        ) {
          canonical = ["global", canonical[1] ?? null, ...canonical.slice(4)];
          continue;
        }
        // An unknown key may select a global self reference as well as a
        // distinct property. Retain both possible object identities for writes.
        if (
          !possibleWrites ||
          (canonical[0] !== "global" && canonical[0] !== "commonjs-ws") ||
          canonical[1] !== null
        )
          break;
        canonical = canonicalAmbientPath([canonical[0], ...canonical.slice(2)]);
      }
    };
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const queuedBefore = pending.length;
      const pathsBefore = result.size;
      let resolvedIdentity = false;
      try {
        const { root, members } = electronMemberPath(current.node);
        let suffix: AmbientProjection =
          current.suffix === undefined
            ? undefined
            : [...members, ...current.suffix];
        if (expanded.has(root)) {
          const previous = expanded.get(root);
          if (previous === undefined) {
            resolvedIdentity = true;
            continue;
          }
          if (suffix !== undefined && previous.length === suffix.length) {
            const joined = joinSemanticPropertyPaths(previous, suffix);
            if (joined === previous) {
              resolvedIdentity = true;
              continue;
            }
            suffix = joined;
          } else suffix = undefined;
          if (!possibleWrites) {
            const unresolved: AmbientResolution = {
              paths: [],
              ownership: "unknown",
              unknownReasons: ["widened-projection"],
            };
            cached.set(node, unresolved);
            return unresolved;
          }
        }
        expanded.set(root, suffix);
        if (suffix === undefined || suffix.includes(null))
          unknownReasons.add("widened-projection");
        // A widened projection is a possible write, never proof of an intrinsic.
        if (suffix === undefined && !possibleWrites) continue;
        const continueWith = (node: t.Node, path: AmbientProjection = suffix) =>
          pending.push({
            node,
            suffix: path,
            ...(current.readsAtSelf && { readsAtSelf: true }),
          });
        const exactResult = possibleWrites
          ? javaScriptExactResultOperand(root, () => true)
          : semanticExactResultOperand(root, state);
        if (exactResult !== undefined) {
          continueWith(exactResult);
          continue;
        }
        const continueReturned = (callee: t.Node, path: AmbientProjection) => {
          const returned = returnedReferences(callee);
          // Returned references retain possible source-local values, not a
          // completeness proof for every runtime callable alternative.
          unknownReasons.add("unresolved-call");
          for (const source of returned.references)
            continueWith(
              source.node,
              path === undefined
                ? undefined
                : [
                    ...source.projection.map((key) =>
                      key === null || typeof key === "object"
                        ? null
                        : String(key),
                    ),
                    ...path,
                  ],
            );
        };
        if (!t.isIdentifier(root) && facts?.freshObject(root)) {
          localIdentity?.(root, suffix);
          // The allocation owns itself; a projected child needs its own proof.
          if (suffix?.length === 0) {
            hasLocalIdentity = true;
            resolvedIdentity = true;
          }
          for (const [source, path] of facts?.stores.get(root) ?? []) {
            const selected =
              suffix === undefined ||
              path === undefined ||
              path.every(
                (key, index) =>
                  index >= suffix.length ||
                  key === null ||
                  suffix[index] === null ||
                  key === suffix[index],
              );
            if (
              !selected ||
              (suffix !== undefined &&
                path !== undefined &&
                suffix.length < path.length &&
                !escapedContents)
            )
              continue;
            const remaining =
              suffix === undefined || path === undefined
                ? undefined
                : suffix.slice(path.length);
            pending.push({
              node: source.node,
              readsAtSelf: true,
              suffix:
                remaining === undefined
                  ? undefined
                  : [
                      ...source.projection.map((key) =>
                        key === null || typeof key === "object"
                          ? null
                          : String(key),
                      ),
                      ...remaining,
                    ],
            });
          }
        }
        if (
          t.isMetaProperty(root) &&
          root.meta.name === "import" &&
          root.property.name === "meta"
        ) {
          retain(["import-meta", ...(suffix ?? [])]);
          resolvedIdentity = true;
          continue;
        }
        if (t.isIdentifier(root)) {
          // The wrapper module object is distinct from globalThis.module. Keep
          // its identity through the same alias/projection owner used for writes.
          if (isUnshadowedGlobal(root, state, "module")) {
            retain(["commonjs-module", ...(suffix ?? [])]);
            resolvedIdentity = true;
            continue;
          }
          if (globalObjectName(root, state) !== undefined) {
            retain(["global", ...(suffix ?? [])]);
            resolvedIdentity = true;
            continue;
          }
          if (isUnshadowedGlobal(root, state, root.name)) {
            retain(["global", root.name, ...(suffix ?? [])]);
            resolvedIdentity = true;
            continue;
          }
          const binding = resolveSemanticBindingState(state, root, root.name);
          if (binding === undefined) continue;
          const stable = possibleWrites
            ? undefined
            : semanticStableInitializer(binding, state);
          const readAt = current.readsAtSelf ? root : capture;
          const atRead =
            possibleWrites && readAt !== undefined
              ? semanticBindingAtRead(binding, readAt, state.parentsByNode)
              : undefined;
          const selected = atRead?.binding ?? binding;
          if (possibleWrites && atRead?.hasDefiniteInitializer === false)
            unknownReasons.add("unresolved-value");
          for (const origin of selected.directOrigins)
            if (
              origin.resolutionMode === "require" &&
              origin.specifier === "ws"
            ) {
              retain([
                "commonjs-ws",
                ...origin.importedPath,
                ...(suffix ?? []),
              ]);
              resolvedIdentity = true;
            }
          const initializers = possibleWrites
            ? [...selected.initializers, ...selected.referenceInitializers]
            : stable === undefined
              ? []
              : [stable];
          for (const initializer of initializers) {
            if (semanticReferenceSourcesInactive(initializer, state)) continue;
            // Pattern assignments share the source selection owner with member
            // effects: copying a container preserves its children, not itself.
            const path = semanticCopiedReferencePath(
              initializer,
              suffix ?? [null],
              escapedContents ? "escape" : "identity",
            );
            if (path === null) continue;
            pending.push({
              node: initializer.node,
              readsAtSelf: true,
              suffix:
                suffix === undefined ||
                semanticReferenceIterationUnknown(initializer, state)
                  ? undefined
                  : path.map((key) =>
                      key === null || typeof key === "object"
                        ? null
                        : String(key),
                    ),
            });
          }
          continue;
        }
        if (
          possibleWrites &&
          t.isNewExpression(root) &&
          (suffix?.[0] === "__proto__" || suffix?.[0] === "constructor")
        ) {
          continueWith(
            root.callee,
            suffix[0] === "__proto__"
              ? ["prototype", ...suffix.slice(1)]
              : suffix.slice(1),
          );
          continue;
        }
        const prototypeTarget = possibleWrites
          ? facts?.prototypeTarget(root)
          : undefined;
        if (prototypeTarget !== undefined) {
          continueWith(
            prototypeTarget,
            suffix === undefined ? undefined : ["__proto__", ...suffix],
          );
          continue;
        }
        const required = semanticRequireOrigin(root, state)?.origin;
        if (required?.specifier === "ws") {
          retain(["commonjs-ws", ...required.importedPath, ...(suffix ?? [])]);
          resolvedIdentity = true;
          continue;
        }
        if (
          possibleWrites &&
          (t.isCallExpression(root) ||
            t.isOptionalCallExpression(root) ||
            t.isNewExpression(root) ||
            t.isTaggedTemplateExpression(root) ||
            (escapedContents && (t.isFunction(root) || t.isClass(root))))
        ) {
          continueReturned(
            t.isFunction(root) || t.isClass(root)
              ? root
              : t.isTaggedTemplateExpression(root)
                ? root.tag
                : root.callee,
            suffix,
          );
          continue;
        }
        if (possibleWrites && t.isConditionalExpression(root)) {
          continueWith(root.consequent);
          continueWith(root.alternate);
          continue;
        }
        if (possibleWrites && t.isLogicalExpression(root)) {
          continueWith(root.left);
          continueWith(root.right);
          continue;
        }
        if (possibleWrites && t.isSequenceExpression(root)) {
          const value = root.expressions.at(-1);
          if (value !== undefined) continueWith(value);
          continue;
        }
        if (
          possibleWrites &&
          t.isAssignmentExpression(root) &&
          root.operator === "="
        ) {
          continueWith(root.right);
          continue;
        }
        const key = suffix?.[0];
        // Container escapes reuse the finite worklist, including alias cycles.
        if (escapedContents && suffix?.length === 0) {
          if (t.isObjectExpression(root)) {
            for (const property of root.properties)
              if (t.isSpreadElement(property))
                // A fresh copy exposes selected children, not its source container.
                continueWith(property.argument, [null]);
              else if (
                t.isObjectProperty(property) &&
                t.isExpression(property.value)
              )
                continueWith(property.value, []);
              else if (t.isObjectMethod(property) && property.kind === "get")
                continueReturned(property, []);
            continue;
          }
          if (t.isArrayExpression(root)) {
            for (const element of root.elements)
              if (t.isSpreadElement(element))
                continueWith(element.argument, []);
              else if (t.isExpression(element)) continueWith(element, []);
            continue;
          }
        }
        if (suffix !== undefined && key === undefined) continue;
        if (t.isObjectExpression(root)) {
          if (possibleWrites) {
            for (const property of root.properties) {
              if (t.isSpreadElement(property)) continueWith(property.argument);
              else if (
                (t.isObjectProperty(property) &&
                  t.isExpression(property.value)) ||
                (t.isObjectMethod(property) && property.kind === "get")
              ) {
                const ownKey = semanticStaticPropertyKey(
                  property.key,
                  property.computed,
                );
                if (
                  suffix === undefined ||
                  key === null ||
                  ownKey === null ||
                  ownKey === key
                )
                  if (t.isObjectMethod(property))
                    continueReturned(property, suffix?.slice(1));
                  else if (t.isExpression(property.value))
                    continueWith(property.value, suffix?.slice(1));
              }
            }
          } else if (
            suffix !== undefined &&
            key !== null &&
            root.properties.every(
              (property) =>
                t.isObjectProperty(property) &&
                semanticStaticPropertyKey(property.key, property.computed) !==
                  null,
            )
          ) {
            const property = root.properties.findLast(
              (property) =>
                t.isObjectProperty(property) &&
                semanticStaticPropertyKey(property.key, property.computed) ===
                  key,
            );
            if (t.isObjectProperty(property) && t.isExpression(property.value))
              continueWith(property.value, suffix.slice(1));
          }
        } else if (t.isArrayExpression(root)) {
          if (suffix === undefined) {
            for (const element of root.elements)
              if (t.isSpreadElement(element)) continueWith(element.argument);
              else if (t.isExpression(element)) continueWith(element);
          } else if (!root.elements.some(t.isSpreadElement)) {
            const index = Number(key);
            if (key === null && possibleWrites) {
              for (const element of root.elements)
                if (t.isExpression(element))
                  continueWith(element, suffix.slice(1));
            } else if (
              key !== null &&
              Number.isInteger(index) &&
              index >= 0 &&
              String(index) === key
            ) {
              const element = root.elements[index];
              if (t.isExpression(element))
                continueWith(element, suffix.slice(1));
            }
          }
        }
      } finally {
        if (
          !resolvedIdentity &&
          pending.length === queuedBefore &&
          result.size === pathsBefore
        )
          unknownReasons.add("unresolved-value");
      }
    }
    const paths = [...result.values()];
    if (paths.length > 0 && hasLocalIdentity)
      unknownReasons.add("mixed-identities");
    const resolution: AmbientResolution = {
      paths,
      ownership:
        unknownReasons.size > 0
          ? "unknown"
          : paths.length > 0
            ? "ambient"
            : hasLocalIdentity
              ? "local"
              : "unknown",
      unknownReasons: [...unknownReasons],
    };
    if (!possibleWrites) cached.set(node, resolution);
    return resolution;
  };
};

/** These native operations do not pass their namespace receiver to user code. */
export const semanticAmbientCallKeepsReceiver = (
  path: readonly string[],
): boolean =>
  path[0] === "global" &&
  ((path.length === 3 && ["Object", "Reflect"].includes(path[1]!)) ||
    (path.length === 3 &&
      path[1] === "Promise" &&
      [
        "resolve",
        "reject",
        "all",
        "allSettled",
        "any",
        "race",
        "try",
        "withResolvers",
      ].includes(path[2]!)) ||
    (path.length === 3 && path[1] === "indexedDB" && path[2] === "open") ||
    (path.length === 3 &&
      ["localStorage", "sessionStorage"].includes(path[1]!) &&
      ["getItem", "setItem", "removeItem", "clear", "key"].includes(
        path[2]!,
      )) ||
    (path.length === 2 && ["open", "fetch"].includes(path[1]!)));

/**
 * Index source-local writes through ambient identities and stable aliases.
 * The shared invocation owner resolves intrinsic aliases, bind/call/apply and
 * literal argument spreads. Runtime reachability and arbitrary call effects
 * remain unevaluated; a visible possible write is sufficient.
 */
export function* indexJavaScriptAmbientWritesSteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  observeOpaqueInvocation?: (node: t.Node) => void,
  observeWriteSite?: (node: t.Node) => void,
): Generator<void> {
  const ambientReads = createAmbientPathResolver(state, false);
  const browserReceiverMethods = new Set<string>();
  const storedSites = new WeakSet<t.Node>();
  const storedReferences: SemanticIterationSource[] = [];
  const writes: { node: t.Node; path: AmbientPath }[] = [];
  const targets: { node: t.Node; capture: t.Node }[] = [];
  const escapes: {
    node: t.Node;
    target: t.Node;
    browserReceiver: boolean;
    receiver?: t.Node;
    projection?: AmbientProjection;
  }[] = [];
  const stores = new WeakMap<
    t.Node,
    Map<SemanticIterationSource, AmbientProjection>
  >();
  const interop = createSemanticModuleInterop(state, {
    intrinsicPath: (node) => {
      const [path] = ambientReads(node).paths;
      return path?.[0] === "global" && path.every((key) => key !== null)
        ? ["intrinsic", ...(path.slice(1) as readonly string[])]
        : undefined;
    },
  });
  const ambientWrites = createAmbientPathResolver(state, true, {
    stores,
    freshObject: interop.isFreshObject,
    prototypeTarget: (node) => {
      if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
        return undefined;
      const invocation = interop.intrinsicInvocation(node);
      if (
        invocation?.kind !== "known" ||
        invocation.path.length !== 3 ||
        !["Object", "Reflect"].includes(invocation.path[1] ?? "") ||
        invocation.path[2] !== "getPrototypeOf"
      )
        return undefined;
      const target = invocation.arguments?.[0];
      return t.isNode(target) && !t.isSpreadElement(target)
        ? target
        : undefined;
    },
  });
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    state.erasedSyntaxNodes,
    (root, kind, writeSite) => {
      if (kind === "opaque-call") return [];
      observeWriteSite?.(writeSite);
      // Reassigning a local alias changes the binding, not the referenced object.
      if (kind === "binding")
        return t.isIdentifier(root) &&
          isUnshadowedGlobal(root, state, root.name)
          ? [["global", root.name]]
          : [];
      if (!storedSites.has(writeSite)) {
        storedSites.add(writeSite);
        for (const source of semanticIterationSources(
          writeSite,
          state.parentsByNode.get(writeSite) ?? null,
        )) {
          if (source.kind === "reference-store") storedReferences.push(source);
        }
      }
      // Resolve identities after the traversal has collected every local store.
      const id = targets.push({ node: root, capture: writeSite }) - 1;
      return [["pending-target", String(id)]];
    },
    interop.intrinsicInvocation,
    interop.staticString,
    interop.isFreshObject,
    (node, path) => {
      writes.push({ node, path });
    },
    (node, invocation) => {
      observeOpaqueInvocation?.(node);
      // Escaping objects can change contents without replacing their identity.
      const retainEscape = (target: t.Node, browserReceiver = false) => {
        escapes.push({ target, node, browserReceiver });
      };
      for (const argument of t.isTaggedTemplateExpression(node)
        ? node.quasi.expressions
        : node.arguments)
        if (t.isNode(argument))
          retainEscape(
            t.isSpreadElement(argument) ? argument.argument : argument,
          );
      const callee = unwrapJavaScriptExpression(
        t.isTaggedTemplateExpression(node) ? node.tag : node.callee,
      ).node;
      const browserMethod =
        invocation?.kind === "known" &&
        invocation.path.length === 2 &&
        ["open", "fetch"].includes(invocation.path[1] ?? "")
          ? invocation.path[1]
          : undefined;
      if (
        !t.isNewExpression(node) &&
        (t.isMemberExpression(callee) ||
          t.isOptionalMemberExpression(callee)) &&
        !(
          invocation?.kind === "known" &&
          ["Object", "Reflect"].includes(invocation.path[1] ?? "")
        )
      ) {
        if (browserMethod !== undefined)
          browserReceiverMethods.add(browserMethod);
        escapes.push({
          target: callee.object,
          node,
          browserReceiver: browserMethod !== undefined,
          receiver: callee,
        });
      }
    },
  );
  const pendingStores = new Set(storedReferences);
  const dependents = new WeakMap<t.Node, Set<SemanticIterationSource>>();
  while (pendingStores.size > 0) {
    const source = pendingStores.values().next().value;
    if (source === undefined) break;
    pendingStores.delete(source);
    if (source.target === undefined) continue;
    const identities = new Map<t.Node, AmbientProjection>();
    ambientWrites(source.target, source.mutation, false, [], (node, path) => {
      const users = dependents.get(node) ?? new Set<SemanticIterationSource>();
      users.add(source);
      dependents.set(node, users);
      identities.set(
        node,
        identities.has(node)
          ? joinAmbientProjection(identities.get(node), path)
          : path,
      );
    });
    // Publish only completed queries; each source/root projection can only widen.
    for (const [node, path] of identities) {
      const entries =
        stores.get(node) ??
        new Map<SemanticIterationSource, AmbientProjection>();
      const previous = entries.get(source);
      const joined = entries.has(source)
        ? joinAmbientProjection(previous, path)
        : path;
      if (
        entries.has(source) &&
        (previous === undefined ||
          (joined !== undefined &&
            previous.every((key, index) => key === joined[index])))
      )
        continue;
      entries.set(source, joined);
      stores.set(node, entries);
      for (const dependent of dependents.get(node) ?? [])
        pendingStores.add(dependent);
    }
    yield;
  }
  for (const source of storedReferences) {
    if (source.target === undefined) continue;
    const receiver = ambientWrites(source.target.object, source.mutation);
    if (receiver.ownership !== "local") {
      state.escapingReferenceStores.add(source.target);
      escapes.push({
        node: source.mutation,
        target: source.node,
        browserReceiver: false,
        projection: source.projection.map((key) =>
          key === null || typeof key === "object" ? null : String(key),
        ),
      });
    }
  }
  for (const { node, path } of writes) {
    const target =
      path[0] === "pending-target" ? targets[Number(path[1])] : undefined;
    const paths =
      target === undefined
        ? [path]
        : ambientWrites(target.node, target.capture).paths.map((identity) => [
            ...identity,
            ...path.slice(2),
          ]);
    for (const resolved of paths) {
      retainSemanticAmbientEffect(state, "write", resolved, node);
    }
  }
  // Explicit exposure is known before deciding which native receiver calls
  // remain intact. Preserve the invocation capture when checking those calls.
  const orderedEscapes = [
    ...escapes.filter(({ receiver }) => receiver === undefined),
    ...escapes.filter(({ receiver }) => receiver !== undefined),
  ];
  for (const {
    node,
    target,
    browserReceiver,
    projection,
    receiver,
  } of orderedEscapes) {
    if (receiver !== undefined) {
      const resolved = ambientReads(receiver);
      const [selected] = resolved.paths;
      if (
        resolved.ownership === "ambient" &&
        selected?.every((key): key is string => key !== null) &&
        semanticAmbientCallKeepsReceiver(selected) &&
        !createSemanticAmbientModificationQuery(state, receiver)(selected)
      )
        continue;
    }
    for (const path of ambientWrites(target, node, true, projection).paths)
      // Only proven browser APIs keep their global receiver from user code.
      if (!(browserReceiver && path.length === 1 && path[0] === "global")) {
        retainSemanticAmbientEffect(state, "escape", path, node);
      }
  }
  // A function may call a browser method replaced later in source order.
  if (
    [...browserReceiverMethods].some((method) =>
      state.ambientWrites.covers(["global", method]),
    )
  ) {
    retainSemanticAmbientEffect(state, "escape", ["global"], undefined);
  }
}

/** One capture query shares activation proofs across its selected ambient paths. */
export const createSemanticAmbientModificationQuery = (
  state: JavaScriptSemanticAnalysisState,
  capture: t.Node,
): ((selected: readonly string[]) => boolean) => {
  let singleCapture: readonly SemanticExecutionFrame[] | null | undefined;
  const singleCaptureFrames = () => {
    if (singleCapture === undefined) {
      const frames = webSocketExecutionContexts(capture, state);
      singleCapture = semanticCaptureActivationIsSingle(frames, state)
        ? frames
        : null;
    }
    return singleCapture;
  };
  // Escaping an ambient receiver lets user code replace any selected member.
  // A constructor already captured before that escape keeps its identity.
  return (selected: readonly string[]): boolean =>
    state.ambientWrites.covers(selected) ||
    (state.ambientEscapes.covers(selected) &&
      state.ambientReferenceEffects.some(
        ({ path, node, kind }) =>
          kind === "escape" &&
          path.length <= selected.length &&
          path.every((key, index) =>
            semanticPropertyPathKeyMatches(key, selected[index] ?? ""),
          ) &&
          // Selecting this invocation's callee precedes its receiver escape,
          // including when the invocation is inside a deferred function.
          !(
            (t.isCallExpression(node) ||
              t.isOptionalCallExpression(node) ||
              t.isNewExpression(node)) &&
            unwrapJavaScriptExpression(node.callee).node === capture
          ) &&
          !semanticEffectFollowsReference(capture, node, state.parentsByNode) &&
          !(
            node !== undefined &&
            singleCaptureFrames() !== null &&
            semanticInitializerPrecedesRead({
              initializer: capture,
              read: node,
              parents: state.parentsByNode,
              initializerContexts: singleCaptureFrames() ?? [],
              readContexts: webSocketExecutionContexts(node, state),
            }) === true
          ),
      ));
};

/**
 * Recognize an ambient property path, optionally through a global object, without a visible
 * source-local overwrite or unordered receiver escape. This is a syntax-local identity fact, not proof that
 * the runtime's globals have never been patched by other code.
 */
export const isUnmodifiedGlobalReference = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  name: string | readonly [string, ...string[]],
  projection: readonly string[] = [],
  capture: t.Node = callee,
): boolean => {
  const path: readonly [string, ...string[]] =
    typeof name === "string" ? [name] : name;
  const modified = createSemanticAmbientModificationQuery(state, capture);
  if (modified(["global", ...path])) return false;
  const { root, members } = electronMemberPath(callee);
  const selected = [...members, ...projection];
  const matches = (expected: readonly string[], actual = selected) =>
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
  if (isUnshadowedGlobal(root, state, path[0]) && matches(path.slice(1)))
    return true;
  const namespace = globalObjectName(root, state);
  let selfReferencesUnmodified = true;
  const canonical = canonicalAmbientPath(["global", ...selected], (name) => {
    if (modified(["global", name])) selfReferencesUnmodified = false;
  });
  return (
    namespace !== undefined &&
    selfReferencesUnmodified &&
    matches(path, canonical.slice(1)) &&
    !modified(["global", namespace])
  );
};

/** Keep selected CommonJS exports separate from earlier captured constructors. */
export const isUnmodifiedRequiredWebSocketReference = (
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  projection: readonly string[],
): boolean => {
  const selected = ["commonjs-ws", ...projection];
  if (
    !state.ambientWrites.covers(selected) &&
    !state.ambientEscapes.covers(selected)
  )
    return true;
  return !state.ambientReferenceEffects.some(
    ({ path, node }) =>
      path.length <= selected.length &&
      path.every((key, index) =>
        semanticPropertyPathKeyMatches(key, selected[index] ?? ""),
      ) &&
      !semanticTopLevelEffectFollowsCapture(capture, node, state.parentsByNode),
  );
};

/** A module URL base is known only while its property has no visible write. */
export const isUnmodifiedImportMetaUrl = (
  node: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  isImportMetaUrl(node) && !state.ambientWrites.covers(["import-meta", "url"]);
