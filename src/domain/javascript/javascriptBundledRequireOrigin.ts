import * as t from "@babel/types";

import { javascriptBootstrapAt } from "./javascriptBootstrap.js";
import { javascriptBundlerFactoryRoles } from "./javascriptBundlerFactoryRoles.js";
import { proveJavaScriptBootstrapIntegrity } from "./javascriptBootstrapIntegrity.js";
import {
  semanticMemberChain,
  semanticStaticPropertyKey,
  readExactJavaScriptLiteral,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { collectJavaScriptIdentityWritesSteps } from "./javascriptElectronMemberWrites.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { semanticRequireOriginCandidate } from "./javascriptSemanticRequireOrigin.js";
import type { JavaScriptRequireOrigin } from "./javascriptSemanticRequireOriginSlot.js";
import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  argumentValue,
  moduleFactory,
  modulePropertyName,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  completeSemanticSteps,
  traverseJavaScriptValueAst,
} from "./javascriptSemanticTraversal.js";

/** A standalone Webpack bootstrap uses the module, exports, loader convention. */
const BOOTSTRAP_RUNTIME = "webpack-bootstrap";

/** Loader bindings and literal externals proven for one standalone bootstrap. */
interface BootstrapExternals {
  /** The runtime loader and every factory parameter it is passed as. */
  readonly loaderBindingIds: ReadonlySet<string>;
  /** Loader bindings with the canonical n.n getter installed before dispatch. */
  readonly interopGetterBindingIds: ReadonlySet<string>;
  /** Table keys whose factory only re-exports one unshadowed literal require; null when a key repeats. */
  readonly externals: ReadonlyMap<string, JavaScriptModuleOrigin | null>;
}

const proofs = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WeakMap<t.CallExpression, BootstrapExternals | null>
>();

/**
 * Recover a literal require reached through a proven Webpack bootstrap.
 *
 * Webpack emits externals as `{45840: e => { e.exports = require("electron") }}`
 * and consumers call the runtime loader, `n(45840)`, instead of `require`. The
 * origin is accepted only when the loader binding is the bootstrap's own loader
 * or a factory parameter that the bootstrap proves it passes the loader as, and
 * the keyed factory consists solely of that re-export.
 */
export const semanticBundledRequireOrigin = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptRequireOrigin | undefined => {
  const result = semanticBundledRequireOriginCandidate(node, state);
  return result?.origin.loaderAuthority === "candidate" ? undefined : result;
};

/** Retain conditional externals without treating the bootstrap as host proof. */
export const semanticBundledRequireOriginCandidate = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptRequireOrigin | undefined => {
  const chain = semanticMemberChain(node);
  const current = chain?.root;
  if (
    chain?.members.length === 0 &&
    t.isCallExpression(current) &&
    t.isMemberExpression(current.callee) &&
    semanticStaticPropertyKey(
      current.callee.property,
      current.callee.computed,
    ) === "n" &&
    t.isIdentifier(current.callee.object) &&
    current.arguments.length === 1
  ) {
    // Webpack's `n.n(module)` returns its default-export getter. For a
    // CommonJS external, invoking that getter yields the exact exports object;
    // bind its identity to the proven registry result while retaining the
    // nested loader call as the source of provenance.
    const nested = semanticBundledRequireOriginCandidate(
      current.arguments[0],
      state,
    );
    const loaderBinding = resolveSemanticBindingState(
      state,
      current.callee.object,
      current.callee.object.name,
    );
    const proof =
      nested === undefined || loaderBinding === undefined
        ? undefined
        : bootstrapProofForLoaderCall(
            nested.call,
            loaderBinding.bindingId,
            state,
          );
    const nestedCallee = nested?.call.callee;
    const loaderBindingId = loaderBinding?.bindingId;
    if (
      nested !== undefined &&
      nested.origin.importedPath.length === 0 &&
      t.isIdentifier(nestedCallee) &&
      loaderBindingId !== undefined &&
      loaderBindingId ===
        resolveSemanticBindingState(state, nestedCallee, nestedCallee.name)
          ?.bindingId &&
      proof?.loaderBindingIds.has(loaderBindingId) === true &&
      proof.interopGetterBindingIds.has(loaderBindingId)
    )
      return nested;
  }
  if (
    chain === undefined ||
    !t.isCallExpression(current) ||
    !t.isIdentifier(current.callee) ||
    current.arguments.length !== 1
  )
    return undefined;
  const key = argumentValue(current.arguments[0]);
  if (key === undefined) return undefined;
  const loader = current.callee;
  if (semanticResolutionBlocked(state, loader, loader.name)) return undefined;
  const binding = resolveSemanticBindingState(state, loader, loader.name);
  if (
    binding === undefined ||
    binding.definitions.length !== 1 ||
    binding.definitions[0]?.kind === "assignment"
  )
    return undefined;
  for (
    let ancestor = state.parentsByNode.get(current);
    ancestor !== undefined;
    ancestor = state.parentsByNode.get(ancestor)
  ) {
    if (!t.isCallExpression(ancestor)) continue;
    const proof = bootstrapExternals(ancestor, state);
    if (proof === null || !proof.loaderBindingIds.has(binding.bindingId))
      continue;
    const origin = proof.externals.get(key);
    return origin !== null && origin !== undefined
      ? {
          origin: {
            ...origin,
            importedPath: chain.members,
            resolutionMode: "require",
          },
          call: current,
        }
      : undefined;
  }
  return undefined;
};

