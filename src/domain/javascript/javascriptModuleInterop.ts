import { parseExpression } from "@babel/parser";
import * as t from "@babel/types";

import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  semanticScopeId,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { semanticOpaqueBindingReadMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import {
  semanticEffectTiming,
  semanticTopLevelEffectIsOrderable,
  isUnshadowedGlobal,
} from "./javascriptSemanticMutationInitializers.js";
import { readSemanticRequireOrigin } from "./javascriptSemanticRequireOriginSlot.js";
import {
  childNodes,
  javaScriptAstChildKeys,
} from "./javascriptSemanticTraversal.js";
import {
  electronMemberPath,
  type JavaScriptIntrinsicInvocation,
} from "./javascriptElectronMemberWrites.js";
import {
  expandJavaScriptInvocationArguments,
  resolveJavaScriptIntrinsicInvocation,
} from "./javascriptIntrinsicInvocation.js";
import {
  SemanticPropertyPathWriteIndex,
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  isPrimitiveJavaScriptExpression,
  javaScriptExpressionValue,
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  runtimeFunctionParameters,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticKnownArrayIterationAt } from "./javascriptSemanticReferenceSources.js";

// Match the complete Rolldown runtime operations, including its live getters.
// Names and formatting are irrelevant; lexical roles, operators and keys are not.
const TO_ESM = parseExpression(`(mod, isNodeMode, target) => (
  target = mod != null ? __create(__getProtoOf(mod)) : {},
  __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default")
    ? __defProp(target, "default", {value: mod, enumerable: true}) : target, mod)
)`);
const COPY_PROPS = parseExpression(`(to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function")
    for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
      key = keys[i];
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: ((k) => from[k]).bind(null, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
    }
  return to;
}`);
const INTRINSICS: Readonly<Record<string, readonly string[]>> = {
  __create: ["Object", "create"],
  __getProtoOf: ["Object", "getPrototypeOf"],
  __defProp: ["Object", "defineProperty"],
  __getOwnPropNames: ["Object", "getOwnPropertyNames"],
  __getOwnPropDesc: ["Object", "getOwnPropertyDescriptor"],
  __hasOwnProp: ["Object", "prototype", "hasOwnProperty"],
};

interface IntrinsicDependency {
  readonly path: readonly string[];
  readonly capturedAt?: t.Node;
}

interface InteropOrigin {
  readonly origin: JavaScriptModuleOrigin;
  readonly dependencies: readonly IntrinsicDependency[];
  readonly defaultIsModule: boolean;
}

interface InteropHelper {
  readonly dependencies: readonly IntrinsicDependency[];
  readonly readyAfter: number;
  readonly identity: boolean;
}

/** Prove one inert namespace conversion without relaxing general assignment semantics. */
export const createSemanticModuleInterop = (
  state: JavaScriptSemanticAnalysisState,
  options?: {
    readonly intrinsicPath: (node: t.Node) => readonly string[] | undefined;
  },
) => {
  const nativeArrayIteration = (array: t.ArrayExpression) =>
    semanticKnownArrayIterationAt(array, state);
  const helpers = new Map<string, InteropHelper | null>();
  const origins = new Map<string, InteropOrigin>();
  const calls = new WeakMap<t.Node, InteropOrigin>();
  const intrinsicBindings = new Map<string, readonly string[] | null>();
  const writes = new Map<string, SemanticPropertyPathWriteIndex>();
  const deferredIntrinsicWrites = new SemanticPropertyPathWriteIndex();
  let inertPrefixEnd: number | undefined;
  const capturePrecedesActivation = (capture: t.Node): boolean => {
    if (inertPrefixEnd === undefined) {
      inertPrefixEnd = -Infinity;
      // Imports can run before the first statement regardless of source order.
      if (
        !state.program.body.some(
          (node) =>
            t.isImportDeclaration(node) ||
            ((t.isExportNamedDeclaration(node) ||
              t.isExportAllDeclaration(node)) &&
              node.source !== null),
        )
      ) {
        prefix: for (const statement of state.program.body) {
          if (
            t.isFunctionDeclaration(statement) ||
            t.isEmptyStatement(statement)
          )
            continue;
          if (
            !t.isVariableDeclaration(statement) ||
            !["var", "let", "const"].includes(statement.kind)
          )
            break;
          for (const declaration of statement.declarations) {
            if (!t.isIdentifier(declaration.id)) break prefix;
            const value = declaration.init;
            if (
              value != null &&
              !t.isFunctionExpression(value) &&
              !t.isArrowFunctionExpression(value) &&
              !readExactJavaScriptLiteral(value).found &&
              !t.isBigIntLiteral(value)
            ) {
              const { root, members } = electronMemberPath(value);
              if (
                !isUnshadowedGlobal(root, state, "Object") ||
                !Object.values(INTRINSICS).some(
                  (path) =>
                    path.length === members.length + 1 &&
                    path.slice(1).every((key, i) => key === members[i]),
                )
              )
                break prefix;
            }
            inertPrefixEnd = declaration.end ?? -Infinity;
          }
        }
      }
    }
    // Only an inert initial prefix proves that no source-local callable could
    // have run yet. A function declaration's position alone proves no ordering.
    return (
      semanticTopLevelEffectIsOrderable(capture, state.parentsByNode) &&
      (capture.end ?? Infinity) <= inertPrefixEnd
    );
  };
  // Retain assigned values with their owning slot and write site. Bucket by
  // the exact prefix before any selector so unrelated slots are not rescanned.
  const assignedValues = new Map<
    string,
    {
      node:
        | t.AssignmentExpression
        | t.CallExpression
        | t.OptionalCallExpression;
      path: JavaScriptSemanticPropertyPath;
    }[]
  >();
  const invalidatedBindings = new Map<string, boolean>();
  const invalidatedCalls = new WeakMap<t.Node, boolean>();
  const opaqueMutationPath = (node: t.Node): readonly string[] => {
    let current: t.Node | undefined = node;
    while (current !== undefined) {
      if (t.isFunction(current))
        return ["opaque-intrinsic", semanticScopeId("function", current)];
      current = state.parentsByNode.get(current);
    }
    return ["intrinsic"];
  };
  const retainWrite = (
    node: t.Node | undefined,
    path: JavaScriptSemanticPropertyPath,
  ) => {
    const scope =
      node === undefined ? "intrinsic" : opaqueMutationPath(node).join(".");
    const deferred =
      scope !== "intrinsic" &&
      path[0] === "intrinsic" &&
      typeof path[1] === "string";
    let index = deferred ? deferredIntrinsicWrites : writes.get(scope);
    if (index === undefined) {
      index = new SemanticPropertyPathWriteIndex();
      writes.set(scope, index);
    }
    index.retain(
      path[0] === "opaque-intrinsic" ? ["intrinsic"] : path,
      // A write takes effect after evaluating its inputs. Its source start
      // precedes nested RHS calls even though those calls still see the old slot.
      // A write to a known intrinsic owner in another activation has no proven
      // ordering relative to this read. Unknown global roots and opaque-call
      // fallbacks retain the existing scoped uncertainty.
      deferred ? -Infinity : (node?.end ?? -Infinity),
    );
    if (
      ((t.isAssignmentExpression(node) &&
        ["=", "||=", "&&=", "??="].includes(node.operator)) ||
        t.isCallExpression(node) ||
        t.isOptionalCallExpression(node)) &&
      path[0] === "intrinsic"
    ) {
      const selector = path.findIndex(
        (key) => key === null || typeof key === "object",
      );
      const key = JSON.stringify(
        (selector < 0 ? path : path.slice(0, selector)).map(String),
      );
      const values = assignedValues.get(key) ?? [];
      values.push({ node, path });
      assignedValues.set(key, values);
    }
  };
  const changedBefore = (capture: t.Node, path: readonly string[]): boolean => {
    const scope = opaqueMutationPath(capture).join(".");
    const offset = semanticTopLevelEffectIsOrderable(
      capture,
      state.parentsByNode,
    )
      ? (capture.start ?? -1)
      : Infinity;
    return (
      (deferredIntrinsicWrites.precedes(path, Infinity) &&
        !capturePrecedesActivation(capture)) ||
      writes.get("intrinsic")?.precedes(path, offset) === true ||
      (scope !== "intrinsic" &&
        writes.get(scope)?.precedes(path, offset) === true)
    );
  };
  // Consumers created after ambient indexing must see the same invocation
  // mutations as the collector that supplies retainWrite during indexing.
  for (const effect of state.ambientWriteEffects)
    if (effect.path[0] === "global")
      retainWrite(effect.node, ["intrinsic", ...effect.path.slice(1)]);

  const intrinsicPath =
    options?.intrinsicPath ??
    ((node: t.Node): readonly string[] | undefined => {
      let current = node;
      const visited = new Set<string>();
      const pending: { id: string; suffixLength: number }[] = [];
      let suffix: readonly string[] = [];
      const finish = (
        path: readonly string[] | undefined,
      ): readonly string[] | undefined => {
        for (const binding of pending)
          intrinsicBindings.set(
            binding.id,
            path === undefined
              ? null
              : path.slice(0, path.length - binding.suffixLength),
          );
        return path;
      };
      for (;;) {
        const { root, members } = electronMemberPath(
          javaScriptExpressionValue(current),
        );
        if (members.some((member) => member === null)) return finish(undefined);
        suffix = [...(members as readonly string[]), ...suffix];
        const value = javaScriptExpressionValue(root);
        if (value !== root) {
          current = value;
          continue;
        }
        for (const global of ["Object", "Function", "Reflect"])
          if (isUnshadowedGlobal(root, state, global))
            return finish(["intrinsic", global, ...suffix]);
        for (const global of ["globalThis", "global", "window", "self"])
          if (isUnshadowedGlobal(root, state, global))
            return finish(["intrinsic", ...suffix]);
        if (!t.isIdentifier(root)) return finish(undefined);
        const binding = resolveSemanticBindingState(state, root, root.name);
        const cached =
          binding === undefined
            ? undefined
            : intrinsicBindings.get(binding.bindingId);
        if (cached !== undefined)
          return finish(cached === null ? undefined : [...cached, ...suffix]);
        const initializer = semanticStableInitializer(binding, state);
        if (
          binding === undefined ||
          initializer === undefined ||
          initializer.projection.some((segment) => segment === null) ||
          visited.has(binding.bindingId)
        )
          return finish(undefined);
        visited.add(binding.bindingId);
        pending.push({ id: binding.bindingId, suffixLength: suffix.length });
        suffix = [...initializer.projection.map(String), ...suffix];
        current = initializer.node;
      }
    });

  // A nominal alias path is sufficient for conservative mutation lookup, but
  // helper proof also needs each read to follow initialization. An alias copy
  // retains the earlier function capture; a member read captures it anew.
  const capturedIntrinsic = (node: t.Node): IntrinsicDependency | undefined => {
    const path = intrinsicPath(node);
    if (path === undefined) return undefined;
    const visited = new Set<string>();
    let current = node;
    let capturedAt = node;
    let suffixLength = 0;
    for (;;) {
      const { root, members } = electronMemberPath(
        javaScriptExpressionValue(current),
      );
      suffixLength += members.length;
      const value = javaScriptExpressionValue(root);
      if (value !== root) {
        current = value;
        continue;
      }
      if (!t.isIdentifier(root)) return undefined;
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (binding === undefined) return { path, capturedAt };
      const initializer = semanticStableInitializer(binding, state);
      if (
        initializer === undefined ||
        (initializer.node.end ?? Infinity) >= (root.start ?? -1) ||
        visited.has(binding.bindingId)
      )
        return undefined;
      visited.add(binding.bindingId);
      if (suffixLength === 0) capturedAt = initializer.node;
      suffixLength += initializer.projection.length;
      current = initializer.node;
    }
  };

  const intrinsicValueReferences = (
    node: t.Node,
  ): readonly {
    node: t.Node;
    path: JavaScriptSemanticPropertyPath;
    readAt?: t.Node;
  }[] => {
    const capture = capturedIntrinsic(node);
    if (capture === undefined) return [];
    const result: {
      node: t.Node;
      path: JavaScriptSemanticPropertyPath;
      readAt?: t.Node;
    }[] = [];
    for (let length = 0; length <= capture.path.length; length++) {
      const values = assignedValues.get(
        JSON.stringify(capture.path.slice(0, length)),
      );
      for (const value of values ?? []) {
        if (
          value.path.length <= capture.path.length &&
          value.path.every((key, index) =>
            semanticPropertyPathKeyMatches(key, capture.path[index]!),
          ) &&
          semanticEffectTiming(
            capture.capturedAt ?? node,
            value.node,
            state,
          ) !== "after"
        ) {
          const suffix = capture.path.slice(value.path.length);
          if (t.isAssignmentExpression(value.node)) {
            result.push({ node: value.node.right, path: suffix });
            continue;
          }
          // The same invocation owner supplies native arguments for call,
          // apply and bind. Select only the written slot from copied maps or
          // descriptors; exposing their other properties invents aliases.
          const invocation = resolveJavaScriptIntrinsicInvocation(
            value.node,
            intrinsicPath,
            boundIntrinsic,
            intrinsicReadChanged,
            nativeArrayIteration,
          );
          const args = invocation?.arguments;
          if (
            invocation?.kind !== "known" ||
            args === undefined ||
            args.some(t.isSpreadElement)
          )
            continue;
          const operation = invocation.path.join(".");
          const key = capture.path[value.path.length - 1]!;
          if (operation === "intrinsic.Object.assign") {
            for (const source of args.slice(1))
              result.push({
                node: source,
                path: [key, ...suffix],
                readAt: value.node,
              });
          } else if (
            operation === "intrinsic.Object.defineProperties" &&
            args[1] !== undefined
          )
            result.push({
              node: args[1],
              path: [key, "value", ...suffix],
              readAt: value.node,
            });
          else if (
            [
              "intrinsic.Object.defineProperty",
              "intrinsic.Reflect.defineProperty",
            ].includes(operation) &&
            args[2] !== undefined
          )
            result.push({
              node: args[2],
              path: ["value", ...suffix],
              readAt: value.node,
            });
          else if (
            operation === "intrinsic.Reflect.set" &&
            args[2] !== undefined
          ) {
            // Omit the assigned value only for a proven separate receiver.
            // A conditional or unknown identity can still select the target.
            if (
              args[3] === undefined ||
              maySelectIntrinsic(args[3], value.path.slice(0, -1))
            )
              result.push({ node: args[2], path: suffix });
          }
        }
      }
    }
    return result;
  };

  const staticString = (
    node: t.Node | undefined,
    propertyKey = false,
  ): string | undefined => {
    if (node === undefined) return undefined;
    const visited = new Set<string>();
    let current = node;
    for (;;) {
      const literal = readExactJavaScriptLiteral(current);
      if (literal.found)
        return propertyKey
          ? String(literal.value)
          : typeof literal.value === "string"
            ? literal.value
            : undefined;
      const expression = unwrapJavaScriptExpression(current).node;
      if (propertyKey) {
        const key = semanticStaticPropertyKey(expression, true);
        if (key !== null) return key;
        if (
          isUnshadowedGlobal(expression, state, "undefined") ||
          t.isUnaryExpression(expression, { operator: "void" })
        )
          return "undefined";
        if (
          t.isUnaryExpression(expression) &&
          ["+", "-"].includes(expression.operator) &&
          t.isNumericLiteral(expression.argument)
        )
          return String(
            expression.operator === "-"
              ? -expression.argument.value
              : expression.argument.value,
          );
      }
      if (!t.isIdentifier(expression)) return undefined;
      const binding = resolveSemanticBindingState(
        state,
        expression,
        expression.name,
      );
      const initializer = semanticStableInitializer(binding, state);
      if (
        binding === undefined ||
        initializer === undefined ||
        initializer.projection.length !== 0 ||
        (initializer.node.end ?? Infinity) >= (expression.start ?? -1) ||
        visited.has(binding.bindingId) ||
        semanticOpaqueBindingReadMayHaveChanged(binding, expression, state)
      )
        return undefined;
      visited.add(binding.bindingId);
      current = initializer.node;
    }
  };

  const intrinsicReadChanged = (
    node: t.Node,
    path: readonly string[],
  ): boolean => {
    const capture = capturedIntrinsic(node)?.capturedAt ?? node;
    const method = path.at(-1);
    const invocationMethod =
      method === "bind" || method === "call" || method === "apply";
    return (
      changedBefore(capture, path) ||
      (invocationMethod &&
        changedBefore(capture, ["intrinsic", "Function", "prototype", method]))
    );
  };

  const resolveBoundIntrinsic = (
    node: t.Node,
  ): JavaScriptIntrinsicInvocation | undefined => {
    const visited = new Set<string>();
    const argumentGroups: t.CallExpression["arguments"][] = [];
    const bindReads: t.Node[] = [];
    let opaqueArguments = false;
    let receiver: t.Node | undefined;
    let current = node;
    for (;;) {
      current = unwrapJavaScriptExpression(current).node;
      if (t.isIdentifier(current)) {
        const binding = resolveSemanticBindingState(
          state,
          current,
          current.name,
        );
        const initializer = semanticStableInitializer(binding, state);
        if (
          binding === undefined ||
          initializer === undefined ||
          initializer.projection.length !== 0 ||
          (initializer.node.end ?? Infinity) >= (current.start ?? -1) ||
          visited.has(binding.bindingId)
        )
          return undefined;
        visited.add(binding.bindingId);
        current = initializer.node;
        continue;
      }
      if (!t.isCallExpression(current)) return undefined;
      const { root, members } = electronMemberPath(current.callee);
      let bindTarget = root;
      let bindingArguments: JavaScriptIntrinsicInvocation["arguments"] =
        expandJavaScriptInvocationArguments(
          current.arguments,
          nativeArrayIteration,
        );
      let captured = capturedIntrinsic(current.callee);
      let terminal = captured?.path.at(-1) === "bind";
      let path: readonly string[] | undefined = captured?.path.slice(0, -1);
      if (members.at(-1) === "bind") {
        // A direct .bind may continue a bound callable, without discarding members.
        if (!terminal && members.length !== 1) return undefined;
        bindReads.push(captured?.capturedAt ?? current.callee);
      } else {
        // Reuse the invocation owner for generic call/apply/Reflect.apply of bind.
        const invocation = resolveJavaScriptIntrinsicInvocation(
          current,
          intrinsicPath,
          boundIntrinsic,
          intrinsicReadChanged,
          nativeArrayIteration,
        );
        if (
          invocation?.kind !== "known" ||
          invocation.path.join(".") !== "intrinsic.Function.prototype.bind" ||
          invocation.receiver === undefined
        )
          return undefined;
        bindTarget = invocation.receiver;
        bindingArguments = invocation.arguments;
        captured = capturedIntrinsic(bindTarget);
        terminal = captured !== undefined;
        path = captured?.path;
      }
      receiver = bindingArguments?.[0];
      const ownArguments = bindingArguments?.slice(1) ?? [];
      opaqueArguments ||=
        bindingArguments === undefined || t.isSpreadElement(receiver);
      opaqueArguments ||= ownArguments.some((argument) =>
        t.isSpreadElement(argument),
      );
      argumentGroups.push(ownArguments);
      if (!terminal || path === undefined) {
        current = bindTarget;
        continue;
      }
      const boundPath = [...path, "bind"];
      const functionBind = ["intrinsic", "Function", "prototype", "bind"];
      opaqueArguments ||= bindReads.some((capture) => {
        return (
          changedBefore(capture, boundPath) ||
          changedBefore(capture, functionBind)
        );
      });
      return {
        kind: opaqueArguments ? "opaque" : "known",
        path,
        ...(receiver === undefined ? {} : { receiver }),
        // Rebinding appends arguments to the earlier bound argument list.
        arguments: opaqueArguments
          ? undefined
          : argumentGroups.toReversed().flat(),
      };
    }
  };

  const activeBoundValues = new WeakSet<t.Node>();
  const boundIntrinsic = (
    node: t.Node,
  ): JavaScriptIntrinsicInvocation | undefined => {
    if (activeBoundValues.has(node)) return undefined;
    activeBoundValues.add(node);
    try {
      return resolveBoundIntrinsic(node);
    } finally {
      activeBoundValues.delete(node);
    }
  };

  const stableFreshCandidate = (node: t.Node): t.Node | undefined => {
    const visited = new Set<string>();
    let current = node;
    for (;;) {
      current = javaScriptExpressionValue(current);
      if (!t.isIdentifier(current)) return current;
      const binding = resolveSemanticBindingState(state, current, current.name);
      const initializer = unprojectedInitializer(binding, state);
      if (
        binding === undefined ||
        initializer === undefined ||
        (!t.isFunctionDeclaration(initializer) &&
          (initializer.end ?? Infinity) >= (current.start ?? -1)) ||
        visited.has(binding.bindingId) ||
        semanticOpaqueBindingReadMayHaveChanged(binding, current, state)
      )
        return undefined;
      visited.add(binding.bindingId);
      current = initializer;
    }
  };

  const freshConstructors = new WeakMap<t.Node, boolean>();
  const constructsFreshObject = (node: t.Node): boolean => {
    const constructor = stableFreshCandidate(node);
    if (constructor === undefined) return false;
    const cached = freshConstructors.get(constructor);
    if (cached !== undefined) return cached;
    freshConstructors.set(constructor, false);
    let body: t.BlockStatement | undefined;
    if (t.isClass(constructor)) {
      // A derived constructor may inherit a constructor returning an existing
      // object; decorators can replace the constructor itself.
      if (constructor.superClass != null || constructor.decorators?.length)
        return false;
      body = constructor.body.body.find(
        (member): member is t.ClassMethod =>
          t.isClassMethod(member) && member.kind === "constructor",
      )?.body;
    } else if (
      (t.isFunctionExpression(constructor) ||
        t.isFunctionDeclaration(constructor)) &&
      !constructor.async &&
      !constructor.generator
    )
      body = constructor.body;
    else return false;
    const pending: t.Node[] = body === undefined ? [] : [body];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (t.isFunction(current) || t.isClass(current)) continue;
      if (t.isReturnStatement(current) && current.argument != null) {
        const value = unwrapJavaScriptExpression(current.argument).node;
        if (
          !t.isThisExpression(value) &&
          !readExactJavaScriptLiteral(value).found &&
          !t.isBigIntLiteral(value) &&
          !t.isUnaryExpression(value) &&
          !isUnshadowedGlobal(value, state, "undefined")
        )
          return false;
      }
      pending.push(...childNodes(current));
    }
    freshConstructors.set(constructor, true);
    return true;
  };

  const isFreshObject = (node: t.Node): boolean => {
    const current = stableFreshCandidate(node);
    if (current === undefined) return false;
    if (
      t.isObjectExpression(current) ||
      t.isArrayExpression(current) ||
      t.isFunction(current) ||
      (t.isClass(current) && !current.decorators?.length) ||
      t.isRegExpLiteral(current)
    )
      return true;
    if (t.isNewExpression(current))
      return constructsFreshObject(current.callee);
    if (t.isCallExpression(current)) {
      const invocation = resolveJavaScriptIntrinsicInvocation(
        current,
        intrinsicPath,
        boundIntrinsic,
        intrinsicReadChanged,
        nativeArrayIteration,
      );
      return (
        invocation?.kind === "known" &&
        invocation.path.join(".") === "intrinsic.Object.create"
      );
    }
    return false;
  };

  const maySelectIntrinsic = (
    node: t.Node,
    target: JavaScriptSemanticPropertyPath,
  ): boolean => {
    const pending = [node];
    const seen = new Set<t.Node>();
    while (pending.length > 0) {
      const value = javaScriptExpressionValue(pending.pop()!);
      const current = stableFreshCandidate(value) ?? value;
      if (seen.has(current)) continue;
      seen.add(current);
      if (t.isConditionalExpression(current)) {
        pending.push(current.consequent, current.alternate);
        continue;
      }
      if (t.isLogicalExpression(current)) {
        pending.push(current.left, current.right);
        continue;
      }
      const path = intrinsicPath(current);
      if (path !== undefined) {
        if (
          path.length === target.length &&
          target.every((key, index) =>
            semanticPropertyPathKeyMatches(key, path[index]!),
          )
        )
          return true;
      } else if (
        !isPrimitiveJavaScriptExpression(current) &&
        !isFreshObject(current)
      )
        return true;
    }
    return false;
  };

  const helperProof = (
    binding: JavaScriptSemanticBindingState,
  ): InteropHelper | undefined => {
    const cached = helpers.get(binding.bindingId);
    if (cached !== undefined) return cached ?? undefined;
    helpers.set(binding.bindingId, null);
    if (state.scopesById.get(binding.scopeId)?.kind !== "program")
      return undefined;
    const wrapper = unprojectedInitializer(binding, state);
    if (wrapper === undefined) return undefined;
    if (identityFunction(wrapper, state)) {
      const proof = {
        dependencies: [],
        readyAfter: t.isFunctionDeclaration(wrapper)
          ? -1
          : (wrapper.end ?? Infinity),
        identity: true,
      };
      helpers.set(binding.bindingId, proof);
      return proof;
    }
    const wrapperRoles = canonicalRoles(wrapper, TO_ESM, state);
    const copyBinding = wrapperRoles?.get("__copyProps");
    const copy = unprojectedInitializer(copyBinding, state);
    const copyRoles =
      copy === undefined ? undefined : canonicalRoles(copy, COPY_PROPS, state);
    if (
      wrapperRoles === undefined ||
      copyRoles === undefined ||
      copy === undefined
    )
      return undefined;
    const dependencies: IntrinsicDependency[] = [];
    let readyAfter = Math.max(wrapper.end ?? Infinity, copy.end ?? Infinity);
    for (const roles of [wrapperRoles, copyRoles])
      for (const [role, dependency] of roles) {
        const expected = INTRINSICS[role];
        if (expected === undefined) continue;
        const initializer = unprojectedInitializer(dependency, state);
        const captured =
          initializer === undefined
            ? undefined
            : capturedIntrinsic(initializer);
        if (
          initializer === undefined ||
          captured === undefined ||
          JSON.stringify(captured.path) !==
            JSON.stringify(["intrinsic", ...expected])
        )
          return undefined;
        readyAfter = Math.max(readyAfter, initializer.end ?? Infinity);
        dependencies.push(captured);
        if (role === "__hasOwnProp")
          dependencies.push({ path: [...captured.path, "call"] });
      }
    dependencies.push(
      { path: ["intrinsic", "Function", "prototype", "bind"] },
      { path: ["intrinsic", "Function", "prototype", "call"] },
    );
    const proof = {
      dependencies,
      identity: false,
      readyAfter,
    };
    helpers.set(binding.bindingId, proof);
    return proof;
  };

  const provenCall = (node: t.Node) => {
    if (!t.isCallExpression(node) || !t.isIdentifier(node.callee))
      return undefined;
    const helper = resolveSemanticBindingState(
      state,
      node.callee,
      node.callee.name,
    );
    const proof = helper === undefined ? undefined : helperProof(helper);
    const input = node.arguments[0];
    const mode = node.arguments[1];
    const literalMode =
      mode === undefined
        ? { found: true, value: false }
        : t.isExpression(mode)
          ? readExactJavaScriptLiteral(mode)
          : { found: false };
    if (
      proof === undefined ||
      proof.readyAfter >= (node.start ?? -1) ||
      !t.isExpression(input) ||
      node.arguments.length > 2 ||
      !literalMode.found
    )
      return undefined;
    return {
      input,
      // A truthy node mode forces the module-valued default. Other modes
      // preserve named exports without proving the source's default property.
      defaultIsModule: !proof.identity && Boolean(literalMode.value),
      dependencies: proof.dependencies.map((dependency) => ({
        ...dependency,
        capturedAt: dependency.capturedAt ?? node,
      })),
    };
  };

  const callOrigin = (node: t.Node): InteropOrigin | undefined => {
    const cached = calls.get(node);
    if (cached !== undefined) return cached;
    const { root, members } = electronMemberPath(node);
    if (!members.every((member): member is string => member !== null))
      return undefined;
    const converted = provenCall(root);
    const required =
      converted === undefined
        ? undefined
        : readSemanticRequireOrigin(converted.input, state)?.origin;
    if (
      converted === undefined ||
      required === undefined ||
      required.importedPath.length !== 0 ||
      (members[0] === "default" && !converted.defaultIsModule)
    )
      return undefined;
    const result = {
      origin: { ...required, importedPath: members },
      dependencies: converted.dependencies,
      defaultIsModule: converted.defaultIsModule,
    };
    calls.set(node, result);
    return result;
  };

  const origin = (
    binding: JavaScriptSemanticBindingState,
  ): InteropOrigin | undefined => {
    const single = semanticStableInitializer(binding, state);
    if (single !== undefined) {
      if (
        !single.projection.every(
          (key): key is string => typeof key === "string",
        )
      )
        return undefined;
      const converted = callOrigin(single.node);
      if (
        converted?.origin.importedPath.length === 0 &&
        single.projection[0] === "default" &&
        !converted.defaultIsModule
      )
        return undefined;
      const result =
        converted === undefined
          ? undefined
          : {
              ...converted,
              origin: {
                ...converted.origin,
                importedPath: [
                  ...converted.origin.importedPath,
                  ...single.projection,
                ],
              },
            };
      if (result !== undefined) origins.set(binding.bindingId, result);
      return result;
    }
    const [initial, converted] = binding.initializers;
    if (
      binding.definitions.length !== 2 ||
      binding.definitions[0]?.kind !== "variable" ||
      binding.definitions[1]?.kind !== "assignment" ||
      binding.initializers.length !== 2 ||
      initial === undefined ||
      converted === undefined ||
      initial.projection.length !== 0 ||
      converted.projection.length !== 0 ||
      state.conditionallySkippedExpressions.has(initial.node)
    )
      return undefined;
    const call = converted.node;
    const assignment = state.parentsByNode.get(call);
    const statement =
      assignment === undefined
        ? undefined
        : state.parentsByNode.get(assignment);
    const declaration = state.parentsByNode.get(initial.node);
    const declarationStatement =
      declaration === undefined
        ? undefined
        : state.parentsByNode.get(declaration);
    if (
      !t.isCallExpression(call) ||
      !t.isIdentifier(call.callee) ||
      !t.isAssignmentExpression(assignment, { operator: "=" }) ||
      assignment.right !== call ||
      !t.isIdentifier(assignment.left, { name: binding.name }) ||
      !t.isExpressionStatement(statement) ||
      !t.isVariableDeclarator(declaration) ||
      !t.isVariableDeclaration(declarationStatement) ||
      state.parentsByNode.get(statement) !==
        state.parentsByNode.get(declarationStatement) ||
      (initial.node.start ?? Infinity) >= (call.start ?? -1)
    )
      return undefined;
    const convertedCall = provenCall(call);
    const input = convertedCall?.input;
    if (
      !t.isIdentifier(input) ||
      resolveSemanticBindingState(state, input, input.name) !== binding
    )
      return undefined;
    const required = readSemanticRequireOrigin(initial.node, state)?.origin;
    if (required === undefined || required.importedPath.length !== 0)
      return undefined;
    if (convertedCall === undefined) return undefined;
    const result = {
      origin: required,
      dependencies: convertedCall.dependencies,
      defaultIsModule: convertedCall.defaultIsModule,
    };
    origins.set(binding.bindingId, result);
    return result;
  };
  const invalidatedOrigin = (record: InteropOrigin | undefined): boolean =>
    record?.dependencies.some(({ path, capturedAt }) => {
      if (capturedAt === undefined) return true;
      // Captured function values survive later replacement of global
      // properties. Other callable bodies are not execution evidence.
      return changedBefore(capturedAt, path);
    }) ?? false;
  return {
    origin,
    callOrigin,
    intrinsicPath,
    intrinsicValueReferences,
    intrinsicInvocation: (
      node: t.CallExpression | t.OptionalCallExpression,
      callablePath = intrinsicPath,
    ) =>
      resolveJavaScriptIntrinsicInvocation(
        node,
        callablePath,
        boundIntrinsic,
        intrinsicReadChanged,
        nativeArrayIteration,
      ),
    boundIntrinsic,
    staticString,
    staticPropertyKey: (node: t.Node | undefined) => staticString(node, true),
    isFreshObject,
    opaqueMutationPath,
    retainWrite,
    invalidated: (binding: JavaScriptSemanticBindingState): boolean => {
      const cached = invalidatedBindings.get(binding.bindingId);
      if (cached !== undefined) return cached;
      const result = invalidatedOrigin(origins.get(binding.bindingId));
      invalidatedBindings.set(binding.bindingId, result);
      return result;
    },
    invalidatedCall: (node: t.Node): boolean => {
      const cached = invalidatedCalls.get(node);
      if (cached !== undefined) return cached;
      const result = invalidatedOrigin(calls.get(node));
      invalidatedCalls.set(node, result);
      return result;
    },
  };
};

