import * as t from "@babel/types";

import { javascriptBootstrapAt } from "./javascriptBootstrap.js";
import { javascriptBundlerFactoryRoles } from "./javascriptBundlerFactoryRoles.js";
import { proveJavaScriptBootstrapIntegrity } from "./javascriptBootstrapIntegrity.js";
import {
  runtimeFunctionParameters,
  semanticMemberChain,
  semanticStaticPropertyKey,
  readExactJavaScriptLiteral,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { collectJavaScriptIdentityWritesSteps } from "./javascriptElectronMemberWrites.js";
import {
  semanticBindingAtRead,
  semanticStableBindingInitializedBeforeRead,
} from "./javascriptSemanticMutationInitializers.js";
import { semanticOpaqueBindingReadMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import { SEMANTIC_ALIAS_SELECTION_LIMIT } from "./javascriptSemanticResourceLimits.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { isUnmodifiedGlobalReference } from "./javascriptSemanticGlobalReference.js";
import {
  semanticRequireOriginCandidate,
  type JavaScriptRequireOrigin,
} from "./javascriptSemanticRequireOrigin.js";
import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
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

type Bootstrap = NonNullable<ReturnType<typeof javascriptBootstrapAt>>;

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
  if (node === null || node === undefined) return undefined;
  return resolveBundledModuleOrigin(node, state, new Set());
};

const resolveBundledModuleOrigin = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
  visitedBindings: ReadonlySet<string>,
): JavaScriptRequireOrigin | undefined => {
  const chain = semanticMemberChain(node);
  const current = chain?.root;
  if (chain === undefined || current === null || current === undefined)
    return undefined;
  if (t.isIdentifier(current)) {
    const alias = readBundledAliasInitializer(current, state, visitedBindings);
    if (
      alias === undefined ||
      !alias.projection.every(
        (segment): segment is string => typeof segment === "string",
      )
    )
      return undefined;
    const base = resolveBundledModuleOrigin(
      alias.node,
      state,
      alias.nextVisited,
    );
    return base === undefined
      ? undefined
      : {
          origin: {
            ...base.origin,
            importedPath: [
              ...base.origin.importedPath,
              ...alias.projection,
              ...chain.members,
            ],
          },
          call: base.call,
        };
  }
  if (!t.isCallExpression(current)) return undefined;
  if (current.arguments.length === 0) {
    // Webpack/Rspack's `n.n(module)` returns a zero-argument default-export
    // getter. For a CommonJS external, invoking that getter yields the exact
    // exports object; bind its identity to the proven registry result while
    // retaining the nested loader call as the source of provenance.
    const getterOrigin = resolveBundledInteropGetterOrigin(
      current.callee,
      state,
      visitedBindings,
    );
    return getterOrigin === undefined
      ? undefined
      : {
          origin: {
            ...getterOrigin.origin,
            importedPath: [
              ...getterOrigin.origin.importedPath,
              ...chain.members,
            ],
          },
          call: getterOrigin.call,
        };
  }
  const callee = unwrapJavaScriptExpression(current.callee).node;
  if (!t.isIdentifier(callee) || current.arguments.length !== 1)
    return undefined;
  const key = argumentValue(current.arguments[0]);
  if (key === undefined) return undefined;
  if (semanticResolutionBlocked(state, callee, callee.name)) return undefined;
  const binding = resolveSemanticBindingState(state, callee, callee.name);
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

const resolveBundledInteropGetterOrigin = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
  visitedBindings: ReadonlySet<string>,
): JavaScriptRequireOrigin | undefined => {
  if (node === null || node === undefined) return undefined;
  const current = unwrapJavaScriptExpression(node).node;
  if (t.isIdentifier(current)) {
    const alias = readBundledAliasInitializer(current, state, visitedBindings);
    return alias === undefined || alias.projection.length !== 0
      ? undefined
      : resolveBundledInteropGetterOrigin(alias.node, state, alias.nextVisited);
  }
  if (!t.isCallExpression(current) || current.arguments.length !== 1)
    return undefined;
  const callee = unwrapJavaScriptExpression(current.callee).node;
  if (
    !t.isMemberExpression(callee) ||
    semanticStaticPropertyKey(callee.property, callee.computed) !== "n"
  )
    return undefined;
  const loaderObject = unwrapJavaScriptExpression(callee.object).node;
  if (
    !t.isIdentifier(loaderObject) ||
    semanticResolutionBlocked(state, loaderObject, loaderObject.name)
  )
    return undefined;
  const nested = resolveBundledModuleOrigin(
    current.arguments[0],
    state,
    visitedBindings,
  );
  const loaderBinding = resolveSemanticBindingState(
    state,
    loaderObject,
    loaderObject.name,
  );
  const proof =
    nested === undefined || loaderBinding === undefined
      ? undefined
      : bootstrapProofForLoaderCall(
          nested.call,
          loaderBinding.bindingId,
          state,
        );
  const nestedCallee =
    nested === undefined
      ? undefined
      : unwrapJavaScriptExpression(nested.call.callee).node;
  const loaderBindingId = loaderBinding?.bindingId;
  const nestedLoaderBindingId = t.isIdentifier(nestedCallee)
    ? resolveSemanticBindingState(state, nestedCallee, nestedCallee.name)
        ?.bindingId
    : undefined;
  return nested !== undefined &&
    nested.origin.importedPath.length === 0 &&
    loaderBindingId !== undefined &&
    nestedLoaderBindingId !== undefined &&
    proof?.loaderBindingIds.has(loaderBindingId) === true &&
    proof.loaderBindingIds.has(nestedLoaderBindingId) &&
    proof.interopGetterBindingIds.has(loaderBindingId)
    ? nested
    : undefined;
};