/** Prove the source-local n.n getter and reject visible replacements. */
const canonicalWebpackInteropBindings = (
  loaderBindingIds: ReadonlySet<string>,
  bootstrapBody: t.BlockStatement,
  state: JavaScriptSemanticAnalysisState,
): ReadonlySet<string> => {
  // The shared identity-write owner covers assignment, delete, destructuring,
  // and Object/Reflect mutators; any write that may select `n` counts.
  const writes = new Set<t.Node>();
  const interop = createSemanticModuleInterop(state);
  const excludesLoader = (node: t.Node): boolean =>
    interop.isFreshObject(node) || readExactJavaScriptLiteral(node).found;
  /**
   * Answer "may this write select the loader?" from one forward loader-alias
   * closure instead of a backward walk from every write. The closure starts
   * at the proven loader bindings and follows only assignment edges whose
   * right-hand side is a known loader alias, so unrelated alias graphs —
   * however large — never consume the alias-selection budget; write checks
   * below become table lookups against it. The closure is read-site
   * insensitive: a loader alias assigned after a write still counts, which
   * fails closed. When the closure itself grows past the alias-selection
   * budget, it is abandoned and every write is treated as possibly
   * selecting the loader.
   */
  const loaderAliasClosure = (): {
    readonly aliases: ReadonlySet<string>;
    readonly exhausted: boolean;
  } => {
    const aliases = new Set<string>(loaderBindingIds);
    // Reverse index: a binding an initializer identifier resolves to maps to
    // every binding that identifier may initialize.
    const dependents = new Map<string, string[]>();
    for (const binding of state.bindingsById.values()) {
      for (const initializers of [
        binding.initializers,
        binding.referenceInitializers,
      ])
        for (const source of initializers) {
          if (source.projection.length !== 0) continue;
          const next = unwrapJavaScriptExpression(source.node).node;
          if (!t.isIdentifier(next)) continue;
          const target = resolveSemanticBindingState(state, next, next.name);
          if (target === undefined) continue;
          const list = dependents.get(target.bindingId);
          if (list === undefined)
            dependents.set(target.bindingId, [binding.bindingId]);
          else list.push(binding.bindingId);
        }
    }
    let added = 0;
    const pending = [...loaderBindingIds];
    while (pending.length > 0) {
      const bindingId = pending.pop();
      if (bindingId === undefined) continue;
      for (const dependent of dependents.get(bindingId) ?? []) {
        if (aliases.has(dependent)) continue;
        aliases.add(dependent);
        added += 1;
        if (added > state.precision.alias_selections) {
          state.valueResourceLimits.add("alias-selections");
          return { aliases, exhausted: true };
        }
        pending.push(dependent);
      }
    }
    return { aliases, exhausted: false };
  };
  const closure = loaderAliasClosure();
  const loaderMayOwnReference = (root: t.Node): boolean => {
    const first = unwrapJavaScriptExpression(root).node;
    if (!t.isIdentifier(first)) return !excludesLoader(first);
    if (closure.exhausted) return true;
    const binding = resolveSemanticBindingState(state, first, first.name);
    if (binding === undefined) return true;
    // Follow identifier-initializer edges transitively: a write root may
    // hold the loader not only when it aliases the loader directly, but
    // also when any binding on its alias chain holds an uncertain value.
    // Checking only the root's own initializers accepted a root whose first
    // resolvable name merely resolved — `const a = flag ? n : {}; const b =
    // a; b.n = ...` — even though `a` may be the loader. A call,
    // conditional, member, or unresolvable name may return the loader, and
    // a projected initializer is unknown. Each binding is visited once, so
    // the walk is bounded by the binding count and spends no alias budget.
    const visited = new Set<string>();
    const pending: {
      readonly binding: JavaScriptSemanticBindingState;
      readonly read: t.Node;
    }[] = [{ binding, read: first }];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || visited.has(current.binding.bindingId))
        continue;
      visited.add(current.binding.bindingId);
      if (closure.aliases.has(current.binding.bindingId)) return true;
      const selected = semanticBindingAtRead(
        current.binding,
        current.read,
        state,
      ).binding;
      for (const initializers of [
        selected.initializers,
        selected.referenceInitializers,
      ])
        for (const source of initializers) {
          if (source.projection.length !== 0) return true;
          const next = unwrapJavaScriptExpression(source.node).node;
          if (t.isIdentifier(next)) {
            const target = resolveSemanticBindingState(state, next, next.name);
            if (target === undefined) return true;
            pending.push({ binding: target, read: next });
          } else if (!excludesLoader(next)) return true;
        }
    }
    return false;
  };
  completeSemanticSteps(
    collectJavaScriptIdentityWritesSteps(
      state.program,
      state.erasedSyntaxNodes,
      (root, kind) => {
        return kind === "member" && loaderMayOwnReference(root)
          ? [["loader"]]
          : [];
      },
      interop.intrinsicInvocation,
      interop.staticString,
      interop.isFreshObject,
      (node, path) => {
        if (path.length < 2 || path[1] === "n" || path[1] === null)
          writes.add(node);
      },
    ),
  );
  const proven = new Set<string>();
  const [write] = writes;
  if (
    writes.size === 1 &&
    t.isAssignmentExpression(write) &&
    isInstalledBeforeEntryDispatch(
      write,
      bootstrapBody,
      loaderBindingIds,
      state,
    ) &&
    isCanonicalGetter(write, state)
  )
    for (const bindingId of loaderBindingIds) proven.add(bindingId);
  return proven;
};

