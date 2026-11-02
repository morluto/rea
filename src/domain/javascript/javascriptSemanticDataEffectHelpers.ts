import * as t from "@babel/types";

import { BUILTIN_RESOURCE_METHODS } from "./javascriptBuiltinResourceMethods.js";
import { semanticBuiltinNamespacePath } from "./javascriptSemanticProvenance.js";
import {
  semanticRequireOrigin,
  semanticRequireExportsIdentity,
  semanticGlobalProcessOrigin,
  semanticGlobalProcessPathOrigin,
  semanticMutableBuiltinOrigin,
} from "./javascriptSemanticRequireOrigin.js";
import type {
  JavaScriptModuleOrigin,
  JavaScriptSemanticProjectedResultBinding,
} from "./javascriptSemanticIr.js";
import {
  evaluateSemanticProvenance,
  evaluateSemanticProvenanceAtRead,
} from "./javascriptSemanticValues.js";
import {
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";

import { semanticCallableIdForNode } from "./javascriptSemanticProjection.js";
import {
  semanticBindingAtRead,
  semanticTopLevelEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import { createSemanticCallableIdStack } from "./javascriptSemanticCallableStack.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticMemberEffect,
  type JavaScriptSemanticRequiredModuleEffect,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptValueAst } from "./javascriptSemanticTraversal.js";
import {
  readExactJavaScriptLiteral,
  semanticMemberChain,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

export interface SemanticProjectedBinding extends JavaScriptSemanticProjectedResultBinding {
  readonly identifier: t.Identifier;
}

/** Resolve bindings written by the nearest variable or assignment owner. */
export const assignedSemanticResultBindings = (
  node: t.Node,
  ancestors: readonly t.Node[],
  state: JavaScriptSemanticAnalysisState,
): SemanticProjectedBinding[] => {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const owner = ancestors[index];
    if (owner === undefined) continue;
    let pattern: t.Node | undefined;
    let source: t.Node | null = null;
    if (t.isVariableDeclarator(owner)) {
      pattern = owner.id;
      source = owner.init ?? null;
    } else if (t.isAssignmentExpression(owner, { operator: "=" })) {
      pattern = owner.left;
      source = owner.right;
    }
    if (
      pattern !== undefined &&
      source !== null &&
      assignedSourceIs(node, source)
    )
      return projectedPatternBindings(pattern, state);
    if (semanticCallableIdForNode(owner) !== null) return [];
  }
  return [];
};

const assignedSourceIs = (node: t.Node, source: t.Node): boolean => {
  let value = source;
  while (true) {
    if (t.isAwaitExpression(value)) value = value.argument;
    else {
      const unwrapped = unwrapJavaScriptExpression(value).node;
      if (unwrapped === value) break;
      value = unwrapped;
    }
  }
  return value === node;
};

const projectedPatternBindings = (
  pattern: t.Node,
  state: JavaScriptSemanticAnalysisState,
): SemanticProjectedBinding[] => {
  const output: SemanticProjectedBinding[] = [];
  const visit = (
    current: t.Node,
    path: readonly (string | number | null)[],
    partial: boolean,
  ): void => {
    if (t.isIdentifier(current)) {
      const binding = resolveSemanticBindingState(state, current, current.name);
      if (binding !== undefined)
        output.push({
          bindingId: binding.bindingId,
          identifier: current,
          projectionPath: path,
          resolution: partial ? "partial" : "complete",
        });
      return;
    }
    if (t.isAssignmentPattern(current)) return visit(current.left, path, true);
    if (t.isRestElement(current))
      return visit(current.argument, [...path, null], true);
    if (t.isObjectPattern(current)) {
      for (const property of current.properties) {
        if (t.isRestElement(property))
          visit(property.argument, [...path, null], true);
        else
          visit(
            property.value,
            [
              ...path,
              semanticStaticPropertyKey(property.key, property.computed),
            ],
            partial ||
              semanticStaticPropertyKey(property.key, property.computed) ===
                null,
          );
      }
    } else if (t.isArrayPattern(current)) {
      current.elements.forEach((element, index) => {
        if (element !== null) visit(element, [...path, index], partial);
      });
    }
  };
  visit(pattern, [], false);
  return output;
};

export const semanticProjectedBindingFacts = (
  bindings: readonly SemanticProjectedBinding[],
): JavaScriptSemanticProjectedResultBinding[] =>
  bindings.map(({ identifier: _identifier, ...fact }) => fact);

/** Return a scalar owner only for an unprojected identifier result. */
export const scalarAssignedResultBinding = (
  bindings: readonly SemanticProjectedBinding[],
): string | null =>
  bindings.length === 1 && bindings[0]?.projectionPath.length === 0
    ? (bindings[0]?.bindingId ?? null)
    : null;

/** Shared mutable stacks reset before each deterministic data-effect pass. */
export interface DataEffectTraversalContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly callableIds: ReadonlySet<string>;
  readonly callableStack: string[];
  readonly ancestors: t.Node[];
}