const nodeContains = (
  container: t.Node,
  descendant: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  for (
    let current: t.Node | undefined = descendant;
    current !== undefined;
    current = parents.get(current)
  ) {
    if (current === container) return true;
  }
  return false;
};

const readBundledAliasInitializer = (
  identifier: t.Identifier,
  state: JavaScriptSemanticAnalysisState,
  visitedBindings: ReadonlySet<string>,
):
  | {
      readonly node: t.Node;
      readonly projection: readonly (string | number | null)[];
      readonly nextVisited: ReadonlySet<string>;
    }
  | undefined => {
  if (semanticResolutionBlocked(state, identifier, identifier.name))
    return undefined;
  const binding = resolveSemanticBindingState(
    state,
    identifier,
    identifier.name,
  );
  if (binding === undefined || visitedBindings.has(binding.bindingId))
    return undefined;
  if (visitedBindings.size >= SEMANTIC_ALIAS_SELECTION_LIMIT) {
    state.valueResourceLimits.add("alias-selections");
    return undefined;
  }
  if (
    state.opaqueEffects.byScope.size > 0 &&
    semanticOpaqueBindingReadMayHaveChanged(binding, identifier, state)
  )
    return undefined;
  const { binding: snapshot, hasDefiniteInitializer } = semanticBindingAtRead(
    binding,
    identifier,
    state,
  );
  if (
    !hasDefiniteInitializer &&
    !semanticStableBindingInitializedBeforeRead(binding, identifier, state)
  )
    return undefined;
  const initializer = semanticStableInitializer(snapshot, state);
  return initializer === undefined ||
    snapshot.referenceInitializers.some(({ assignment }) => assignment) ||
    nodeContains(initializer.node, identifier, state.parentsByNode)
    ? undefined
    : {
        node: initializer.node,
        projection: initializer.projection,
        nextVisited: new Set([...visitedBindings, binding.bindingId]),
      };
};