const isCanonicalGetter = (
  write: t.AssignmentExpression,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (
    !t.isArrowFunctionExpression(write.right) ||
    write.right.params.length !== 1 ||
    !t.isIdentifier(write.right.params[0])
  )
    return false;
  const parameter = write.right.params[0];
  const parameterBinding = resolveSemanticBindingState(
    state,
    parameter,
    parameter.name,
  );
  const body = write.right.body;
  return (
    parameterBinding !== undefined &&
    t.isConditionalExpression(body) &&
    t.isLogicalExpression(body.test, { operator: "&&" }) &&
    sameBinding(body.test.left, parameterBinding.bindingId, state) &&
    t.isMemberExpression(body.test.right) &&
    semanticStaticPropertyKey(
      body.test.right.property,
      body.test.right.computed,
    ) === "__esModule" &&
    sameBinding(body.test.right.object, parameterBinding.bindingId, state) &&
    getterReturnsDefault(body.consequent, parameterBinding.bindingId, state) &&
    getterReturnsModule(body.alternate, parameterBinding.bindingId, state)
  );
};

const isInstalledBeforeEntryDispatch = (
  write: t.AssignmentExpression,
  body: t.BlockStatement,
  loaderBindingIds: ReadonlySet<string>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const statement = state.parentsByNode.get(write);
  if (!t.isExpressionStatement(statement)) return false;
  const writeIndex = body.body.indexOf(statement);
  if (writeIndex < 0) return false;
  let entryIndex = -1;
  for (let index = 0; index < body.body.length; index += 1) {
    const topLevel = body.body[index];
    if (topLevel === undefined) continue;
    traverseJavaScriptValueAst(topLevel, state.erasedSyntaxNodes, {
      enter: (node, _parent, ancestors) => {
        if (
          entryIndex < 0 &&
          t.isCallExpression(node) &&
          t.isIdentifier(node.callee) &&
          ancestors().every((ancestor) => !t.isFunction(ancestor)) &&
          loaderBindingIds.has(
            resolveSemanticBindingState(state, node.callee, node.callee.name)
              ?.bindingId ?? "",
          )
        )
          entryIndex = index;
      },
    });
    if (entryIndex >= 0) break;
  }
  return entryIndex > writeIndex;
};

const bootstrapProofForLoaderCall = (
  call: t.CallExpression | t.OptionalCallExpression,
  loaderBindingId: string,
  state: JavaScriptSemanticAnalysisState,
): BootstrapExternals | undefined => {
  for (
    let ancestor = state.parentsByNode.get(call);
    ancestor !== undefined;
    ancestor = state.parentsByNode.get(ancestor)
  ) {
    if (!t.isCallExpression(ancestor)) continue;
    const proof = bootstrapExternals(ancestor, state);
    if (proof?.loaderBindingIds.has(loaderBindingId)) return proof;
  }
  return undefined;
};