/** Resolve built-in methods from the shared, unambiguous binding provenance. */
export const builtinDataEffectMethod = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  specifiers: readonly string[],
): string | null => {
  const path = builtinDataEffectCallablePath(callee, state, specifiers);
  return path?.length === 1 ? (path[0] ?? null) : null;
};

/** Recover the complete callable export path using the shared mutation proof. */
export const builtinDataEffectCallablePath = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  specifiers: readonly string[],
): readonly string[] | null => {
  const expression = unwrapJavaScriptExpression(callee).node;
  if (expression !== callee)
    return builtinDataEffectCallablePath(expression, state, specifiers);
  if (t.isSequenceExpression(expression)) {
    const final = expression.expressions.at(-1);
    return final === undefined
      ? null
      : builtinDataEffectCallablePath(final, state, specifiers);
  }
  const required = semanticRequireOrigin(callee, state);
  if (required !== undefined) {
    const origin = builtinNamespaceOrigin(required.origin);
    return specifiers.some(
      (specifier) => specifier.replace(/^node:/u, "") === origin.specifier,
    ) &&
      !requiredModuleChanged(
        required.origin.specifier,
        required.origin.importedPath,
        callee,
        state,
        true,
      )
      ? origin.importedPath
      : null;
  }
  if (t.isIdentifier(callee)) {
    const binding = resolveSemanticBindingState(state, callee, callee.name);
    const path = builtinBindingPath(
      binding,
      state,
      specifiers,
      callee,
      [],
      true,
    );
    return path;
  }
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return null;
  if (!t.isIdentifier(callee.object)) {
    const method = semanticStaticPropertyKey(callee.property, callee.computed);
    const receiver = semanticBoundMemberPath(callee.object, state);
    if (method !== null && receiver !== undefined) {
      const provenance = evaluateSemanticProvenanceAtRead(
        receiver.binding,
        receiver.identifier,
        state,
      );
      if (provenance.status === "module") {
        const origin = builtinNamespaceOrigin({
          ...provenance.origins[0],
          importedPath: [
            ...provenance.origins[0].importedPath,
            ...receiver.path,
          ],
        });
        if (
          specifiers.some(
            (specifier) =>
              specifier.replace(/^node:/u, "") === origin.specifier,
          )
        )
          return builtinBindingPath(
            receiver.binding,
            state,
            specifiers,
            callee,
            [...receiver.path, method],
            true,
          ) !== null
            ? [...origin.importedPath, method]
            : null;
      }
    }
    const source = semanticExpressionModuleOrigin(callee.object, state);
    if (method === null || source === undefined) return null;
    const origin = builtinNamespaceOrigin(source);
    return specifiers.some(
      (specifier) => specifier.replace(/^node:/u, "") === origin.specifier,
    ) &&
      !requiredModuleChanged(
        origin.specifier,
        [...source.importedPath, method],
        callee,
        state,
        true,
        callee.object,
      )
      ? [...origin.importedPath, method]
      : null;
  }
  const binding = resolveSemanticBindingState(
    state,
    callee.object,
    callee.object.name,
  );
  const method = semanticStaticPropertyKey(callee.property, callee.computed);
  if (method === null) return null;
  const resolvedPath = builtinBindingPath(
    binding,
    state,
    specifiers,
    callee,
    [method],
    true,
  );
  if (resolvedPath !== null) return [...resolvedPath, method];
  const initializer = binding?.initializers[0];
  if (
    initializer === undefined ||
    binding?.initializers.length !== 1 ||
    (!t.isMemberExpression(initializer.node) &&
      !t.isOptionalMemberExpression(initializer.node))
  ) {
    return null;
  }
  const provenance = evaluateSemanticProvenance(binding, state);
  if (provenance.status !== "module") return null;
  const origin = builtinNamespaceOrigin(provenance.origins[0]);
  const selected = [...origin.importedPath, method];
  return specifiers.some(
    (specifier) => specifier.replace(/^node:/u, "") === origin.specifier,
  ) &&
    builtinBindingPath(
      binding,
      state,
      specifiers,
      initializer.node,
      [method],
      true,
    )?.length === 0 &&
    !requiredModuleChanged(
      origin.specifier,
      selected,
      callee,
      state,
      true,
      initializer.node,
    )
    ? [method]
    : null;
};