/** Prove the source-local n.n getter and reject visible replacements. */
const canonicalWebpackInteropBindings = (
  loaderBindingIds: ReadonlySet<string>,
  bootstrap: Bootstrap,
  state: JavaScriptSemanticAnalysisState,
): ReadonlySet<string> => {
  // The shared identity-write owner covers assignment, delete, destructuring,
  // and Object/Reflect mutators; any write that may select `n`, `d`, or `o` counts.
  const nWrites = new Set<t.Node>();
  const dWrites = new Set<t.Node>();
  const oWrites = new Set<t.Node>();
  const interop = createSemanticModuleInterop(state);
  const excludesLoader = (node: t.Node): boolean =>
    interop.isFreshObject(node) || readExactJavaScriptLiteral(node).found;
  const loaderMayOwnReference = (root: t.Node): boolean => {
    const first = unwrapJavaScriptExpression(root).node;
    if (!t.isIdentifier(first)) return !excludesLoader(first);
    // Only proven separate values are terminals. An unsupported expression
    // might return the loader, so preserve that uncertainty instead of dropping it.
    const pending = [first];
    const seen = new Set<t.Identifier>();
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined || seen.has(node)) continue;
      seen.add(node);
      if (seen.size > SEMANTIC_ALIAS_SELECTION_LIMIT) {
        state.valueResourceLimits.add("alias-selections");
        return true;
      }
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (binding === undefined) return true;
      if (loaderBindingIds.has(binding.bindingId)) return true;
      const selected = semanticBindingAtRead(binding, node, state).binding;
      for (const initializers of [
        selected.initializers,
        selected.referenceInitializers,
      ])
        for (const source of initializers) {
          // A fresh container does not establish the selected property's value.
          if (source.projection.length !== 0) return true;
          const next = unwrapJavaScriptExpression(source.node).node;
          if (t.isIdentifier(next)) pending.push(next);
          else if (!excludesLoader(next)) return true;
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
        if (path.length < 2 || path[1] === null) {
          nWrites.add(node);
          dWrites.add(node);
          oWrites.add(node);
        } else {
          if (path[1] === "n") nWrites.add(node);
          if (path[1] === "d") dWrites.add(node);
          if (path[1] === "o") oWrites.add(node);
        }
      },
    ),
  );
  const proven = new Set<string>();
  const [write] = nWrites;
  if (
    nWrites.size === 1 &&
    t.isAssignmentExpression(write, { operator: "=" }) &&
    isInstalledBeforeEntryDispatch(
      write,
      "n",
      bootstrap,
      loaderBindingIds,
      state,
    )
  ) {
    const getterProof = analyzeCanonicalGetter(write, loaderBindingIds, state);
    if (
      getterProof.valid &&
      (!getterProof.usesDefineExports ||
        isProvenDefineExportsHelper(
          dWrites,
          oWrites,
          bootstrap,
          loaderBindingIds,
          state,
        ))
    )
      for (const bindingId of loaderBindingIds) proven.add(bindingId);
  }
  return proven;
};

interface CanonicalGetterProof {
  readonly valid: boolean;
  readonly usesDefineExports: boolean;
}

const INVALID_GETTER: CanonicalGetterProof = {
  valid: false,
  usesDefineExports: false,
};

const analyzeCanonicalGetter = (
  write: t.AssignmentExpression,
  loaderBindingIds: ReadonlySet<string>,
  state: JavaScriptSemanticAnalysisState,
): CanonicalGetterProof => {
  const fn = unwrapJavaScriptExpression(write.right).node;
  if (
    (!t.isArrowFunctionExpression(fn) && !t.isFunctionExpression(fn)) ||
    fn.async ||
    fn.generator ||
    runtimeFunctionParameters(fn).length !== 1
  )
    return INVALID_GETTER;
  if (t.isFunctionExpression(fn) && fn.id != null) {
    if (!t.isIdentifier(fn.id)) return INVALID_GETTER;
    const fnBinding = resolveSemanticBindingState(state, fn.id, fn.id.name);
    if (
      fnBinding === undefined ||
      !singleDefinition(state, fnBinding.bindingId, "function") ||
      (state.bindingWrites.get(fnBinding.bindingId)?.length ?? 0) !== 0
    )
      return INVALID_GETTER;
  }
  const [parameter] = runtimeFunctionParameters(fn);
  if (!t.isIdentifier(parameter)) return INVALID_GETTER;
  const parameterBinding = resolveSemanticBindingState(
    state,
    parameter,
    parameter.name,
  );
  if (
    parameterBinding === undefined ||
    !singleDefinition(state, parameterBinding.bindingId, "parameter") ||
    (state.bindingWrites.get(parameterBinding.bindingId)?.length ?? 0) !== 0
  )
    return INVALID_GETTER;
  if (!t.isBlockStatement(fn.body))
    return {
      valid: isCanonicalConditionalGetter(
        fn.body,
        parameterBinding.bindingId,
        state,
      ),
      usesDefineExports: false,
    };
  const statements = fn.body.body;
  const [first, second, third] = statements;
  if (
    statements.length === 1 &&
    t.isReturnStatement(first) &&
    first.argument != null
  )
    return {
      valid: isCanonicalConditionalGetter(
        first.argument,
        parameterBinding.bindingId,
        state,
      ),
      usesDefineExports: false,
    };
  if (!t.isVariableDeclaration(first) || first.declarations.length !== 1)
    return INVALID_GETTER;
  const [declarator] = first.declarations;
  if (!t.isIdentifier(declarator?.id) || declarator.init == null)
    return INVALID_GETTER;
  const getterBinding = resolveSemanticBindingState(
    state,
    declarator.id,
    declarator.id.name,
  );
  if (
    getterBinding === undefined ||
    !singleDefinition(state, getterBinding.bindingId, "variable") ||
    (state.bindingWrites.get(getterBinding.bindingId)?.length ?? 0) !== 0 ||
    getterBinding.memberWrites.length !== 0 ||
    !isCanonicalConditionalGetter(
      declarator.init,
      parameterBinding.bindingId,
      state,
    )
  )
    return INVALID_GETTER;
  if (
    statements.length === 2 &&
    t.isReturnStatement(second) &&
    second.argument != null
  ) {
    const returned = unwrapJavaScriptExpression(second.argument).node;
    if (sameBinding(returned, getterBinding.bindingId, state))
      return { valid: true, usesDefineExports: false };
    const valid =
      t.isSequenceExpression(returned) &&
      returned.expressions.length === 2 &&
      isCanonicalGetterDefineCall(
        returned.expressions[0]!,
        getterBinding.bindingId,
        loaderBindingIds,
        state,
      ) &&
      sameBinding(
        unwrapJavaScriptExpression(returned.expressions[1]!).node,
        getterBinding.bindingId,
        state,
      );
    return { valid, usesDefineExports: valid };
  }
  const valid =
    statements.length === 3 &&
    t.isExpressionStatement(second) &&
    isCanonicalGetterDefineCall(
      second.expression,
      getterBinding.bindingId,
      loaderBindingIds,
      state,
    ) &&
    t.isReturnStatement(third) &&
    third.argument != null &&
    sameBinding(
      unwrapJavaScriptExpression(third.argument).node,
      getterBinding.bindingId,
      state,
    );
  return { valid, usesDefineExports: valid };
};