const sameBinding = (
  node: t.Node,
  bindingId: string,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  t.isIdentifier(node) &&
  resolveSemanticBindingState(state, node, node.name)?.bindingId === bindingId;

const getterReturnsDefault = (
  node: t.Node,
  bindingId: string,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  t.isArrowFunctionExpression(node) &&
  node.params.length === 0 &&
  t.isMemberExpression(node.body) &&
  semanticStaticPropertyKey(node.body.property, node.body.computed) ===
    "default" &&
  sameBinding(node.body.object, bindingId, state);

const getterReturnsModule = (
  node: t.Node,
  bindingId: string,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  t.isArrowFunctionExpression(node) &&
  node.params.length === 0 &&
  sameBinding(node.body, bindingId, state);

const bootstrapExternals = (
  call: t.CallExpression,
  state: JavaScriptSemanticAnalysisState,
): BootstrapExternals | null => {
  let byCall = proofs.get(state);
  if (byCall === undefined) {
    byCall = new WeakMap();
    proofs.set(state, byCall);
  }
  const cached = byCall.get(call);
  if (cached !== undefined) return cached;
  const proof = proveBootstrapExternals(call, state);
  byCall.set(call, proof);
  return proof;
};

const proveBootstrapExternals = (
  call: t.CallExpression,
  state: JavaScriptSemanticAnalysisState,
): BootstrapExternals | null => {
  const bootstrap = javascriptBootstrapAt(call, state);
  // A replaced loader no longer dispatches the declared table.
  if (
    bootstrap === undefined ||
    !singleDefinition(state, bootstrap.loaderBindingId, "function")
  )
    return null;
  const loaderBindingIds = new Set([bootstrap.loaderBindingId]);
  const factories = bootstrap.table.properties.flatMap((property) => {
    const factory = moduleFactory(property);
    return factory === undefined ? [] : [{ property, factory }];
  });
  for (const { factory } of factories) {
    // The bootstrap proves `table[key](module, module.exports, loader)`.
    const loaderParameter = javascriptBundlerFactoryRoles(
      factory,
      BOOTSTRAP_RUNTIME,
    ).loader;
    const bindingId =
      loaderParameter === undefined
        ? undefined
        : resolveSemanticBindingState(
            state,
            loaderParameter,
            loaderParameter.name,
          )?.bindingId;
    if (
      bindingId !== undefined &&
      singleDefinition(state, bindingId, "parameter")
    )
      loaderBindingIds.add(bindingId);
  }
  const integrity = proveJavaScriptBootstrapIntegrity(
    call,
    bootstrap,
    loaderBindingIds,
    state,
  );
  if (integrity === undefined) return null;
  const externals = new Map<string, JavaScriptModuleOrigin | null>();
  for (const { property, factory } of factories) {
    const key = modulePropertyName(property);
    const specifier = integrity.replacedKeys.has(key)
      ? undefined
      : externalSpecifier(factory, state);
    if (externals.has(key)) externals.set(key, null);
    else externals.set(key, specifier ?? null);
  }
  return {
    loaderBindingIds,
    interopGetterBindingIds: canonicalWebpackInteropBindings(
      loaderBindingIds,
      bootstrap.body,
      state,
    ),
    externals,
  };
};

/**
 * Accept only `module.exports = require("specifier")` as the whole body of an
 * ordinary factory; generator, async and accessor factories do not run it.
 */
const externalSpecifier = (
  factory: t.FunctionExpression | t.ArrowFunctionExpression | t.ObjectMethod,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined => {
  const moduleParameter = javascriptBundlerFactoryRoles(
    factory,
    BOOTSTRAP_RUNTIME,
  ).module;
  if (
    moduleParameter === undefined ||
    factory.generator ||
    factory.async ||
    (t.isObjectMethod(factory) && factory.kind !== "method")
  )
    return undefined;
  let expression: t.Node | undefined;
  if (t.isBlockStatement(factory.body)) {
    const [statement] = factory.body.body;
    if (factory.body.body.length !== 1 || !t.isExpressionStatement(statement))
      return undefined;
    expression = statement.expression;
  } else expression = factory.body;
  if (
    !t.isAssignmentExpression(expression, { operator: "=" }) ||
    !t.isMemberExpression(expression.left) ||
    !t.isIdentifier(expression.left.object) ||
    semanticStaticPropertyKey(
      expression.left.property,
      expression.left.computed,
    ) !== "exports"
  )
    return undefined;
  const moduleBinding = resolveSemanticBindingState(
    state,
    moduleParameter,
    moduleParameter.name,
  );
  const target = resolveSemanticBindingState(
    state,
    expression.left.object,
    expression.left.object.name,
  );
  if (
    moduleBinding === undefined ||
    target?.bindingId !== moduleBinding.bindingId
  )
    return undefined;
  const required = semanticRequireOriginCandidate(
    expression.right,
    state,
  )?.origin;
  return required !== undefined && required.importedPath.length === 0
    ? required
    : undefined;
};

const singleDefinition = (
  state: JavaScriptSemanticAnalysisState,
  bindingId: string,
  kind: "function" | "parameter",
): boolean => {
  const definitions = state.bindingsById.get(bindingId)?.definitions;
  return definitions?.length === 1 && definitions[0]?.kind === kind;
};
