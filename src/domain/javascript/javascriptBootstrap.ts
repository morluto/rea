import * as t from "@babel/types";

import {
  javaScriptExpressionWrapperTarget,
  semanticStaticPropertyKey,
  runtimeFunctionParameters,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticStableBindingInitializedBeforeRead } from "./javascriptSemanticMutationInitializers.js";
import { moduleFactory } from "./javascriptStaticAnalysisHelpers.js";
import { semanticIdentifierRole } from "./javascriptSemanticProjection.js";
import {
  traverseJavaScriptAst,
  traverseJavaScriptValueAst,
} from "./javascriptSemanticTraversal.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";

type BootstrapLoader =
  | (t.FunctionDeclaration & { readonly body: t.BlockStatement })
  | (t.FunctionExpression & { readonly body: t.BlockStatement })
  | (t.ArrowFunctionExpression & { readonly body: t.BlockStatement });

/** A literal module table dispatched by a standalone CommonJS-style runtime. */
interface JavaScriptBootstrap {
  readonly body: t.BlockStatement;
  readonly table: t.ObjectExpression;
  readonly loader: BootstrapLoader;
  readonly loaderName: string;
  readonly loaderBindingId: string;
  readonly loaderSelfBindingIds: ReadonlySet<string>;
  readonly inlineCall?: t.CallExpression;
  readonly tableBindingId: string;
}

interface LoaderCandidate {
  readonly loader: BootstrapLoader;
  readonly loaderName: string;
  readonly loaderBindingId: string;
  readonly loaderSelfBindingIds: ReadonlySet<string>;
  readonly inlineCall?: t.CallExpression;
}

/** Recognize syntax, never invoke a bootstrap or infer it from variable names. */
export const javascriptBootstrapAt = (
  call: t.CallExpression,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptBootstrap | undefined => {
  const outerCallee = unwrapJavaScriptExpression(call.callee).node;
  if (
    (!t.isFunctionExpression(outerCallee) &&
      !t.isArrowFunctionExpression(outerCallee)) ||
    !t.isBlockStatement(outerCallee.body) ||
    runtimeFunctionParameters(outerCallee).length !== 0 ||
    call.arguments.length !== 0
  )
    return undefined;
  const body = outerCallee.body;
  const tables = new Map<string, t.ObjectExpression>();
  for (const statement of body.body) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declaration of statement.declarations) {
      if (
        t.isIdentifier(declaration.id) &&
        t.isObjectExpression(declaration.init) &&
        declaration.init.properties.length > 0 &&
        declaration.init.properties.every(
          (property) => moduleFactory(property) !== undefined,
        )
      ) {
        const binding = resolveSemanticBindingState(
          state,
          declaration.id,
          declaration.id.name,
        );
        if (
          binding !== undefined &&
          semanticStableInitializer(binding, state)?.node === declaration.init
        )
          tables.set(binding.bindingId, declaration.init);
      }
    }
  }
  if (tables.size === 0) return undefined;
  for (const candidate of collectLoaderCandidates(body, state)) {
    const { loader } = candidate;
    if (
      loader.async ||
      loader.generator ||
      runtimeFunctionParameters(loader).length !== 1
    )
      continue;
    const parameter = runtimeFunctionParameters(loader)[0];
    if (!t.isIdentifier(parameter)) continue;
    const parameterBindingId = bindingId(state, parameter);
    if (parameterBindingId === undefined) continue;
    let tableBindingId: string | undefined;
    traverseJavaScriptAst(loader.body, {
      enter: (node, _parent, ancestors) => {
        if (
          !t.isCallExpression(node) ||
          ancestors().some((ancestor) => t.isFunction(ancestor))
        )
          return;
        const matchedTable = dispatchedTableBinding(
          node,
          candidate.loaderSelfBindingIds,
          parameterBindingId,
          state,
        );
        if (matchedTable !== undefined && tables.has(matchedTable))
          tableBindingId = matchedTable;
      },
    });
    const table =
      tableBindingId === undefined ? undefined : tables.get(tableBindingId);
    if (table !== undefined && tableBindingId !== undefined)
      return {
        body,
        table,
        loader,
        loaderName: candidate.loaderName,
        loaderBindingId: candidate.loaderBindingId,
        loaderSelfBindingIds: candidate.loaderSelfBindingIds,
        ...(candidate.inlineCall === undefined
          ? {}
          : { inlineCall: candidate.inlineCall }),
        tableBindingId,
      };
  }
  return undefined;
};