const isProvenDefineExportsHelper = (
  dWrites: ReadonlySet<t.Node>,
  oWrites: ReadonlySet<t.Node>,
  bootstrap: Bootstrap,
  loaderBindingIds: ReadonlySet<string>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const [dWrite] = dWrites;
  if (
    dWrites.size !== 1 ||
    !t.isAssignmentExpression(dWrite, { operator: "=" }) ||
    !isInstalledBeforeEntryDispatch(
      dWrite,
      "d",
      bootstrap,
      loaderBindingIds,
      state,
    )
  )
    return false;
  const fn = unwrapJavaScriptExpression(dWrite.right).node;
  if (
    (!t.isArrowFunctionExpression(fn) && !t.isFunctionExpression(fn)) ||
    fn.async ||
    fn.generator ||
    runtimeFunctionParameters(fn).length !== 2 ||
    !t.isBlockStatement(fn.body) ||
    fn.body.body.length !== 1
  )
    return false;
  if (t.isFunctionExpression(fn) && fn.id != null) {
    if (!t.isIdentifier(fn.id)) return false;
    const fnBinding = resolveSemanticBindingState(state, fn.id, fn.id.name);
    if (
      fnBinding === undefined ||
      !singleDefinition(state, fnBinding.bindingId, "function") ||
      (state.bindingWrites.get(fnBinding.bindingId)?.length ?? 0) !== 0
    )
      return false;
  }
  const [exportsParam, definitionParam] = runtimeFunctionParameters(fn);
  if (!t.isIdentifier(exportsParam) || !t.isIdentifier(definitionParam))
    return false;
  const exportsBinding = resolveSemanticBindingState(
    state,
    exportsParam,
    exportsParam.name,
  );
  const definitionBinding = resolveSemanticBindingState(
    state,
    definitionParam,
    definitionParam.name,
  );
  if (
    exportsBinding === undefined ||
    definitionBinding === undefined ||
    exportsBinding.bindingId === definitionBinding.bindingId ||
    !singleDefinition(state, exportsBinding.bindingId, "parameter") ||
    !singleDefinition(state, definitionBinding.bindingId, "parameter") ||
    (state.bindingWrites.get(exportsBinding.bindingId)?.length ?? 0) !== 0 ||
    (state.bindingWrites.get(definitionBinding.bindingId)?.length ?? 0) !== 0 ||
    definitionBinding.memberWrites.length !== 0
  )
    return false;
  const [forIn] = fn.body.body;
  if (
    !t.isForInStatement(forIn) ||
    !sameBinding(
      unwrapJavaScriptExpression(forIn.right).node,
      definitionBinding.bindingId,
      state,
    ) ||
    !t.isVariableDeclaration(forIn.left) ||
    forIn.left.declarations.length !== 1
  )
    return false;
  const [keyDeclarator] = forIn.left.declarations;
  if (!t.isIdentifier(keyDeclarator?.id) || keyDeclarator.init != null)
    return false;
  const keyBinding = resolveSemanticBindingState(
    state,
    keyDeclarator.id,
    keyDeclarator.id.name,
  );
  if (
    keyBinding === undefined ||
    keyBinding.definitions.filter(({ kind }) => kind === "variable").length !==
      1 ||
    keyBinding.definitions.length > 2 ||
    !(state.bindingWrites.get(keyBinding.bindingId) ?? []).every(
      (site) => site === forIn,
    )
  )
    return false;
  let usesHasOwnHelper = false;
  const isSafeGuard = (guard: t.Node): boolean => {
    const unwrapped = unwrapJavaScriptExpression(guard).node;
    if (t.isLogicalExpression(unwrapped, { operator: "&&" }))
      return isSafeGuard(unwrapped.left) && isSafeGuard(unwrapped.right);
    if (t.isUnaryExpression(unwrapped, { operator: "!" }))
      return isSafeGuard(unwrapped.argument);
    if (!t.isCallExpression(unwrapped) || unwrapped.arguments.length !== 2)
      return false;
    const [targetArg, propArg] = unwrapped.arguments;
    if (
      targetArg === undefined ||
      propArg === undefined ||
      t.isSpreadElement(targetArg) ||
      t.isSpreadElement(propArg)
    )
      return false;
    const targetNode = unwrapJavaScriptExpression(targetArg).node;
    const propNode = unwrapJavaScriptExpression(propArg).node;
    if (
      (!sameBinding(targetNode, exportsBinding.bindingId, state) &&
        !sameBinding(targetNode, definitionBinding.bindingId, state)) ||
      !sameBinding(propNode, keyBinding.bindingId, state)
    )
      return false;
    const callee = unwrapJavaScriptExpression(unwrapped.callee).node;
    if (
      t.isMemberExpression(callee) &&
      semanticStaticPropertyKey(callee.property, callee.computed) === "o" &&
      isDefiniteLoaderReceiver(callee.object, loaderBindingIds, state)
    ) {
      usesHasOwnHelper = true;
      return true;
    }
    return isUnmodifiedHasOwnCallCallee(callee, state);
  };
  const step = unwrapSingleStatement(forIn.body);
  if (step === undefined) return false;
  let defineExpr: t.Node | undefined;
  if (t.isIfStatement(step) && step.alternate == null) {
    const consequent = unwrapSingleStatement(step.consequent);
    if (
      !isSafeGuard(step.test) ||
      consequent === undefined ||
      !t.isExpressionStatement(consequent)
    )
      return false;
    defineExpr = consequent.expression;
  } else if (t.isExpressionStatement(step)) {
    const inner = unwrapJavaScriptExpression(step.expression).node;
    if (t.isLogicalExpression(inner, { operator: "&&" })) {
      if (!isSafeGuard(inner.left)) return false;
      defineExpr = inner.right;
    } else defineExpr = inner;
  }
  return (
    defineExpr !== undefined &&
    isCanonicalDefinePropertyCall(
      defineExpr,
      exportsBinding.bindingId,
      definitionBinding.bindingId,
      keyBinding.bindingId,
      state,
    ) &&
    (!usesHasOwnHelper ||
      isProvenHasOwnHelper(oWrites, bootstrap, loaderBindingIds, state))
  );
};