const semanticBoundMemberPath = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
):
  | {
      readonly binding: JavaScriptSemanticBindingState;
      readonly identifier: t.Identifier;
      readonly path: string[];
    }
  | undefined => {
  const chain = semanticMemberChain(node);
  if (chain === undefined || !t.isIdentifier(chain.root)) return undefined;
  const binding = resolveSemanticBindingState(
    state,
    chain.root,
    chain.root.name,
  );
  return binding === undefined
    ? undefined
    : { binding, identifier: chain.root, path: chain.members };
};

type BuiltinBindingMemo = Map<t.Node, Map<string, readonly string[] | null>>;

const builtinBindingPath = (
  binding: JavaScriptSemanticBindingState | undefined,
  state: JavaScriptSemanticAnalysisState,
  specifiers: readonly string[],
  capture: t.Node,
  selectedPath: readonly (string | null)[] = [],
  callableValue = false,
  visited: ReadonlySet<string> = new Set(),
  memo: BuiltinBindingMemo = new Map(),
  provenanceCapture?: t.Identifier,
  savedObjectCapture?: t.Node,
): readonly string[] | null => {
  if (binding === undefined) return null;
  if (provenanceCapture === undefined) {
    const read = semanticBoundMemberPath(capture, state);
    if (read?.binding === binding) provenanceCapture = read.identifier;
  }
  const key = JSON.stringify([
    binding.bindingId,
    selectedPath,
    callableValue,
    provenanceCapture?.start,
    provenanceCapture?.end,
    savedObjectCapture?.start,
    savedObjectCapture?.end,
  ]);
  let captured = memo.get(capture);
  if (captured?.has(key)) return captured.get(key) ?? null;
  if (visited.has(binding.bindingId)) return null;
  if (captured === undefined) {
    captured = new Map();
    memo.set(capture, captured);
  }
  const result = computeBuiltinBindingPath(
    binding,
    state,
    specifiers,
    capture,
    selectedPath,
    callableValue,
    visited,
    memo,
    provenanceCapture,
    savedObjectCapture,
  );
  captured.set(key, result);
  return result;
};

