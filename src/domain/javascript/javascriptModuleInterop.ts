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
import { isUnshadowedGlobal } from "./javascriptSemanticMutationInitializers.js";
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
  SemanticPropertyPathCoverage,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  readExactJavaScriptLiteral,
  runtimeFunctionParameters,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticKnownArrayIterationAt } from "./javascriptSemanticReferenceSources.js";
import { semanticOpaqueBindingReadMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";

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

export type JavaScriptIntrinsicContainerKind =
  | "object-values"
  | "object-entries"
  | "object-from-entries"
  | "object-create"
  | "object-group-by"
  | "property-descriptor"
  | "property-descriptors"
  | "array-from"
  | "array-of"
  | "array-from-async";

export type JavaScriptIntrinsicTargetMutationKind =
  | "preserve"
  | "coerce-object"
  | "assign"
  | "define-property"
  | "define-properties"
  | "set-prototype";

export type JavaScriptIntrinsicResultIdentity =
  | { readonly kind: "primitive" }
  | { readonly kind: "fresh-scalars" }
  | {
      readonly kind: "fresh-container";
      readonly container: JavaScriptIntrinsicContainerKind;
    }
  | {
      readonly kind: "target-argument";
      readonly mutation: JavaScriptIntrinsicTargetMutationKind;
      readonly target: t.Expression;
    }
  | {
      readonly kind: "projected-read";
      readonly projection: "prototype" | "property";
    }
  | { readonly kind: "unknown" };

const OBJECT_PRIMITIVE_METHODS = new Set([
  "is",
  "hasOwn",
  "isExtensible",
  "isFrozen",
  "isSealed",
]);
const OBJECT_SCALAR_ARRAY_METHODS = new Set([
  "keys",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
]);
const OBJECT_PROTO_PRIMITIVE_METHODS = new Set([
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "toLocaleString",
]);
const OBJECT_CONTAINERS: Readonly<
  Record<string, JavaScriptIntrinsicContainerKind>
> = {
  values: "object-values",
  entries: "object-entries",
  fromEntries: "object-from-entries",
  create: "object-create",
  groupBy: "object-group-by",
  getOwnPropertyDescriptor: "property-descriptor",
  getOwnPropertyDescriptors: "property-descriptors",
};
const OBJECT_TARGET_MUTATORS: Readonly<
  Record<string, JavaScriptIntrinsicTargetMutationKind>
> = {
  assign: "assign",
  defineProperty: "define-property",
  defineProperties: "define-properties",
  setPrototypeOf: "set-prototype",
};
const ARRAY_PROTO_PRIMITIVE_METHODS = new Set([
  "includes",
  "indexOf",
  "lastIndexOf",
  "join",
  "toString",
  "toLocaleString",
  "every",
  "some",
  "push",
  "unshift",
  "findIndex",
  "findLastIndex",
]);
const REFLECT_PRIMITIVE_METHODS = new Set([
  "defineProperty",
  "deleteProperty",
  "has",
  "isExtensible",
  "preventExtensions",
  "set",
  "setPrototypeOf",
]);

const isPrimitiveOrUndefinedIntrinsicArgument = (
  node: t.Expression,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (readExactJavaScriptLiteral(node).found) return true;
  const unwrapped = unwrapJavaScriptExpression(node).node;
  return (
    t.isUnaryExpression(unwrapped, { operator: "void" }) ||
    isUnshadowedGlobal(unwrapped, state, "undefined")
  );
};

const classifyObjectIntrinsicResult = (
  invocation: JavaScriptIntrinsicInvocation,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptIntrinsicResultIdentity => {
  const { path, arguments: args } = invocation;
  if (path.length === 2) {
    if (args === undefined) return { kind: "unknown" };
    if (args.length === 0) return { kind: "fresh-scalars" };
    const first = args[0];
    if (first === undefined || !t.isExpression(first))
      return { kind: "unknown" };
    return isPrimitiveOrUndefinedIntrinsicArgument(first, state)
      ? { kind: "fresh-scalars" }
      : { kind: "target-argument", mutation: "coerce-object", target: first };
  }
  if (path.length === 4 && path[2] === "prototype") {
    return OBJECT_PROTO_PRIMITIVE_METHODS.has(path[3] ?? "")
      ? { kind: "primitive" }
      : { kind: "unknown" };
  }
  if (path.length !== 3) return { kind: "unknown" };
  const method = path[2] ?? "";
  if (OBJECT_PRIMITIVE_METHODS.has(method)) return { kind: "primitive" };
  if (OBJECT_SCALAR_ARRAY_METHODS.has(method)) return { kind: "fresh-scalars" };
  const container = OBJECT_CONTAINERS[method];
  if (container !== undefined) return { kind: "fresh-container", container };
  if (method === "getPrototypeOf")
    return { kind: "projected-read", projection: "prototype" };
  if (
    method === "freeze" ||
    method === "seal" ||
    method === "preventExtensions"
  ) {
    if (args === undefined) return { kind: "unknown" };
    if (args.length === 0) return { kind: "primitive" };
    const first = args[0];
    if (first === undefined || !t.isExpression(first))
      return { kind: "unknown" };
    return isPrimitiveOrUndefinedIntrinsicArgument(first, state)
      ? { kind: "primitive" }
      : { kind: "target-argument", mutation: "preserve", target: first };
  }
  const mutator = OBJECT_TARGET_MUTATORS[method];
  if (mutator !== undefined) {
    const first = args?.[0];
    return first !== undefined && t.isExpression(first)
      ? { kind: "target-argument", mutation: mutator, target: first }
      : { kind: "unknown" };
  }
  return { kind: "unknown" };
};

/** Classify result object identity for a resolved intrinsic invocation. */
export const classifyJavaScriptIntrinsicResult = (
  invocation: JavaScriptIntrinsicInvocation,
  state: JavaScriptSemanticAnalysisState,
  resolveIntrinsicPath: (node: t.Node) => readonly string[] | undefined,
): JavaScriptIntrinsicResultIdentity => {
  if (invocation.kind !== "known" || invocation.path[0] !== "intrinsic")
    return { kind: "unknown" };
  const owner = invocation.path[1];
  if (owner === "Object")
    return classifyObjectIntrinsicResult(invocation, state);
  if (owner === "Array") {
    if (invocation.path.length === 3) {
      const method = invocation.path[2];
      if (method === "isArray") return { kind: "primitive" };
      if (method === "from" || method === "of" || method === "fromAsync") {
        const standardCtor =
          invocation.receiver === undefined ||
          resolveIntrinsicPath(invocation.receiver)?.join(".") ===
            "intrinsic.Array";
        if (!standardCtor) return { kind: "unknown" };
        const container: JavaScriptIntrinsicContainerKind =
          method === "from"
            ? "array-from"
            : method === "of"
              ? "array-of"
              : "array-from-async";
        return { kind: "fresh-container", container };
      }
    }
    if (invocation.path.length === 4 && invocation.path[2] === "prototype") {
      const method = invocation.path[3] ?? "";
      if (ARRAY_PROTO_PRIMITIVE_METHODS.has(method))
        return { kind: "primitive" };
      if (method === "keys") return { kind: "fresh-scalars" };
    }
    return { kind: "unknown" };
  }
  if (owner === "Reflect" && invocation.path.length === 3) {
    const method = invocation.path[2] ?? "";
    if (REFLECT_PRIMITIVE_METHODS.has(method)) return { kind: "primitive" };
    if (method === "ownKeys") return { kind: "fresh-scalars" };
    if (method === "getOwnPropertyDescriptor")
      return { kind: "fresh-container", container: "property-descriptor" };
    if (method === "getPrototypeOf")
      return { kind: "projected-read", projection: "prototype" };
    if (method === "get")
      return { kind: "projected-read", projection: "property" };
    return { kind: "unknown" };
  }
  if (
    owner === "Function" &&
    invocation.path.length === 4 &&
    invocation.path[2] === "prototype"
  ) {
    const method = invocation.path[3];
    if (method === "bind") return { kind: "fresh-scalars" };
    if (method === "toString") return { kind: "primitive" };
  }
  return { kind: "unknown" };
};

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
  const aliasTargets = new Map<
    string,
    { targetBinding: JavaScriptSemanticBindingState; node: t.Node }
  >();
  const aliasChangedCache = new Map<string, boolean>();
  const calls = new WeakMap<t.Node, InteropOrigin>();
  const intrinsicBindings = new Map<string, readonly string[] | null>();
  const writes: {
    readonly scope: string;
    readonly offset: number;
    readonly coverage: SemanticPropertyPathCoverage;
  }[] = [];
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
        const { root, members } = electronMemberPath(current);
        if (members.some((member) => member === null)) return finish(undefined);
        suffix = [...(members as readonly string[]), ...suffix];
        for (const global of ["Object", "Function", "Reflect", "Array"])
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
      const { root, members } = electronMemberPath(current);
      suffixLength += members.length;
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

  const staticString = (node: t.Node | undefined): string | undefined => {
    if (node === undefined) return undefined;
    const visited = new Set<string>();
    let current = node;
    for (;;) {
      const literal = readExactJavaScriptLiteral(current);
      if (literal.found)
        return typeof literal.value === "string" ? literal.value : undefined;
      const expression = unwrapJavaScriptExpression(current).node;
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
        visited.has(binding.bindingId)
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
    const scope = opaqueMutationPath(capture).join(".");
    const method = path.at(-1);
    const invocationMethod =
      method === "bind" || method === "call" || method === "apply";
    return writes.some(
      (write) =>
        (write.scope === scope || write.scope === "intrinsic") &&
        write.offset < (capture.start ?? -1) &&
        (write.coverage.covers(path) ||
          (invocationMethod &&
            write.coverage.covers([
              "intrinsic",
              "Function",
              "prototype",
              method,
            ]))),
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
        const scope = opaqueMutationPath(capture).join(".");
        return writes.some(
          (write) =>
            (write.scope === scope || write.scope === "intrinsic") &&
            write.offset < (capture.start ?? -1) &&
            (write.coverage.covers(boundPath) ||
              write.coverage.covers(functionBind)),
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

  const isFreshObject = (node: t.Node): boolean => {
    const visited = new Set<string>();
    const visitedNodes = new Set<t.Node>();
    let current = node;
    for (;;) {
      current = unwrapJavaScriptExpression(current).node;
      if (visitedNodes.has(current)) return false;
      visitedNodes.add(current);
      if (
        t.isObjectExpression(current) ||
        t.isArrayExpression(current) ||
        t.isFunction(current) ||
        (t.isClass(current) && !current.decorators?.length) ||
        t.isRegExpLiteral(current)
      )
        return true;
      if (t.isCallExpression(current) || t.isOptionalCallExpression(current)) {
        const invocation = resolveJavaScriptIntrinsicInvocation(
          current,
          intrinsicPath,
          boundIntrinsic,
          intrinsicReadChanged,
          nativeArrayIteration,
        );
        const identity =
          invocation === undefined
            ? undefined
            : classifyJavaScriptIntrinsicResult(
                invocation,
                state,
                intrinsicPath,
              );
        if (
          identity?.kind === "fresh-scalars" ||
          identity?.kind === "fresh-container"
        )
          return true;
        if (identity?.kind === "target-argument") {
          current = identity.target;
          continue;
        }
        return false;
      }
      if (!t.isIdentifier(current)) return false;
      const binding = resolveSemanticBindingState(state, current, current.name);
      const initializer = unprojectedInitializer(binding, state);
      if (
        binding === undefined ||
        initializer === undefined ||
        (!t.isFunctionDeclaration(initializer) &&
          (initializer.end ?? Infinity) >= (current.start ?? -1)) ||
        visited.has(binding.bindingId)
      )
        return false;
      visited.add(binding.bindingId);
      current = initializer;
    }
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

  const twoInitializerOrigin = (
    binding: JavaScriptSemanticBindingState,
  ): InteropOrigin | undefined => {
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
    return {
      origin: required,
      dependencies: convertedCall.dependencies,
      defaultIsModule: convertedCall.defaultIsModule,
    };
  };

  const origin = (
    binding: JavaScriptSemanticBindingState,
  ): InteropOrigin | undefined => {
    const cached = origins.get(binding.bindingId);
    if (cached !== undefined) return cached;

    let currentBinding: JavaScriptSemanticBindingState | undefined = binding;
    const visited = new Set<string>();
    const steps: {
      binding: JavaScriptSemanticBindingState;
      segments: readonly string[];
    }[] = [];
    let baseOrigin: InteropOrigin | undefined;

    while (currentBinding !== undefined) {
      const alreadyCached = origins.get(currentBinding.bindingId);
      if (alreadyCached !== undefined) {
        baseOrigin = alreadyCached;
        break;
      }
      if (visited.has(currentBinding.bindingId)) return undefined;
      visited.add(currentBinding.bindingId);

      const single = semanticStableInitializer(currentBinding, state);
      if (single !== undefined) {
        if (
          !single.projection.every(
            (key): key is string => typeof key === "string",
          )
        )
          return undefined;
        const converted = callOrigin(single.node);
        if (converted !== undefined) {
          if (
            converted.origin.importedPath.length === 0 &&
            single.projection[0] === "default" &&
            !converted.defaultIsModule
          )
            return undefined;
          baseOrigin = {
            ...converted,
            origin: {
              ...converted.origin,
              importedPath: [
                ...converted.origin.importedPath,
                ...(single.projection as readonly string[]),
              ],
            },
          };
          break;
        }
        const { root, members } = electronMemberPath(single.node);
        if (
          !t.isIdentifier(root) ||
          !members.every((member): member is string => member !== null)
        )
          return undefined;
        const targetBinding = resolveSemanticBindingState(
          state,
          root,
          root.name,
        );
        if (targetBinding === undefined || targetBinding === currentBinding)
          return undefined;
        aliasTargets.set(currentBinding.bindingId, {
          targetBinding,
          node: root,
        });
        steps.push({
          binding: currentBinding,
          segments: [
            ...(members as readonly string[]),
            ...(single.projection as readonly string[]),
          ],
        });
        currentBinding = targetBinding;
        continue;
      }

      const twoInit = twoInitializerOrigin(currentBinding);
      if (twoInit !== undefined) {
        baseOrigin = twoInit;
        break;
      }
      return undefined;
    }

    if (baseOrigin === undefined) return undefined;
    origins.set(currentBinding!.bindingId, baseOrigin);

    let currentOrigin = baseOrigin;
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i]!;
      const firstSegment = step.segments[0];
      if (
        currentOrigin.origin.importedPath.length === 0 &&
        firstSegment === "default" &&
        !currentOrigin.defaultIsModule
      )
        return undefined;
      currentOrigin = {
        ...currentOrigin,
        origin: {
          ...currentOrigin.origin,
          importedPath: [
            ...currentOrigin.origin.importedPath,
            ...step.segments,
          ],
        },
      };
      origins.set(step.binding.bindingId, currentOrigin);
    }
    return currentOrigin;
  };
  const invalidatedOrigin = (record: InteropOrigin | undefined): boolean =>
    record?.dependencies.some(({ path, capturedAt }) => {
      if (capturedAt === undefined) return true;
      const scope = opaqueMutationPath(capturedAt).join(".");
      // Captured function values survive later replacement of global
      // properties. Other callable bodies are not execution evidence.
      return writes.some(
        (write) =>
          (write.scope === scope || write.scope === "intrinsic") &&
          write.offset < (capturedAt.start ?? -1) &&
          write.coverage.covers(path),
      );
    }) ?? false;
  return {
    origin,
    callOrigin,
    intrinsicPath,
    intrinsicInvocation: (
      node:
        | t.CallExpression
        | t.OptionalCallExpression
        | t.NewExpression
        | t.TaggedTemplateExpression,
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
    intrinsicResultIdentity: (invocation: JavaScriptIntrinsicInvocation) =>
      classifyJavaScriptIntrinsicResult(invocation, state, intrinsicPath),
    staticString,
    isFreshObject,
    opaqueMutationPath,
    retainWrite: (node: t.Node, path: JavaScriptSemanticPropertyPath) => {
      const coverage = new SemanticPropertyPathCoverage();
      coverage.retain(path[0] === "opaque-intrinsic" ? ["intrinsic"] : path);
      writes.push({
        scope: opaqueMutationPath(node).join("."),
        offset: node.start ?? Infinity,
        coverage,
      });
    },
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
    aliasMayHaveChanged: (binding: JavaScriptSemanticBindingState): boolean => {
      if (state.opaqueEffects.byScope.size === 0) return false;
      const cached = aliasChangedCache.get(binding.bindingId);
      if (cached !== undefined) return cached;
      origin(binding);
      let current: JavaScriptSemanticBindingState | undefined = binding;
      const seen = new Set<string>();
      let changed = false;
      while (current !== undefined) {
        if (seen.has(current.bindingId)) break;
        seen.add(current.bindingId);
        const next = aliasTargets.get(current.bindingId);
        if (next === undefined) break;
        if (
          semanticOpaqueBindingReadMayHaveChanged(
            next.targetBinding,
            next.node,
            state,
          )
        ) {
          changed = true;
          break;
        }
        current = next.targetBinding;
      }
      aliasChangedCache.set(binding.bindingId, changed);
      return changed;
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