const unwrapSingleStatement = (node: t.Statement): t.Statement | undefined =>
  t.isBlockStatement(node)
    ? node.body.length === 1
      ? node.body[0]
      : undefined
    : node;

const isUnmodifiedHasOwnCallCallee = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  isUnmodifiedGlobalReference(callee, state, ["Object", "hasOwn"]) ||
  (isUnmodifiedGlobalReference(callee, state, [
    "Object",
    "prototype",
    "hasOwnProperty",
    "call",
  ]) &&
    !state.ambientWrites.covers(["global", "Function", "prototype", "call"]));

const isExactTrueLiteral = (node: t.Node): boolean => {
  const unwrapped = unwrapJavaScriptExpression(node).node;
  const literal = readExactJavaScriptLiteral(unwrapped);
  if (literal.found) return literal.value === true;
  if (t.isUnaryExpression(unwrapped, { operator: "!" })) {
    const inner = readExactJavaScriptLiteral(unwrapped.argument);
    return inner.found && !inner.value;
  }
  return false;
};

const isCanonicalDefinePropertyCall = (
  node: t.Node,
  exportsBindingId: string,
  definitionBindingId: string,
  keyBindingId: string,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const call = unwrapJavaScriptExpression(node).node;
  if (
    !t.isCallExpression(call) ||
    call.arguments.length !== 3 ||
    !isUnmodifiedGlobalReference(call.callee, state, [
      "Object",
      "defineProperty",
    ]) ||
    ["value", "writable", "get", "set"].some((field) =>
      state.ambientWrites.covers(["global", "Object", "prototype", field]),
    )
  )
    return false;
  const [targetArg, keyArg, descriptorArg] = call.arguments;
  if (
    targetArg === undefined ||
    keyArg === undefined ||
    descriptorArg === undefined ||
    t.isSpreadElement(targetArg) ||
    t.isSpreadElement(keyArg) ||
    t.isSpreadElement(descriptorArg) ||
    !sameBinding(
      unwrapJavaScriptExpression(targetArg).node,
      exportsBindingId,
      state,
    ) ||
    !sameBinding(unwrapJavaScriptExpression(keyArg).node, keyBindingId, state)
  )
    return false;
  const descriptor = unwrapJavaScriptExpression(descriptorArg).node;
  if (
    !t.isObjectExpression(descriptor) ||
    descriptor.properties.length < 1 ||
    descriptor.properties.length > 2
  )
    return false;
  let hasGetter = false;
  const seenKeys = new Set<string>();
  for (const property of descriptor.properties) {
    if (
      !t.isObjectProperty(property) ||
      property.computed ||
      property.shorthand
    )
      return false;
    const key = semanticStaticPropertyKey(property.key, false);
    if (key === null || seenKeys.has(key)) return false;
    seenKeys.add(key);
    if (key === "enumerable") {
      if (!isExactTrueLiteral(property.value)) return false;
    } else if (key === "get") {
      const getter = unwrapJavaScriptExpression(property.value).node;
      if (
        !t.isMemberExpression(getter) ||
        !getter.computed ||
        !sameBinding(
          unwrapJavaScriptExpression(getter.object).node,
          definitionBindingId,
          state,
        ) ||
        !sameBinding(
          unwrapJavaScriptExpression(getter.property).node,
          keyBindingId,
          state,
        )
      )
        return false;
      hasGetter = true;
    } else return false;
  }
  return hasGetter;
};