const computeBuiltinBindingPath = (
  binding: JavaScriptSemanticBindingState | undefined,
  state: JavaScriptSemanticAnalysisState,
  specifiers: readonly string[],
  capture: t.Node,
  selectedPath: readonly (string | null)[] = [],
  callableValue = false,
  visited: ReadonlySet<string>,
  memo: BuiltinBindingMemo,
  provenanceCapture?: t.Identifier,
  savedObjectCapture?: t.Node,
): readonly string[] | null => {
  if (binding === undefined || visited.has(binding.bindingId)) return null;
  // Provenance identifies the module, independently of whether a selected slot
  // still refers to its original built-in after member mutation or escape.
  if (
    binding.memberWrites.some(
      ({ path, node }) =>
        affectsBuiltinPath(path, selectedPath) &&
        !(
          semanticTopLevelEffectFollowsCapture(
            path.length === 0 && provenanceCapture !== undefined
              ? provenanceCapture
              : capture,
            node,
            state.parentsByNode,
          ) ||
          (savedObjectCapture !== undefined &&
            path.length < selectedPath.length &&
            semanticTopLevelEffectFollowsCapture(
              savedObjectCapture,
              node,
              state.parentsByNode,
            ))
        ),
    ) ||
    builtinEscapes(binding, state).some(
      ({ path, node }) =>
        affectsBuiltinPath(path, selectedPath) &&
        // A known function or scalar escape cannot replace its selected slot.
        // A wildcard may expose an object and must retain that uncertainty.
        (!callableValue ||
          path.length < selectedPath.length ||
          path.includes(null)) &&
        !semanticTopLevelEffectFollowsCapture(
          capture,
          node,
          state.parentsByNode,
        ),
    )
  )
    return null;
  const provenance =
    provenanceCapture === undefined
      ? evaluateSemanticProvenance(binding, state)
      : evaluateSemanticProvenanceAtRead(binding, provenanceCapture, state);
  if (provenance.status !== "module") return null;
  const { importedPath } = provenance.origins[0];
  const namespace = builtinNamespaceOrigin(provenance.origins[0]);
  if (
    !specifiers.some((item) => {
      const name = item.replace(/^node:/u, "");
      return (
        name === namespace.specifier ||
        (namespace.specifier === "fs" &&
          selectedPath[0] === "promises" &&
          name === "fs/promises")
      );
    })
  )
    return null;
  let resolvedPath: readonly string[] = importedPath;
  for (const origin of binding.directOrigins) {
    const shared = semanticMutableBuiltinOrigin(origin, selectedPath);
    if (
      shared !== undefined &&
      requiredModuleChanged(
        shared.specifier,
        shared.path,
        capture,
        state,
        callableValue,
      )
    )
      return null;
  }
  const ancestors = new Set([...visited, binding.bindingId]);
  const initializers =
    provenanceCapture === undefined
      ? binding.initializers
      : semanticBindingAtRead(binding, provenanceCapture, state.parentsByNode)
          .binding.initializers;
  for (const initializer of initializers) {
    const pending = [
      {
        node: initializer.node,
        path: [...initializer.projection.map(String), ...selectedPath],
        savedObjectCapture:
          selectedPath.length > 0 &&
          (initializer.projection.length > 0 ||
            t.isMemberExpression(initializer.node) ||
            t.isOptionalMemberExpression(initializer.node))
            ? initializer.node
            : savedObjectCapture,
        capture:
          callableValue &&
          selectedPath.length === 0 &&
          initializer.projection.length > 0
            ? initializer.node
            : capture,
      },
    ];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const node = unwrapJavaScriptExpression(current.node).node;
      if (t.isIdentifier(node)) {
        const source = resolveSemanticBindingState(state, node, node.name);
        const sourcePath = builtinBindingPath(
          source,
          state,
          specifiers,
          current.capture,
          current.path,
          callableValue,
          ancestors,
          memo,
          node,
          current.savedObjectCapture,
        );
        if (sourcePath === null) return null;
        // Normalize ESM default namespaces at their owner before projecting an alias.
        const projected = [...sourcePath, ...current.path].slice(
          0,
          sourcePath.length + current.path.length - selectedPath.length,
        );
        if (!projected.every((key): key is string => key !== null)) return null;
        resolvedPath = projected;
      } else if (
        t.isMemberExpression(node) ||
        t.isOptionalMemberExpression(node)
      ) {
        const key = semanticStaticPropertyKey(node.property, node.computed);
        if (key === null) return null;
        pending.push({
          node: node.object,
          path: [key, ...current.path],
          savedObjectCapture: current.savedObjectCapture,
          // Freeze a selected function, not later member reads through a saved object.
          capture:
            callableValue && selectedPath.length === 0 ? node : current.capture,
        });
      } else if (t.isSequenceExpression(node)) {
        const final = node.expressions.at(-1);
        if (final === undefined) return null;
        pending.push({ ...current, node: final });
      } else if (t.isAssignmentExpression(node) && node.operator === "=") {
        pending.push({ ...current, node: node.right });
      } else if (t.isConditionalExpression(node)) {
        pending.push(
          { ...current, node: node.consequent },
          { ...current, node: node.alternate },
        );
      } else if (t.isLogicalExpression(node)) {
        pending.push(
          { ...current, node: node.left },
          { ...current, node: node.right },
        );
      } else {
        const required = semanticRequireOrigin(node, state);
        if (
          required !== undefined &&
          requiredModuleChanged(
            required.origin.specifier,
            [...required.origin.importedPath, ...current.path],
            current.capture,
            state,
            callableValue,
            current.savedObjectCapture,
          )
        )
          return null;
      }
    }
  }
  // Only a direct ESM default import denotes the built-in namespace;
  // require("node:fs").default is a literal property, not interop syntax.
  return binding.directOrigins.length > 0 &&
    semanticBuiltinNamespacePath(importedPath)
    ? []
    : builtinNamespaceOrigin({
        ...provenance.origins[0],
        importedPath: resolvedPath,
      }).importedPath;
};