const identityFunction = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (
    !t.isFunction(node) ||
    node.async ||
    node.generator ||
    runtimeFunctionParameters(node).length !== 1
  )
    return false;
  const parameter = runtimeFunctionParameters(node)[0];
  const result = t.isBlockStatement(node.body)
    ? node.body.body.length === 1 && t.isReturnStatement(node.body.body[0])
      ? node.body.body[0].argument
      : undefined
    : node.body;
  return (
    t.isIdentifier(parameter) &&
    t.isIdentifier(result) &&
    resolveSemanticBindingState(state, parameter, parameter.name) !==
      undefined &&
    resolveSemanticBindingState(state, parameter, parameter.name) ===
      resolveSemanticBindingState(state, result, result.name)
  );
};

const unprojectedInitializer = (
  binding: JavaScriptSemanticBindingState | undefined,
  state: JavaScriptSemanticAnalysisState,
): t.Node | undefined => {
  const initializer = semanticStableInitializer(binding, state);
  return initializer?.projection.length === 0 ? initializer.node : undefined;
};

/** Match operations and lexical roles, allowing single-statement control blocks. */
const canonicalRoles = (
  actual: t.Node,
  pattern: t.Node,
  state: JavaScriptSemanticAnalysisState,
): ReadonlyMap<string, JavaScriptSemanticBindingState> | undefined => {
  const roles = new Map<string, JavaScriptSemanticBindingState>();
  const used = new Map<string, string>();
  const pending: { actual: t.Node; pattern: t.Node; parent: t.Node | null }[] =
    [{ actual, pattern, parent: null }];
  while (pending.length !== 0) {
    const pair = pending.pop();
    if (pair === undefined) return undefined;
    const { parent } = pair;
    const controlBody =
      (t.isIfStatement(parent) &&
        (parent.consequent === pair.pattern ||
          parent.alternate === pair.pattern)) ||
      (t.isForStatement(parent) && parent.body === pair.pattern);
    const node = controlBody ? controlBodyOperation(pair.actual) : pair.actual;
    const expected = controlBody
      ? controlBodyOperation(pair.pattern)
      : pair.pattern;
    if (node.type !== expected.type) return undefined;
    const literalKey =
      parent !== null &&
      ((t.isMemberExpression(parent) &&
        !parent.computed &&
        parent.property === expected) ||
        (t.isObjectProperty(parent) &&
          !parent.computed &&
          parent.key === expected));
    if (t.isIdentifier(expected) && t.isIdentifier(node) && !literalKey) {
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (
        binding === undefined ||
        (roles.has(expected.name) && roles.get(expected.name) !== binding) ||
        (used.has(binding.bindingId) &&
          used.get(binding.bindingId) !== expected.name)
      )
        return undefined;
      roles.set(expected.name, binding);
      used.set(binding.bindingId, expected.name);
    }
    const visitorKeys = javaScriptAstChildKeys(expected);
    for (const [key, field] of Object.entries(
      t.NODE_FIELDS[expected.type] ?? {},
    )) {
      if (
        visitorKeys.includes(key) ||
        (t.isIdentifier(expected) && key === "name" && !literalKey)
      )
        continue;
      const fallback: unknown = Reflect.get(field, "default");
      if (
        JSON.stringify(Reflect.get(node, key) ?? fallback) !==
        JSON.stringify(Reflect.get(expected, key) ?? fallback)
      )
        return undefined;
    }
    const children = childNodes(node),
      expectedChildren = childNodes(expected);
    if (children.length !== expectedChildren.length) return undefined;
    for (const [index, child] of children.entries()) {
      const expectedChild = expectedChildren[index];
      if (expectedChild !== undefined)
        pending.push({
          actual: child,
          pattern: expectedChild,
          parent: expected,
        });
    }
  }
  return roles;
};

// Braces around one control-body statement do not add operations. Keep other
// blocks, directives and extra statements intact; their semantics need proof.
// Lexical declarations/references still pass through canonicalRoles' bijection.
const controlBodyOperation = (node: t.Node): t.Node => {
  while (
    t.isBlockStatement(node) &&
    node.directives.length === 0 &&
    node.body.length === 1
  ) {
    const statement = node.body[0];
    if (statement === undefined) break;
    node = statement;
  }
  return node;
};