const collectLoaderCandidates = (
  body: t.BlockStatement,
  state: JavaScriptSemanticAnalysisState,
): readonly LoaderCandidate[] => {
  const candidates: LoaderCandidate[] = [];
  for (const statement of body.body) {
    if (
      t.isFunctionDeclaration(statement) &&
      t.isIdentifier(statement.id) &&
      t.isBlockStatement(statement.body)
    ) {
      const id = unreassignedBindingId(state, statement.id, "function");
      if (id !== undefined)
        candidates.push({
          loader: statement,
          loaderName: statement.id.name,
          loaderBindingId: id,
          loaderSelfBindingIds: new Set([id]),
        });
      continue;
    }
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declaration of statement.declarations) {
      if (!t.isIdentifier(declaration.id) || declaration.init == null) continue;
      const initNode = unwrapJavaScriptExpression(declaration.init).node;
      if (!isBlockFunctionExpression(initNode)) continue;
      const outerBinding = resolveSemanticBindingState(
        state,
        declaration.id,
        declaration.id.name,
      );
      if (
        outerBinding === undefined ||
        semanticStableInitializer(outerBinding, state)?.node !==
          declaration.init ||
        !isUnreassignedBinding(outerBinding, "variable", state) ||
        hasTopLevelReferenceBeforeInitializer(
          body,
          outerBinding,
          declaration,
          state,
        )
      )
        continue;
      const selfIds = new Set([outerBinding.bindingId]);
      if (t.isFunctionExpression(initNode) && initNode.id != null) {
        if (!t.isIdentifier(initNode.id)) continue;
        const innerId = unreassignedBindingId(state, initNode.id, "function");
        if (innerId === undefined) continue;
        selfIds.add(innerId);
      }
      candidates.push({
        loader: initNode,
        loaderName: declaration.id.name,
        loaderBindingId: outerBinding.bindingId,
        loaderSelfBindingIds: selfIds,
      });
    }
  }
  traverseJavaScriptAst(body, {
    skip: (node) => t.isFunction(node),
    enter: (node) => {
      if (
        !t.isCallExpression(node) ||
        node.arguments.length !== 1 ||
        t.isSpreadElement(node.arguments[0])
      )
        return;
      const callee = unwrapJavaScriptExpression(node.callee).node;
      if (
        !t.isFunctionExpression(callee) ||
        !t.isIdentifier(callee.id) ||
        !isBlockFunctionExpression(callee)
      )
        return;
      const innerId = unreassignedBindingId(state, callee.id, "function");
      if (innerId === undefined) return;
      candidates.push({
        loader: callee,
        loaderName: callee.id.name,
        loaderBindingId: innerId,
        loaderSelfBindingIds: new Set([innerId]),
        inlineCall: node,
      });
    },
  });
  return candidates;
};

const isBlockFunctionExpression = (
  node: t.Node,
): node is
  | (t.FunctionExpression & { readonly body: t.BlockStatement })
  | (t.ArrowFunctionExpression & { readonly body: t.BlockStatement }) =>
  (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) &&
  t.isBlockStatement(node.body);

const isUnreassignedBinding = (
  binding: JavaScriptSemanticBindingState,
  kind: "function" | "variable",
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  binding.definitions.length === 1 &&
  binding.definitions[0]?.kind === kind &&
  (state.bindingWrites.get(binding.bindingId)?.length ?? 0) === 0;

const unreassignedBindingId = (
  state: JavaScriptSemanticAnalysisState,
  identifier: t.Identifier,
  kind: "function" | "variable",
): string | undefined => {
  const binding = resolveSemanticBindingState(
    state,
    identifier,
    identifier.name,
  );
  return binding !== undefined && isUnreassignedBinding(binding, kind, state)
    ? binding.bindingId
    : undefined;
};

const inertUnaryOperators = new Set(["void", "typeof", "!"]);

const isDeferredClosureNode = (
  node: t.Node,
): node is
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression
  | t.ObjectMethod
  | t.ClassMethod
  | t.ClassPrivateMethod =>
  t.isFunctionDeclaration(node) ||
  t.isFunctionExpression(node) ||
  t.isArrowFunctionExpression(node) ||
  t.isObjectMethod(node) ||
  t.isClassMethod(node) ||
  t.isClassPrivateMethod(node);

const isDeferredSubtreeOfClosure = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  if (
    t.isFunctionDeclaration(node) ||
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node)
  )
    return true;
  const parent = parents.get(node);
  return (
    parent !== undefined &&
    (t.isObjectMethod(parent) ||
      t.isClassMethod(parent) ||
      t.isClassPrivateMethod(parent)) &&
    (node === parent.body || parent.params.includes(node as never))
  );
};

const isInsideDeferredClosureBody = (
  node: t.Node,
  root: t.BlockStatement,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  let child: t.Node = node;
  for (
    let current = parents.get(node);
    current !== undefined && current !== root;
    child = current, current = parents.get(current)
  ) {
    if (
      isDeferredClosureNode(current) &&
      (child === current.body || current.params.includes(child as never))
    )
      return true;
  }
  return false;
};

const isInertLiteralNode = (node: t.Node): boolean =>
  t.isStringLiteral(node) ||
  t.isNumericLiteral(node) ||
  t.isBooleanLiteral(node) ||
  t.isNullLiteral(node) ||
  t.isBigIntLiteral(node) ||
  t.isRegExpLiteral(node) ||
  (t.isTemplateLiteral(node) && node.expressions.length === 0);