/** Interpret known Node namespace aliases without changing source provenance. */
const builtinNamespaceOrigin = (
  origin: JavaScriptModuleOrigin,
): JavaScriptModuleOrigin => {
  const specifier = origin.specifier.replace(/^node:/u, "");
  const importedPath =
    origin.resolutionMode !== "require" && origin.importedPath[0] === "default"
      ? origin.importedPath.slice(1)
      : origin.importedPath;
  return specifier === "fs" && importedPath[0] === "promises"
    ? {
        ...origin,
        specifier: "fs/promises",
        importedPath: importedPath.slice(1),
      }
    : { ...origin, specifier, importedPath };
};

const affectsBuiltinPath = (
  path: JavaScriptSemanticPropertyPath,
  selected: readonly (string | null)[],
): boolean =>
  path.length <= selected.length &&
  path.every(
    (key, index) =>
      selected[index] === null ||
      semanticPropertyPathKeyMatches(key, selected[index]!),
  );

// These native filesystem methods operate on files/handles, not their exports
// receiver. Keep the async/sync families together for validity checks.
const FS_RECEIVER_METHODS = [
  "access",
  "appendFile",
  "chmod",
  "chown",
  "copyFile",
  "cp",
  "fchmod",
  "fchown",
  "fdatasync",
  "fstat",
  "fsync",
  "ftruncate",
  "futimes",
  "glob",
  "lchmod",
  "lchown",
  "link",
  "lstat",
  "lutimes",
  "mkdir",
  "mkdtemp",
  "open",
  "opendir",
  "read",
  "readdir",
  "readFile",
  "readlink",
  "readv",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "statfs",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "write",
  "writeFile",
  "writev",
  "close",
];

const BUILTIN_RECEIVER_METHODS: Readonly<Record<string, ReadonlySet<string>>> =
  {
    path: new Set(["resolve", "join", "dirname"]),
    "path/posix": new Set(["resolve", "join", "dirname"]),
    url: new Set(["fileURLToPath"]),
    fs: new Set([
      ...FS_RECEIVER_METHODS.flatMap((method) => [method, `${method}Sync`]),
      "existsSync",
      "exists",
      "mkdtempDisposableSync",
      "openAsBlob",
      "watch",
      "watchFile",
      "unwatchFile",
      ...BUILTIN_RESOURCE_METHODS.fs,
    ]),
    "fs/promises": new Set([
      "access",
      "appendFile",
      "chmod",
      "chown",
      "copyFile",
      "cp",
      "glob",
      "lchmod",
      "lchown",
      "link",
      "lstat",
      "lutimes",
      "mkdir",
      "mkdtemp",
      "mkdtempDisposable",
      "opendir",
      "readdir",
      "readFile",
      "readlink",
      "realpath",
      "rename",
      "rm",
      "rmdir",
      "stat",
      "statfs",
      "symlink",
      "truncate",
      "unlink",
      "utimes",
      "writeFile",
      "watch",
      ...BUILTIN_RESOURCE_METHODS["fs/promises"],
    ]),
    net: new Set(BUILTIN_RESOURCE_METHODS.net),
    tls: new Set(BUILTIN_RESOURCE_METHODS.tls),
    http: new Set(["request", "get"]),
    https: new Set(["request", "get"]),
    child_process: new Set([
      "spawn",
      "spawnSync",
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "fork",
    ]),
    process: new Set(["cwd", "uptime", "hrtime", "nextTick"]),
    timers: new Set([
      "setTimeout",
      "setInterval",
      "setImmediate",
      "clearTimeout",
      "clearInterval",
      "clearImmediate",
    ]),
  };