const isProvenHasOwnHelper = (
  oWrites: ReadonlySet<t.Node>,
  bootstrap: Bootstrap,
  loaderBindingIds: ReadonlySet<string>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const [oWrite] = oWrites;
  if (
    oWrites.size !== 1 ||
    !t.isAssignmentExpression(oWrite, { operator: "=" }) ||
    !isInstalledBeforeEntryDispatch(
      oWrite,
      "o",
      bootstrap,
      loaderBindingIds,
      state,
    )
  )
    return false;
  const fn = unwrapJavaScriptExpression(oWrite.right).node;
  if (
    (!t.isArrowFunctionExpression(fn) && !t.isFunctionExpression(fn)) ||
    fn.async ||
    fn.generator ||
    runtimeFunctionParameters(fn).length !== 2
  )
    return false;
  const [objParam, propParam] = runtimeFunctionParameters(fn);
  if (!t.isIdentifier(objParam) || !t.isIdentifier(propParam)) return false;
  const objBinding = resolveSemanticBindingState(
    state,
    objParam,
    objParam.name,
  );
  const propBinding = resolveSemanticBindingState(
    state,
    propParam,
    propParam.name,
  );
  if (
    objBinding === undefined ||
    propBinding === undefined ||
    objBinding.bindingId === propBinding.bindingId ||
    !singleDefinition(state, objBinding.bindingId, "parameter") ||
    !singleDefinition(state, propBinding.bindingId, "parameter") ||
    (state.bindingWrites.get(objBinding.bindingId)?.length ?? 0) !== 0 ||
    (state.bindingWrites.get(propBinding.bindingId)?.length ?? 0) !== 0
  )
    return false;
  let returned: t.Node | undefined;
  if (t.isBlockStatement(fn.body)) {
    const [statement] = fn.body.body;
    if (
      fn.body.body.length !== 1 ||
      !t.isReturnStatement(statement) ||
      statement.argument == null
    )
      return false;
    returned = unwrapJavaScriptExpression(statement.argument).node;
  } else returned = unwrapJavaScriptExpression(fn.body).node;
  if (!t.isCallExpression(returned) || returned.arguments.length !== 2)
    return false;
  const [arg0, arg1] = returned.arguments;
  return (
    arg0 !== undefined &&
    arg1 !== undefined &&
    !t.isSpreadElement(arg0) &&
    !t.isSpreadElement(arg1) &&
    sameBinding(
      unwrapJavaScriptExpression(arg0).node,
      objBinding.bindingId,
      state,
    ) &&
    sameBinding(
      unwrapJavaScriptExpression(arg1).node,
      propBinding.bindingId,
      state,
    ) &&
    isUnmodifiedHasOwnCallCallee(
      unwrapJavaScriptExpression(returned.callee).node,
      state,
    )
  );
};