const isInertPrefixNode = (node: t.Node): boolean => {
  if (
    t.isFunctionDeclaration(node) ||
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node) ||
    isInertLiteralNode(node) ||
    javaScriptExpressionWrapperTarget(node) !== undefined
  )
    return true;
  if (
    t.isBlockStatement(node) ||
    t.isVariableDeclaration(node) ||
    t.isExpressionStatement(node) ||
    t.isEmptyStatement(node) ||
    t.isIdentifier(node) ||
    t.isPrivateName(node) ||
    t.isClassBody(node)
  )
    return true;
  if (t.isClassDeclaration(node) || t.isClassExpression(node))
    return (node.decorators?.length ?? 0) === 0 && node.superClass == null;
  if (t.isObjectMethod(node) || t.isClassMethod(node))
    return !node.computed && (node.decorators?.length ?? 0) === 0;
  if (t.isClassPrivateMethod(node)) return (node.decorators?.length ?? 0) === 0;
  if (t.isClassProperty(node))
    return (
      !node.static && !node.computed && (node.decorators?.length ?? 0) === 0
    );
  if (t.isClassPrivateProperty(node))
    return !node.static && (node.decorators?.length ?? 0) === 0;
  if (t.isVariableDeclarator(node)) return t.isIdentifier(node.id);
  if (t.isObjectExpression(node))
    return node.properties.every((p) => !t.isSpreadElement(p));
  if (t.isArrayExpression(node))
    return node.elements.every((e) => e === null || !t.isSpreadElement(e));
  if (t.isObjectProperty(node)) return !node.computed;
  return t.isUnaryExpression(node) && inertUnaryOperators.has(node.operator);
};

const hasOnlyInertPrefixBeforeDeclarator = (
  body: t.BlockStatement,
  declarator: t.VariableDeclarator,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const limit = declarator.start ?? Number.POSITIVE_INFINITY;
  let inert = true;
  traverseJavaScriptValueAst(body, state.erasedSyntaxNodes, {
    skip: (node) =>
      !inert ||
      node === declarator ||
      (node !== body && (node.start ?? Number.POSITIVE_INFINITY) >= limit) ||
      isDeferredSubtreeOfClosure(node, state.parentsByNode),
    enter: (node) => {
      if (!isInertPrefixNode(node)) inert = false;
    },
  });
  return inert;
};

const hasTopLevelReferenceBeforeInitializer = (
  body: t.BlockStatement,
  outerBinding: JavaScriptSemanticBindingState,
  declarator: t.VariableDeclarator,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let inertPrefix: boolean | undefined;
  let before = false;
  traverseJavaScriptValueAst(body, state.erasedSyntaxNodes, {
    skip: (node) => before || node === declarator.init,
    enter: (node, parent, readAncestors) => {
      if (
        !t.isIdentifier(node) ||
        parent === null ||
        node === declarator.id ||
        semanticIdentifierRole(node, parent, readAncestors) === null ||
        bindingId(state, node) !== outerBinding.bindingId
      )
        return;
      if (semanticStableBindingInitializedBeforeRead(outerBinding, node, state))
        return;
      if (!isInsideDeferredClosureBody(node, body, state.parentsByNode)) {
        before = true;
        return;
      }
      inertPrefix ??= hasOnlyInertPrefixBeforeDeclarator(
        body,
        declarator,
        state,
      );
      if (!inertPrefix) before = true;
    },
  });
  return before;
};

const dispatchedTableBinding = (
  call: t.CallExpression,
  loaderBindingIds: ReadonlySet<string>,
  keyBindingId: string,
  state: JavaScriptSemanticAnalysisState,
): string | undefined => {
  const member = call.callee;
  const viaCall =
    t.isMemberExpression(member) &&
    semanticStaticPropertyKey(member.property, member.computed) === "call";
  const dispatch =
    viaCall && t.isMemberExpression(member) ? member.object : member;
  if (
    !t.isMemberExpression(dispatch) ||
    !dispatch.computed ||
    !t.isIdentifier(dispatch.object) ||
    !t.isIdentifier(dispatch.property) ||
    bindingId(state, dispatch.property) !== keyBindingId
  )
    return undefined;
  const args = viaCall ? call.arguments.slice(1) : call.arguments;
  const [module, exports, require] = args;
  if (
    args.length !== 3 ||
    !t.isIdentifier(module) ||
    bindingId(state, module) === undefined ||
    !t.isMemberExpression(exports) ||
    !t.isIdentifier(exports.object) ||
    bindingId(state, exports.object) !== bindingId(state, module) ||
    semanticStaticPropertyKey(exports.property, exports.computed) !==
      "exports" ||
    !t.isIdentifier(require) ||
    !loaderBindingIds.has(bindingId(state, require) ?? "")
  )
    return undefined;
  if (
    viaCall &&
    (!t.isNode(call.arguments[0]) ||
      !t.isNodesEquivalent(call.arguments[0], exports))
  )
    return undefined;
  return bindingId(state, dispatch.object);
};

const bindingId = (
  state: JavaScriptSemanticAnalysisState,
  identifier: t.Identifier,
): string | undefined =>
  resolveSemanticBindingState(state, identifier, identifier.name)?.bindingId;