interface BuiltinEffectIndex {
  readonly writesByModule: Map<
    string,
    readonly JavaScriptSemanticRequiredModuleEffect[]
  >;
  readonly moduleEffects: Map<
    string,
    readonly JavaScriptSemanticRequiredModuleEffect[]
  >;
  readonly bindingEscapes: Map<
    string,
    readonly JavaScriptSemanticMemberEffect[]
  >;
  readonly receivers: WeakMap<t.Node, boolean>;
}

// Derived passes run after mutation collection. These indexes share that state's
// lifetime and never cache facts while its mutation owner is still producing them.
const builtinEffectIndexes = new WeakMap<
  JavaScriptSemanticAnalysisState,
  BuiltinEffectIndex
>();

const builtinEffectIndex = (
  state: JavaScriptSemanticAnalysisState,
): BuiltinEffectIndex => {
  let index = builtinEffectIndexes.get(state);
  if (index === undefined) {
    index = {
      writesByModule: new Map(
        [...state.requiredModuleEffects].map(([name, effects]) => [
          name,
          effects.filter(({ kind }) => kind === "write"),
        ]),
      ),
      moduleEffects: new Map(),
      bindingEscapes: new Map(),
      receivers: new WeakMap(),
    };
    builtinEffectIndexes.set(state, index);
  }
  return index;
};

const builtinEscapes = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): readonly JavaScriptSemanticMemberEffect[] => {
  const cache = builtinEffectIndex(state).bindingEscapes;
  let effects = cache.get(binding.bindingId);
  if (effects === undefined) {
    effects = binding.escapedPaths.filter(
      ({ node }) => !originalBuiltinReceiver(node, state),
    );
    cache.set(binding.bindingId, effects);
  }
  return effects;
};

const builtinModuleEffects = (
  specifier: string,
  state: JavaScriptSemanticAnalysisState,
  collecting = false,
): readonly JavaScriptSemanticRequiredModuleEffect[] => {
  const cache = collecting
    ? undefined
    : builtinEffectIndex(state).moduleEffects;
  const original = (node: t.Node | undefined) =>
    collecting
      ? computeOriginalBuiltinReceiver(node, state, true)
      : originalBuiltinReceiver(node, state);
  let effects = cache?.get(specifier);
  if (effects === undefined) {
    effects = (state.requiredModuleEffects.get(specifier) ?? []).filter(
      ({ kind, node }) => kind === "write" || !original(node),
    );
    if (specifier === "fs/promises") {
      const sharedFsEscapes = (state.requiredModuleEffects.get("fs") ?? [])
        .filter(
          ({ kind, path, node }) =>
            kind === "escape" &&
            (path.length === 0 || path[0] === "promises") &&
            !original(node),
        )
        .map((effect) => ({
          ...effect,
          path:
            effect.path[0] === "promises" ? effect.path.slice(1) : effect.path,
        }));
      effects = [...effects, ...sharedFsEscapes];
    }
    cache?.set(specifier, effects);
  }
  return effects;
};

/** Check shared exports at the use or method-capture point, not at every later call. */
const requiredModuleChanged = (
  specifier: string,
  selected: readonly (string | null)[],
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  callableValue = false,
  savedObjectCapture?: t.Node,
): boolean => {
  const identity = semanticRequireExportsIdentity(specifier, selected);
  const changed = (
    effects: readonly JavaScriptSemanticRequiredModuleEffect[],
    selection: readonly (string | null)[],
  ): boolean =>
    effects.some(
      ({ path, node, kind }) =>
        !(
          kind === "write" &&
          savedObjectCapture !== undefined &&
          path.length < selection.length &&
          semanticTopLevelEffectFollowsCapture(
            savedObjectCapture,
            node,
            state.parentsByNode,
          )
        ) &&
        affectsBuiltinPath(path, selection) &&
        !semanticTopLevelEffectFollowsCapture(
          capture,
          node,
          state.parentsByNode,
        ) &&
        (kind === "write" ||
          !callableValue ||
          path.length < selection.length ||
          path.includes(null)),
    );
  return (
    changed(builtinModuleEffects(identity.specifier, state), identity.path) ||
    (specifier.replace(/^node:/u, "") === "fs" &&
      selected[0] === "promises" &&
      selected.length > 1 &&
      changed(
        builtinModuleEffects("fs", state).filter(
          ({ kind, path }) => kind === "write" && path.length <= 1,
        ),
        selected,
      ))
  );
};