const isCanonicalConditionalGetter = (
  node: t.Node,
  parameterBindingId: string,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const conditional = unwrapJavaScriptExpression(node).node;
  if (!t.isConditionalExpression(conditional)) return false;
  const test = unwrapJavaScriptExpression(conditional.test).node;
  if (!t.isLogicalExpression(test, { operator: "&&" })) return false;
  const left = unwrapJavaScriptExpression(test.left).node;
  const right = unwrapJavaScriptExpression(test.right).node;
  return (
    sameBinding(left, parameterBindingId, state) &&
    t.isMemberExpression(right) &&
    semanticStaticPropertyKey(right.property, right.computed) ===
      "__esModule" &&
    sameBinding(
      unwrapJavaScriptExpression(right.object).node,
      parameterBindingId,
      state,
    ) &&
    getterReturnsDefault(conditional.consequent, parameterBindingId, state) &&
    getterReturnsModule(conditional.alternate, parameterBindingId, state)
  );
};

const isCanonicalGetterDefineCall = (
  node: t.Node,
  getterBindingId: string,
  loaderBindingIds: ReadonlySet<string>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const call = unwrapJavaScriptExpression(node).node;
  if (!t.isCallExpression(call) || call.arguments.length !== 2) return false;
  const callee = unwrapJavaScriptExpression(call.callee).node;
  if (
    !t.isMemberExpression(callee) ||
    semanticStaticPropertyKey(callee.property, callee.computed) !== "d" ||
    !isDefiniteLoaderReceiver(callee.object, loaderBindingIds, state)
  )
    return false;
  const [targetArg, descriptorArg] = call.arguments;
  if (
    targetArg === undefined ||
    descriptorArg === undefined ||
    t.isSpreadElement(targetArg) ||
    t.isSpreadElement(descriptorArg) ||
    !sameBinding(
      unwrapJavaScriptExpression(targetArg).node,
      getterBindingId,
      state,
    )
  )
    return false;
  const descriptor = unwrapJavaScriptExpression(descriptorArg).node;
  if (!t.isObjectExpression(descriptor) || descriptor.properties.length !== 1)
    return false;
  const [property] = descriptor.properties;
  return (
    t.isObjectProperty(property) &&
    !property.computed &&
    semanticStaticPropertyKey(property.key, false) === "a" &&
    sameBinding(
      unwrapJavaScriptExpression(property.value).node,
      getterBindingId,
      state,
    )
  );
};

const isDefiniteLoaderReceiver = (
  node: t.Node,
  loaderBindingIds: ReadonlySet<string>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let current = unwrapJavaScriptExpression(node).node;
  let visitedBindings: ReadonlySet<string> = new Set();
  while (t.isIdentifier(current)) {
    if (semanticResolutionBlocked(state, current, current.name)) return false;
    const binding = resolveSemanticBindingState(state, current, current.name);
    if (binding === undefined) return false;
    if (
      state.opaqueEffects.byScope.size > 0 &&
      semanticOpaqueBindingReadMayHaveChanged(binding, current, state)
    )
      return false;
    if (loaderBindingIds.has(binding.bindingId)) {
      return (
        singleDefinition(state, binding.bindingId, "function") ||
        semanticBindingAtRead(binding, current, state).hasDefiniteInitializer ||
        semanticStableBindingInitializedBeforeRead(binding, current, state)
      );
    }
    const alias = readBundledAliasInitializer(current, state, visitedBindings);
    if (alias === undefined || alias.projection.length !== 0) return false;
    current = unwrapJavaScriptExpression(alias.node).node;
    visitedBindings = alias.nextVisited;
  }
  return false;
};