/** Calling an unchanged built-in as a member is not an escape to unknown code. */
const originalBuiltinReceiver = (
  node: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (node === undefined) return false;
  const receivers = builtinEffectIndex(state).receivers;
  const previous = receivers.get(node);
  if (previous !== undefined) return previous;
  const result = computeOriginalBuiltinReceiver(node, state);
  receivers.set(node, result);
  return result;
};

const computeOriginalBuiltinReceiver = (
  node: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
  collecting = false,
): boolean => {
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
    return false;
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return false;
  const receiver = t.isIdentifier(callee.object)
    ? resolveSemanticBindingState(state, callee.object, callee.object.name)
    : undefined;
  const provenance =
    receiver === undefined || !t.isIdentifier(callee.object)
      ? undefined
      : evaluateSemanticProvenanceAtRead(receiver, callee.object, state);
  const sourceOrigin =
    provenance?.status === "module"
      ? provenance.origins[0]
      : (semanticExpressionModuleOrigin(callee.object, state) ??
        semanticRequireOrigin(callee.object, state)?.origin ??
        semanticGlobalProcessOrigin(callee.object, state) ??
        semanticGlobalProcessPathOrigin(callee.object, state));
  if (sourceOrigin === undefined) return false;
  const origin = builtinNamespaceOrigin(sourceOrigin);
  const posixReceiver =
    origin.specifier === "path" &&
    origin.importedPath.length === 1 &&
    origin.importedPath[0] === "posix";
  if (origin.importedPath.length !== 0 && !posixReceiver) return false;
  const method = semanticStaticPropertyKey(callee.property, callee.computed);
  const identity = semanticRequireExportsIdentity(origin.specifier, [
    ...origin.importedPath,
    method ?? "",
  ]);
  if (
    method === null ||
    !BUILTIN_RECEIVER_METHODS[
      posixReceiver ? "path/posix" : origin.specifier
    ]?.has(method) ||
    receiver?.memberWrites.some(
      ({ path, node: write }) =>
        affectsBuiltinPath(path, [method]) &&
        !semanticTopLevelEffectFollowsCapture(node, write, state.parentsByNode),
    ) ||
    (collecting
      ? (state.requiredModuleEffects.get(identity.specifier) ?? []).filter(
          ({ kind }) => kind === "write",
        )
      : (builtinEffectIndex(state).writesByModule.get(identity.specifier) ?? [])
    ).some(
      ({ path, node: write }) =>
        affectsBuiltinPath(path, identity.path) &&
        !semanticTopLevelEffectFollowsCapture(node, write, state.parentsByNode),
    )
  )
    return false;
  return !node.arguments.some((argument) => {
    if (!t.isIdentifier(argument)) return false;
    const passed = resolveSemanticBindingState(state, argument, argument.name);
    if (passed === undefined) return false;
    const passedOrigin = evaluateSemanticProvenance(passed, state);
    return (
      passedOrigin.status === "module" &&
      builtinNamespaceOrigin(passedOrigin.origins[0]).specifier ===
        origin.specifier &&
      builtinNamespaceOrigin(passedOrigin.origins[0]).importedPath.length === 0
    );
  });
};

/** Known native data slots do not dispatch inherited setters. */
export const semanticBuiltinDataProperty = (
  source: JavaScriptModuleOrigin,
  method: string,
): boolean => {
  const origin = builtinNamespaceOrigin(source);
  return (
    origin.importedPath.length === 0 &&
    ((BUILTIN_RECEIVER_METHODS[origin.specifier]?.has(method) ?? false) ||
      (origin.specifier === "process" && ["env", "argv"].includes(method)))
  );
};

/** Live descriptor proof for mutation collection; never cache unfinished facts. */
export const semanticBuiltinSlotChanged = (
  source: JavaScriptModuleOrigin,
  method: string,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const origin = builtinNamespaceOrigin(source);
  const identity = semanticRequireExportsIdentity(origin.specifier, [
    ...origin.importedPath,
    method,
  ]);
  return builtinModuleEffects(identity.specifier, state, true).some(
    ({ path, node }) =>
      node !== capture &&
      affectsBuiltinPath(path, identity.path) &&
      !semanticTopLevelEffectFollowsCapture(capture, node, state.parentsByNode),
  );
};

const semanticExpressionModuleOrigin = (
  expression: t.Node,
  state: JavaScriptSemanticAnalysisState,
  visited = new Set<string>(),
): JavaScriptModuleOrigin | undefined => {
  const node = unwrapJavaScriptExpression(expression).node;
  const required = semanticRequireOrigin(node, state);
  if (required !== undefined) return required.origin;
  if (t.isIdentifier(node)) {
    const binding = resolveSemanticBindingState(state, node, node.name);
    if (binding === undefined || visited.has(binding.bindingId))
      return undefined;
    const provenance = evaluateSemanticProvenanceAtRead(binding, node, state);
    return provenance.status === "module" ? provenance.origins[0] : undefined;
  }
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const base = semanticExpressionModuleOrigin(node.object, state, visited);
    const key = semanticStaticPropertyKey(node.property, node.computed);
    return base === undefined || key === null
      ? undefined
      : { ...base, importedPath: [...base.importedPath, key] };
  }
  return undefined;
};

/** Recognize global or node:process aliases without accepting shadowing. */
export const isSemanticProcessObject = (
  node: t.Expression | t.Super,
  state: JavaScriptSemanticAnalysisState,
  family: "env" | "argv",
  key?: string | null,
): boolean => {
  if (!t.isIdentifier(node)) return false;
  const binding = resolveSemanticBindingState(state, node, node.name);
  const selected = key === undefined ? [family] : [family, key];
  if (binding === undefined)
    return (
      semanticGlobalProcessOrigin(node, state) !== undefined &&
      !requiredModuleChanged("process", selected, node, state)
    );
  return (
    builtinBindingPath(
      binding,
      state,
      ["process", "node:process"],
      node,
      selected,
      true,
    )?.length === 0
  );
};

/** Resolve the nearest direct variable/assignment owner before a callable. */
export const outerDataEffectBinding = (
  node: t.Node,
  context: DataEffectTraversalContext,
): string | null => {
  return scalarAssignedResultBinding(
    assignedSemanticResultBindings(node, context.ancestors, context.state),
  );
};

/** Traverse with exact callable and ancestor stacks. */
export const traverseDataEffects = (
  program: t.Program,
  context: DataEffectTraversalContext,
  visit: (node: t.Node, parent: t.Node | null) => void,
): void => {
  const callableStack = createSemanticCallableIdStack(
    context.callableIds,
    context.callableStack,
  );
  context.ancestors.length = 0;
  traverseJavaScriptValueAst(program, context.state.erasedSyntaxNodes, {
    enter: (node, parent) => {
      callableStack.enter(node, parent);
      visit(node, parent);
      context.ancestors.push(node);
    },
    exit: (node) => {
      context.ancestors.pop();
      callableStack.exit(node);
    },
  });
};

/** Resolve one direct identifier argument to a lexical binding. */
export const dataEffectArgumentBindingId = (
  node:
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
    | undefined,
  state: JavaScriptSemanticAnalysisState,
): string | null =>
  t.isIdentifier(node)
    ? (resolveSemanticBindingState(state, node, node.name)?.bindingId ?? null)
    : null;

/**
 * Read one static string or expression-free template. A template recovered
 * with an invalid escape has no cooked value; its raw spelling is not a
 * JavaScript string, so it stays dynamic.
 */
export const dataEffectLiteralString = (
  node:
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
    | undefined,
): string | null => {
  if (node === undefined) return null;
  const literal = readExactJavaScriptLiteral(node);
  return literal.found && typeof literal.value === "string"
    ? literal.value
    : null;
};

/** Read a member callee from call or construction syntax. */
export const dataEffectMemberCallee = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
): t.MemberExpression | t.OptionalMemberExpression | null =>
  t.isMemberExpression(node.callee) || t.isOptionalMemberExpression(node.callee)
    ? node.callee
    : null;