const isInstalledBeforeEntryDispatch = (
  write: t.AssignmentExpression,
  expectedProperty: "n" | "d" | "o",
  bootstrap: Bootstrap,
  loaderBindingIds: ReadonlySet<string>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const left = unwrapJavaScriptExpression(write.left).node;
  if (
    !t.isMemberExpression(left) ||
    semanticStaticPropertyKey(left.property, left.computed) !==
      expectedProperty ||
    !isDefiniteLoaderReceiver(left.object, loaderBindingIds, state)
  )
    return false;
  let current: t.Node = write;
  let parent = state.parentsByNode.get(current);
  while (t.isSequenceExpression(parent)) {
    current = parent;
    parent = state.parentsByNode.get(current);
  }
  if (!t.isExpressionStatement(parent)) return false;
  const { body } = bootstrap;
  const writeIndex = body.body.indexOf(parent);
  if (writeIndex < 0) return false;
  let entryIndex = -1;
  let entryOffset = -1;
  for (let index = 0; index < body.body.length; index += 1) {
    const topLevel = body.body[index];
    if (topLevel === undefined) continue;
    traverseJavaScriptValueAst(topLevel, state.erasedSyntaxNodes, {
      enter: (node, _parent, ancestors) => {
        if (
          entryIndex >= 0 ||
          !t.isCallExpression(node) ||
          ancestors().some((ancestor) => t.isFunction(ancestor))
        )
          return;
        const callee = unwrapJavaScriptExpression(node.callee).node;
        const isInlineEntry =
          bootstrap.inlineCall !== undefined && node === bootstrap.inlineCall;
        const isBoundLoaderCall =
          t.isIdentifier(callee) &&
          loaderBindingIds.has(
            resolveSemanticBindingState(state, callee, callee.name)
              ?.bindingId ?? "",
          );
        if (isInlineEntry || isBoundLoaderCall) {
          entryIndex = index;
          entryOffset = node.start ?? -1;
        }
      },
    });
    if (entryIndex >= 0) break;
  }
  return (
    entryIndex > writeIndex ||
    (entryIndex === writeIndex &&
      (write.end ?? Number.POSITIVE_INFINITY) < entryOffset)
  );
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

const zeroArgThunkReturn = (node: t.Node): t.Node | undefined => {
  const thunk = unwrapJavaScriptExpression(node).node;
  if (
    (!t.isArrowFunctionExpression(thunk) && !t.isFunctionExpression(thunk)) ||
    thunk.async ||
    thunk.generator ||
    runtimeFunctionParameters(thunk).length !== 0
  )
    return undefined;
  if (t.isBlockStatement(thunk.body)) {
    const [statement] = thunk.body.body;
    return thunk.body.body.length === 1 &&
      t.isReturnStatement(statement) &&
      statement.argument != null
      ? unwrapJavaScriptExpression(statement.argument).node
      : undefined;
  }
  return unwrapJavaScriptExpression(thunk.body).node;
};

const getterReturnsDefault = (
  node: t.Node,
  bindingId: string,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const returned = zeroArgThunkReturn(node);
  return (
    returned !== undefined &&
    t.isMemberExpression(returned) &&
    semanticStaticPropertyKey(returned.property, returned.computed) ===
      "default" &&
    sameBinding(
      unwrapJavaScriptExpression(returned.object).node,
      bindingId,
      state,
    )
  );
};

const getterReturnsModule = (
  node: t.Node,
  bindingId: string,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const returned = zeroArgThunkReturn(node);
  return returned !== undefined && sameBinding(returned, bindingId, state);
};

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
    ![...bootstrap.loaderSelfBindingIds].every(
      (id) =>
        (singleDefinition(state, id, "function") ||
          (id === bootstrap.loaderBindingId &&
            isStableVariableLoader(state, id, bootstrap.loader))) &&
        (state.bindingWrites.get(id)?.length ?? 0) === 0,
    )
  )
    return null;
  const loaderBindingIds = new Set(bootstrap.loaderSelfBindingIds);
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
      bootstrap,
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

const isStableVariableLoader = (
  state: JavaScriptSemanticAnalysisState,
  bindingId: string,
  loader: t.Node,
): boolean => {
  if (!singleDefinition(state, bindingId, "variable")) return false;
  const binding = state.bindingsById.get(bindingId);
  const initializer = semanticStableInitializer(binding, state);
  return (
    initializer !== undefined &&
    initializer.projection.length === 0 &&
    unwrapJavaScriptExpression(initializer.node).node === loader
  );
};

const singleDefinition = (
  state: JavaScriptSemanticAnalysisState,
  bindingId: string,
  kind: "function" | "parameter" | "variable",
): boolean => {
  const definitions = state.bindingsById.get(bindingId)?.definitions;
  return definitions?.length === 1 && definitions[0]?.kind === kind;
};
