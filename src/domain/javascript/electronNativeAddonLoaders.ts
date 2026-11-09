import { posix } from "node:path";

import * as t from "@babel/types";

import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { stripQueryAndFragment } from "../artifactPathSyntax.js";
import type {
  ElectronAsarUnpackedRewriteScope,
  ElectronNativeAddonBindingFinding,
  ElectronNativeAddonResolution,
} from "./electronStaticAnalysisTypes.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { resolveElectronOptionObject } from "./electronStaticOptionObjects.js";
import {
  builtinDataEffectCallablePath,
  isUnmodifiedGlobalProcessMember,
  semanticProcessHostAxis,
} from "./javascriptSemanticDataEffectHelpers.js";
import { isUnmodifiedImportMetaUrl } from "./javascriptSemanticAmbientWrites.js";
import {
  isUnshadowedGlobal,
  semanticEffectTiming,
} from "./javascriptSemanticMutationInitializers.js";
import {
  loaderInvocationInterop,
  semanticRequireCallAt,
} from "./javascriptSemanticRequireOrigin.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptBindingIndex,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  evaluateSemanticExpression,
  evaluateSemanticProvenance,
} from "./javascriptSemanticValues.js";
import { javaScriptRuntimeContext } from "./javascriptSourceParser.js";
import {
  argumentNode,
  staticFileExpressionPath,
  staticSourceRelativeUrlPath,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

const HOST_PLATFORMS = ["darwin", "linux", "win32"] as const;
const HOST_ARCHES = ["arm64", "x64", "ia32"] as const;
const MAX_TEMPLATE_DEPTH = 16;

type HostAxis = "platform" | "arch";

type PathPiece =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "host"; readonly axis: HostAxis };

interface AsarUnpackedTemplateRewrite {
  readonly scopeDirectory: string | undefined;
  readonly replaceAll: boolean;
  readonly hasPostRewriteSuffix: boolean;
}

interface NativePathTemplateFact {
  readonly pieces: readonly PathPiece[];
  readonly base: "source-directory" | "literal-path";
  readonly asarUnpacked?: AsarUnpackedTemplateRewrite;
}

export interface NativeMemberAccess {
  readonly members: readonly string[];
  readonly namespaceAccess: boolean;
  readonly dynamicMemberAccess: boolean;
}

export interface ResolvedNativeLoaderCall {
  readonly specifier: string;
  readonly hasMemberAccess: boolean;
  readonly access: NativeMemberAccess;
  readonly resolution?: ElectronNativeAddonResolution;
}

export interface ResolvedDlopenCall {
  readonly specifier: string;
  readonly kind: "require" | "re-export";
  readonly access: NativeMemberAccess;
  readonly resolution: ElectronNativeAddonResolution;
}

export const isNativeSpecifier = (
  specifier: string,
  moduleKind: ElectronNativeAddonBindingFinding["module_kind"],
): boolean => {
  const path =
    moduleKind === "require" ? specifier : stripQueryAndFragment(specifier);
  return path.toLowerCase().endsWith(".node");
};

const unwrapFinalCallee = (node: t.Node): t.Node => {
  let current = unwrapJavaScriptExpression(node).node;
  while (t.isSequenceExpression(current)) {
    const last = current.expressions.at(-1);
    if (last === undefined) break;
    current = unwrapJavaScriptExpression(last).node;
  }
  return current;
};

const isBoundCallExpression = (node: t.Node): boolean => {
  const unwrapped = unwrapJavaScriptExpression(node).node;
  if (!t.isCallExpression(unwrapped) && !t.isOptionalCallExpression(unwrapped))
    return false;
  const inner = unwrapFinalCallee(unwrapped.callee);
  return (
    (t.isMemberExpression(inner) || t.isOptionalMemberExpression(inner)) &&
    semanticStaticPropertyKey(inner.property, inner.computed) === "bind"
  );
};

const bindingMayHoldProcessDlopen = (
  binding: JavaScriptSemanticBindingState,
  bindings: JavaScriptSemanticAnalysisState,
): boolean => {
  if (
    binding.directOrigins.length === 0 &&
    binding.referenceInitializers.length === 0
  ) {
    if (binding.initializers.length === 0) return false;
    if (binding.initializers.length === 1) {
      const init = unwrapJavaScriptExpression(
        binding.initializers[0]!.node,
      ).node;
      if (t.isFunction(init) || t.isNewExpression(init)) return false;
      if (isBoundCallExpression(init) || t.isObjectExpression(init))
        return true;
    }
  }
  return evaluateSemanticProvenance(binding, bindings).origins.some(
    (origin) => origin.specifier.replace(/^node:/u, "") === "process",
  );
};

const mayReferenceProcessDlopen = (
  callee: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
): boolean => {
  if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
    const method = semanticStaticPropertyKey(callee.property, callee.computed);
    if (method === "dlopen" || method === "call" || method === "apply")
      return true;
    if (!t.isIdentifier(callee.object)) return false;
    const binding = resolveSemanticBindingState(
      bindings,
      callee.object,
      callee.object.name,
    );
    return (
      binding !== undefined && bindingMayHoldProcessDlopen(binding, bindings)
    );
  }
  if (t.isIdentifier(callee)) {
    const binding = resolveSemanticBindingState(bindings, callee, callee.name);
    return (
      binding !== undefined && bindingMayHoldProcessDlopen(binding, bindings)
    );
  }
  if (t.isCallExpression(callee) || t.isOptionalCallExpression(callee))
    return isBoundCallExpression(callee);
  return t.isAssignmentExpression(callee);
};

/** Fast admission check for `process.dlopen` and `node:process` `dlopen` calls. */
export const isDlopenCallCandidate = (
  node: t.Node | null | undefined,
  bindings?: JavaScriptSemanticAnalysisState,
): node is t.CallExpression | t.OptionalCallExpression => {
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
    return false;
  const callee = unwrapFinalCallee(node.callee);
  if (t.isFunction(callee)) return false;
  return bindings === undefined
    ? !t.isSuper(callee) && !t.isImport(callee)
    : mayReferenceProcessDlopen(callee, bindings);
};

/** Fast admission check for value sites that may invoke a native addon loader. */
export const mayInvokeNativeLoader = (
  node: t.Node | null | undefined,
): boolean => {
  const call = nativeCallReceiver(node);
  return call !== undefined && !t.isFunction(unwrapFinalCallee(call.callee));
};

export const nativeCallReceiver = (
  node: t.Node | null | undefined,
): t.CallExpression | t.OptionalCallExpression | undefined => {
  if (node == null) return undefined;
  node = unwrapJavaScriptExpression(node).node;
  while (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
    node = unwrapJavaScriptExpression(node.object).node;
  return t.isCallExpression(node) || t.isOptionalCallExpression(node)
    ? node
    : undefined;
};

const genericInvocationMemberChanged = (
  node: t.CallExpression | t.OptionalCallExpression,
  index: JavaScriptBindingIndex,
): boolean => {
  let member = unwrapFinalCallee(node.callee);
  while (t.isMemberExpression(member) || t.isOptionalMemberExpression(member)) {
    const key = semanticStaticPropertyKey(member.property, member.computed);
    if (
      (key === "call" || key === "apply") &&
      t.isExpression(member.object) &&
      index
        .effectsForReferenceAt(node, member.object, [key])
        .effects.some(
          ({ kind, timing }) =>
            timing !== "after" &&
            (kind === "member-write" || kind === "escape"),
        )
    )
      return true;
    member = unwrapFinalCallee(member.object);
  }
  return false;
};

const dlopenInvocationAt = (
  node: t.CallExpression | t.OptionalCallExpression,
  bindings: JavaScriptSemanticAnalysisState,
) => {
  const interop = loaderInvocationInterop(bindings);
  const invocation = interop.intrinsicInvocation(node, (callee) =>
    isProvenProcessDlopen(callee, bindings)
      ? ["process-dlopen"]
      : interop.intrinsicPath(callee),
  );
  return invocation?.path[0] === "process-dlopen" ? invocation : undefined;
};

/** Resolve `process.dlopen(module, filename[, flags])` when `process.dlopen` is proven. */
export const resolveDlopenCall = (
  node: t.CallExpression | t.OptionalCallExpression,
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
): ResolvedDlopenCall | undefined => {
  const { bindings } = index;
  const invocation = dlopenInvocationAt(node, bindings);
  if (invocation === undefined) return undefined;
  if (
    invocation.kind === "opaque" ||
    invocation.arguments === undefined ||
    genericInvocationMemberChanged(node, index)
  ) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  const rawModule = argumentNode(invocation.arguments[0]);
  const rawFilename = argumentNode(invocation.arguments[1]);
  if (
    rawModule === undefined ||
    rawFilename === undefined ||
    t.isSpreadElement(rawModule) ||
    t.isSpreadElement(rawFilename)
  ) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  const moduleTarget = unwrapJavaScriptExpression(rawModule).node;
  const kind: "require" | "re-export" = isUnmodifiedCommonJsModule(
    moduleTarget,
    node,
    bindings,
  )
    ? "re-export"
    : "require";
  const access: NativeMemberAccess = {
    members: [],
    namespaceAccess: true,
    dynamicMemberAccess: false,
  };
  const filenameExpr = unwrapJavaScriptExpression(rawFilename).node;
  if (
    t.isCallExpression(filenameExpr) ||
    t.isOptionalCallExpression(filenameExpr)
  ) {
    const resolvedRequire = resolveDlopenRequireResolve(
      filenameExpr,
      kind,
      access,
      context,
      index,
    );
    if (resolvedRequire !== "not-require-resolve") return resolvedRequire;
  }
  const expanded = expandNativePathTemplate(
    filenameExpr,
    context,
    bindings,
    node,
  );
  if (expanded === undefined) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  return {
    specifier: expanded.display,
    kind,
    access,
    resolution: {
      kind: "candidates",
      loader: "dlopen",
      lookup: "exact-file",
      resolution_context: "filesystem-expression",
      // Relative/absolute literal strings in process.dlopen depend on cwd or
      // host mount layout unless anchored to the source file's directory.
      candidates:
        expanded.base === "source-directory" ? expanded.candidates : [],
      ...(expanded.base === "source-directory" && expanded.asarUnpacked
        ? asarUnpackedResolutionProps(expanded.asarUnpacked)
        : {}),
    },
  };
};

export type RequireResolveSearchOptions =
  | { readonly kind: "default" }
  | {
      readonly kind: "directory";
      readonly directory: string;
      readonly asarUnpacked: boolean;
      readonly asarUnpackedReplaceAll?: boolean;
      readonly asarUnpackedScope?: ElectronAsarUnpackedRewriteScope;
    }
  | { readonly kind: "unresolved" };

/** Resolve `require.resolve(request, options)` search paths when `options` is provided. */
export const resolveRequireResolveSearchOptions = (
  callArguments: readonly t.CallExpression["arguments"][number][] | undefined,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  site: t.Node,
  loader: string,
  sourceRelativePath: string | undefined,
): RequireResolveSearchOptions => {
  const args = callArguments ?? [];
  if (args.length < 2) return { kind: "default" };
  if (args.length !== 2 || loader === "factory-loader")
    return { kind: "unresolved" };
  const options = argumentNode(args[1]);
  if (options === undefined || !t.isObjectExpression(options))
    return { kind: "unresolved" };
  if (options.properties.length === 0) return { kind: "default" };
  if (options.properties.length !== 1) return { kind: "unresolved" };
  const property = options.properties[0];
  if (
    !t.isObjectProperty(property) ||
    semanticStaticPropertyKey(property.key, property.computed) !== "paths" ||
    !t.isArrayExpression(property.value) ||
    property.value.elements.length !== 1
  )
    return { kind: "unresolved" };
  const directoryNode = property.value.elements[0];
  if (directoryNode == null || t.isSpreadElement(directoryNode))
    return { kind: "unresolved" };
  if (
    sourceRelativePath === undefined &&
    context.pathIntrinsics?.(directoryNode, "source-directory") === true
  )
    return { kind: "default" };
  const anchored = resolveSourceAnchoredDirectory(
    directoryNode,
    context,
    bindings,
    site,
  );
  return anchored === undefined
    ? { kind: "unresolved" }
    : {
        kind: "directory",
        directory: anchored.directory,
        asarUnpacked: anchored.asarUnpacked,
        ...(anchored.asarUnpackedReplaceAll === true
          ? { asarUnpackedReplaceAll: true }
          : {}),
        ...(anchored.asarUnpackedScope === undefined
          ? {}
          : { asarUnpackedScope: anchored.asarUnpackedScope }),
      };
};

const resolveDlopenRequireResolve = (
  filenameExpr: t.CallExpression | t.OptionalCallExpression,
  kind: "require" | "re-export",
  access: NativeMemberAccess,
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
): ResolvedDlopenCall | undefined | "not-require-resolve" => {
  const { bindings } = index;
  const resolvedCall = semanticRequireCallAt(
    filenameExpr,
    bindings,
    context.accumulator.factoryRequireBindingIds,
    index,
  );
  if (
    resolvedCall === undefined ||
    (resolvedCall.operation !== "resolve" && !resolvedCall.memberUnproven)
  )
    return "not-require-resolve";
  if (resolvedCall.loader === "local") return undefined;
  const callee = unwrapFinalCallee(filenameExpr.callee);
  const resolveMemberChanged =
    resolvedCall.memberUnproven === true ||
    ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
      t.isExpression(callee.object) &&
      index
        .effectsForReferenceAt(filenameExpr, callee.object, ["resolve"])
        .effects.some(
          ({ kind: effectKind, timing }) =>
            timing !== "after" &&
            (effectKind === "member-write" || effectKind === "escape"),
        ));
  const searchOptions = resolveRequireResolveSearchOptions(
    resolvedCall.arguments,
    context,
    bindings,
    filenameExpr,
    resolvedCall.loader,
    resolvedCall.sourceRelativePath,
  );
  if (
    resolveMemberChanged ||
    resolvedCall.loader === "unknown" ||
    !resolvedCall.sourceRelative ||
    searchOptions.kind === "unresolved"
  ) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  const resolveArg = argumentNode(resolvedCall.arguments?.[0]);
  const expanded =
    resolveArg === undefined
      ? undefined
      : expandNativePathTemplate(resolveArg, context, bindings, filenameExpr);
  if (
    expanded === undefined ||
    (expanded.base === "source-directory" &&
      resolvedCall.loader === "factory-loader")
  ) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  if (searchOptions.kind === "directory") {
    if (expanded.base === "source-directory")
      return {
        specifier: expanded.display,
        kind,
        access,
        resolution: {
          kind: "candidates",
          loader: "dlopen",
          lookup: "commonjs",
          resolution_context: "filesystem-expression",
          candidates: expanded.candidates,
          ...(expanded.asarUnpacked === undefined
            ? {}
            : asarUnpackedResolutionProps(expanded.asarUnpacked)),
        },
      };
    if (
      !expanded.candidates.every(
        (candidate) =>
          candidate.startsWith("./") || candidate.startsWith("../"),
      )
    ) {
      context.accumulator.unknownFindings += 1;
      return undefined;
    }
    if (searchOptions.asarUnpacked) {
      const scope: ElectronAsarUnpackedRewriteScope =
        searchOptions.asarUnpackedScope ?? {
          directory: searchOptions.directory,
          ...(searchOptions.asarUnpackedReplaceAll === true
            ? { replace_all: true }
            : {}),
        };
      const rebasedCandidates =
        searchOptions.asarUnpackedScope === undefined
          ? expanded.candidates.map((candidate) => posix.normalize(candidate))
          : expanded.candidates.map((candidate) =>
              posix.join(searchOptions.directory, candidate),
            );
      return {
        specifier: expanded.display,
        kind,
        access,
        resolution: {
          kind: "candidates",
          loader: "dlopen",
          lookup: "commonjs",
          resolution_context: "filesystem-expression",
          candidates: rebasedCandidates,
          asar_unpacked: true,
          asar_unpacked_scope: scope,
        },
      };
    }
    return {
      specifier: expanded.display,
      kind,
      access,
      resolution: {
        kind: "candidates",
        loader: "dlopen",
        lookup: "commonjs",
        resolution_context: "filesystem-expression",
        candidates: expanded.candidates.map((candidate) =>
          posix.join(searchOptions.directory, candidate),
        ),
      },
    };
  }
  return {
    specifier: expanded.display,
    kind,
    access,
    resolution:
      expanded.base === "source-directory"
        ? {
            kind: "candidates",
            loader: "dlopen",
            lookup: "commonjs",
            resolution_context: "filesystem-expression",
            candidates: expanded.candidates,
            ...(expanded.asarUnpacked === undefined
              ? {}
              : asarUnpackedResolutionProps(expanded.asarUnpacked)),
          }
        : {
            kind: "candidates",
            loader: "dlopen",
            resolution_context: "module-specifier",
            candidates: expanded.candidates,
            ...(resolvedCall.sourceRelativePath === undefined
              ? {}
              : { resolution_base_path: resolvedCall.sourceRelativePath }),
          },
  };
};

/** Resolve `require(...)`, `createRequire(...)`, `node-gyp-build`, or `bindings`. */
export const resolveNativeLoaderCall = (
  node: t.Node | null | undefined,
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
): ResolvedNativeLoaderCall | undefined => {
  const { bindings } = index;
  if (node == null) return undefined;
  node = unwrapJavaScriptExpression(node).node;
  let member: string | null = null;
  let hasMemberAccess = false;
  while (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (!t.isNode(node.object)) return undefined;
    const property = semanticStaticPropertyKey(node.property, node.computed);
    // Walking inward leaves the first member consumed from the addon itself.
    member = property;
    hasMemberAccess = true;
    node = unwrapJavaScriptExpression(node.object).node;
  }
  if (
    (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) ||
    dlopenInvocationAt(node, bindings) !== undefined
  )
    return undefined;
  const access: NativeMemberAccess = {
    members: member === null ? [] : [member],
    namespaceAccess: !hasMemberAccess,
    dynamicMemberAccess: hasMemberAccess && member === null,
  };
  const helper = helperInvocationAt(node, bindings);
  if (helper !== undefined) {
    if (
      helper.invocation.kind === "opaque" ||
      helper.invocation.arguments === undefined ||
      genericInvocationMemberChanged(node, index)
    ) {
      context.accumulator.unknownFindings += 1;
      return undefined;
    }
    return helper.pkg === "node-gyp-build"
      ? resolveNodeGypBuildCall(
          node,
          helper.invocation.arguments,
          context,
          bindings,
          hasMemberAccess,
          access,
        )
      : resolveBindingsHelperCall(
          node,
          helper.invocation.arguments,
          context,
          index,
          hasMemberAccess,
          access,
        );
  }
  return resolveRequireNativeCall(
    node,
    context,
    index,
    hasMemberAccess,
    access,
  );
};

const provenHelperPackage = (
  callee: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
): "node-gyp-build" | "bindings" | undefined => {
  for (const pkg of ["node-gyp-build", "bindings"] as const) {
    const path = builtinDataEffectCallablePath(callee, bindings, [pkg]);
    if (
      path !== null &&
      (path.length === 0 || (path.length === 1 && path[0] === "default"))
    )
      return pkg;
  }
  return undefined;
};

const helperInvocationAt = (
  node: t.CallExpression | t.OptionalCallExpression,
  bindings: JavaScriptSemanticAnalysisState,
) => {
  const interop = loaderInvocationInterop(bindings);
  const invocation = interop.intrinsicInvocation(node, (callee) => {
    const pkg = provenHelperPackage(callee, bindings);
    return pkg !== undefined
      ? ["native-helper", pkg]
      : interop.intrinsicPath(callee);
  });
  const pkg = invocation?.path[1];
  return invocation?.path[0] === "native-helper" &&
    (pkg === "node-gyp-build" || pkg === "bindings")
    ? { pkg, invocation }
    : undefined;
};

const resolveNodeGypBuildCall = (
  node: t.CallExpression | t.OptionalCallExpression,
  callArguments: readonly t.CallExpression["arguments"][number][],
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  hasMemberAccess: boolean,
  access: NativeMemberAccess,
): ResolvedNativeLoaderCall | undefined => {
  // Without an explicit directory argument, node-gyp-build resolves from
  // process.cwd() rather than the caller's module directory.
  if (callArguments.length !== 1 || t.isSpreadElement(callArguments[0])) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  const arg0 = argumentNode(callArguments[0]);
  if (arg0 === undefined) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  const unwrapped = unwrapJavaScriptExpression(arg0).node;
  if (isUnshadowedGlobal(unwrapped, bindings, "undefined")) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  const anchored = resolveSourceAnchoredDirectory(
    unwrapped,
    context,
    bindings,
    node,
  );
  if (anchored === undefined) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  return {
    specifier: `node-gyp-build:${anchored.displayDirectory}`,
    hasMemberAccess,
    access,
    resolution: {
      kind: "node-gyp-build",
      directory: anchored.directory,
      ...(anchored.asarUnpacked ? { asar_unpacked: true } : {}),
      ...(anchored.asarUnpackedReplaceAll === true
        ? { asar_unpacked_replace_all: true }
        : {}),
      ...(anchored.asarUnpackedScope === undefined
        ? {}
        : { asar_unpacked_scope: anchored.asarUnpackedScope }),
    },
  };
};

const resolveBindingsHelperCall = (
  node: t.CallExpression | t.OptionalCallExpression,
  callArguments: readonly t.CallExpression["arguments"][number][],
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
  hasMemberAccess: boolean,
  access: NativeMemberAccess,
): ResolvedNativeLoaderCall | undefined => {
  const { bindings } = index;
  if (callArguments.length !== 1 || t.isSpreadElement(callArguments[0])) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  const arg0 = argumentNode(callArguments[0]);
  if (arg0 === undefined) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  const directName = staticStringPiece(arg0, bindings, node);
  if (directName !== undefined) {
    const addonName = normalizeBindingsAddonName(directName);
    if (addonName === undefined) {
      context.accumulator.unknownFindings += 1;
      return undefined;
    }
    return {
      specifier: addonName,
      hasMemberAccess,
      access,
      resolution: {
        kind: "bindings",
        addon_name: addonName,
        module_root: null,
      },
    };
  }
  const objectNode = resolveElectronOptionObject(arg0, node, index);
  if (objectNode === undefined) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  let rawAddonName: string | undefined;
  let moduleRoot: string | null = null;
  let moduleRootUnpacked = false;
  let moduleRootUnpackedReplaceAll = false;
  let moduleRootUnpackedScope: ElectronAsarUnpackedRewriteScope | undefined;
  let pathOnly = false;
  for (const prop of objectNode.properties) {
    if (t.isSpreadElement(prop) || t.isObjectMethod(prop)) {
      context.accumulator.unknownFindings += 1;
      return undefined;
    }
    const key = semanticStaticPropertyKey(prop.key, prop.computed);
    if (key === null) {
      context.accumulator.unknownFindings += 1;
      return undefined;
    }
    if (key === "bindings") {
      const value = staticStringPiece(prop.value, bindings, node);
      if (value === undefined) {
        context.accumulator.unknownFindings += 1;
        return undefined;
      }
      rawAddonName = value;
    } else if (key === "module_root") {
      const valueNode = unwrapJavaScriptExpression(prop.value).node;
      if (isUnshadowedGlobal(valueNode, bindings, "undefined")) {
        moduleRoot = null;
        moduleRootUnpacked = false;
        moduleRootUnpackedReplaceAll = false;
        moduleRootUnpackedScope = undefined;
      } else {
        const resolved = resolveSourceAnchoredDirectory(
          valueNode,
          context,
          bindings,
          node,
        );
        if (resolved === undefined) {
          context.accumulator.unknownFindings += 1;
          return undefined;
        }
        moduleRoot = resolved.directory;
        moduleRootUnpacked = resolved.asarUnpacked;
        moduleRootUnpackedReplaceAll = resolved.asarUnpackedReplaceAll === true;
        moduleRootUnpackedScope = resolved.asarUnpackedScope;
      }
    } else if (key === "path") {
      const evaluatedPath = evaluateBindingsPathOption(prop.value, node, index);
      if (evaluatedPath === undefined) {
        context.accumulator.unknownFindings += 1;
        return undefined;
      }
      pathOnly = evaluatedPath;
    } else {
      context.accumulator.unknownFindings += 1;
      return undefined;
    }
  }
  const addonName =
    rawAddonName === undefined
      ? undefined
      : normalizeBindingsAddonName(rawAddonName);
  if (addonName === undefined) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  // When `path` is truthy, `bindings(...)` returns the resolved path string
  // without requiring or loading the native addon.
  if (pathOnly) return undefined;
  return {
    specifier: addonName,
    hasMemberAccess,
    access,
    resolution: {
      kind: "bindings",
      addon_name: addonName,
      module_root: moduleRoot,
      ...(moduleRootUnpacked ? { asar_unpacked: true } : {}),
      ...(moduleRootUnpackedReplaceAll
        ? { asar_unpacked_replace_all: true }
        : {}),
      ...(moduleRootUnpackedScope === undefined
        ? {}
        : { asar_unpacked_scope: moduleRootUnpackedScope }),
    },
  };
};

const evaluateBindingsPathOption = (
  rawValue: t.Node,
  site: t.Node,
  index: JavaScriptBindingIndex,
): boolean | undefined => {
  const valueNode = unwrapJavaScriptExpression(rawValue).node;
  if (isUnshadowedGlobal(valueNode, index.bindings, "undefined")) return false;
  if (
    t.isObjectExpression(valueNode) ||
    t.isArrayExpression(valueNode) ||
    t.isFunction(valueNode)
  )
    return true;
  if (
    (t.isIdentifier(valueNode) ||
      t.isMemberExpression(valueNode) ||
      t.isOptionalMemberExpression(valueNode)) &&
    index.referenceMayHaveChangedAt(site, valueNode)
  )
    return undefined;
  const evaluated = evaluateSemanticExpression(valueNode, index.bindings, site);
  return evaluated.status === "literal" ? Boolean(evaluated.value) : undefined;
};

const resolveRequireNativeCall = (
  node: t.CallExpression | t.OptionalCallExpression,
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
  hasMemberAccess: boolean,
  access: NativeMemberAccess,
): ResolvedNativeLoaderCall | undefined => {
  const { bindings } = index;
  const call = semanticRequireCallAt(
    node,
    bindings,
    context.accumulator.factoryRequireBindingIds,
    index,
  );
  if (
    call === undefined ||
    call.loader === "local" ||
    call.operation !== "load"
  )
    return undefined;
  const rawArg = argumentNode(call.arguments?.[0]);
  if (rawArg === undefined || t.isSpreadElement(rawArg)) return undefined;
  const literal = stringValue(rawArg);
  if (literal !== undefined) {
    if (!isNativeSpecifier(literal, "require")) return undefined;
    if (call.loader === "unknown" || !call.sourceRelative) {
      context.accumulator.unknownFindings += 1;
      return undefined;
    }
    if (call.sourceRelativePath !== undefined)
      return {
        specifier: literal,
        hasMemberAccess,
        access,
        resolution: {
          kind: "candidates",
          resolution_context: "module-specifier",
          candidates: [literal],
          resolution_base_path: call.sourceRelativePath,
        },
      };
    return { specifier: literal, hasMemberAccess, access };
  }
  const expanded = expandNativePathTemplate(rawArg, context, bindings, node);
  if (expanded === undefined) {
    if (looksLikeUnresolvedNativePath(rawArg))
      context.accumulator.unknownFindings += 1;
    return undefined;
  }
  if (
    call.loader === "unknown" ||
    !call.sourceRelative ||
    (expanded.base === "source-directory" && call.loader === "factory-loader")
  ) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  return {
    specifier: expanded.display,
    hasMemberAccess,
    access,
    resolution:
      expanded.base === "source-directory"
        ? {
            kind: "candidates",
            lookup: "commonjs",
            resolution_context: "filesystem-expression",
            candidates: expanded.candidates,
            ...(expanded.asarUnpacked === undefined
              ? {}
              : asarUnpackedResolutionProps(expanded.asarUnpacked)),
          }
        : {
            kind: "candidates",
            resolution_context: "module-specifier",
            candidates: expanded.candidates,
            ...(call.sourceRelativePath === undefined
              ? {}
              : { resolution_base_path: call.sourceRelativePath }),
          },
  };
};

const normalizeBindingsAddonName = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  if (
    trimmed === "" ||
    trimmed !== raw ||
    raw === "." ||
    raw === ".." ||
    raw.toLowerCase() === ".node" ||
    raw.includes("/") ||
    raw.includes("\\") ||
    raw.includes("\0")
  )
    return undefined;
  return raw.endsWith(".node") ? raw : `${raw}.node`;
};

const isRelativeSubpath = (path: string): boolean =>
  path !== "" &&
  !path.includes("\0") &&
  !path.startsWith("/") &&
  !path.startsWith("\\") &&
  !/^[A-Za-z]:/u.test(path);

const asarUnpackedScopeFromRewrite = (
  rewrite: AsarUnpackedTemplateRewrite,
): ElectronAsarUnpackedRewriteScope | undefined => {
  if (!rewrite.hasPostRewriteSuffix || rewrite.scopeDirectory === undefined)
    return undefined;
  return {
    directory: rewrite.scopeDirectory,
    ...(rewrite.replaceAll ? { replace_all: true } : {}),
  };
};

const asarUnpackedResolutionProps = (
  rewrite: AsarUnpackedTemplateRewrite,
): {
  readonly asar_unpacked: true;
  readonly asar_unpacked_replace_all?: true;
  readonly asar_unpacked_scope?: ElectronAsarUnpackedRewriteScope;
} => {
  const scope = asarUnpackedScopeFromRewrite(rewrite);
  return {
    asar_unpacked: true,
    ...(!rewrite.hasPostRewriteSuffix && rewrite.replaceAll
      ? { asar_unpacked_replace_all: true }
      : {}),
    ...(scope === undefined ? {} : { asar_unpacked_scope: scope }),
  };
};

const resolveSourceAnchoredDirectory = (
  raw: t.Node,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  site: t.Node,
  visited: ReadonlySet<string> = new Set(),
):
  | {
      readonly directory: string;
      readonly displayDirectory: string;
      readonly asarUnpacked: boolean;
      readonly asarUnpackedReplaceAll?: boolean;
      readonly asarUnpackedScope?: ElectronAsarUnpackedRewriteScope;
    }
  | undefined => {
  const node = unwrapJavaScriptExpression(raw).node;
  if (context.pathIntrinsics?.(node, "source-directory") === true)
    return { directory: ".", displayDirectory: ".", asarUnpacked: false };
  const fileExpr = staticFileExpressionPath(node, context.pathIntrinsics);
  if (
    fileExpr?.base === "source-directory" &&
    isRelativeSubpath(fileExpr.path)
  ) {
    const normalized = posix.normalize(fileExpr.path);
    return {
      directory: normalized,
      displayDirectory: normalized,
      asarUnpacked: false,
    };
  }
  if (t.isIdentifier(node)) {
    const binding = resolveSemanticBindingState(bindings, node, node.name);
    if (
      binding === undefined ||
      binding.mutable ||
      binding.referenceInitializers.length > 0 ||
      visited.has(binding.bindingId)
    )
      return undefined;
    const stable = semanticStableInitializer(binding, bindings);
    return stable !== undefined && stable.projection.length === 0
      ? resolveSourceAnchoredDirectory(
          stable.node,
          context,
          bindings,
          site,
          new Set([...visited, binding.bindingId]),
        )
      : undefined;
  }
  const fact = evaluatePathTemplateFact(
    node,
    context,
    bindings,
    site,
    0,
    visited,
  );
  if (
    fact?.base === "source-directory" &&
    fact.pieces.length === 1 &&
    fact.pieces[0]?.kind === "text" &&
    isRelativeSubpath(fact.pieces[0].value)
  ) {
    const directory = posix.normalize(fact.pieces[0].value);
    const rewrite = fact.asarUnpacked;
    if (rewrite !== undefined) {
      if (rewrite.hasPostRewriteSuffix && rewrite.scopeDirectory === undefined)
        return undefined;
      const scope = asarUnpackedScopeFromRewrite(rewrite);
      const displayDirectory =
        rewrite.hasPostRewriteSuffix && rewrite.scopeDirectory !== undefined
          ? posix.normalize(posix.join(rewrite.scopeDirectory, directory))
          : directory;
      return {
        directory,
        displayDirectory,
        asarUnpacked: true,
        ...(!rewrite.hasPostRewriteSuffix && rewrite.replaceAll
          ? { asarUnpackedReplaceAll: true }
          : {}),
        ...(scope === undefined ? {} : { asarUnpackedScope: scope }),
      };
    }
    return {
      directory,
      displayDirectory: directory,
      asarUnpacked: false,
    };
  }
  return undefined;
};

const isProvenProcessDlopen = (
  callee: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
): boolean => {
  const unwrapped = unwrapFinalCallee(callee);
  if (isUnmodifiedGlobalProcessMember(unwrapped, bindings, "dlopen"))
    return true;
  if (bindings.ambientWrites.covers(["global", "process", "dlopen"]))
    return false;
  const path = builtinDataEffectCallablePath(callee, bindings, [
    "process",
    "node:process",
  ]);
  return path !== null && path.length === 1 && path[0] === "dlopen";
};

const isUnmodifiedCommonJsModule = (
  node: t.Node,
  site: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
): boolean =>
  javaScriptRuntimeContext(bindings.program) !== "module" &&
  isUnshadowedGlobal(node, bindings, "module") &&
  !(bindings.ambientBindingWrites.get("module") ?? []).some(
    (write) => semanticEffectTiming(site, write, bindings) !== "after",
  );

const expandNativePathTemplate = (
  raw: t.Node,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  site: t.Node,
):
  | {
      readonly display: string;
      readonly base: "source-directory" | "literal-path";
      readonly candidates: readonly string[];
      readonly asarUnpacked?: AsarUnpackedTemplateRewrite;
    }
  | undefined => {
  const fact = evaluatePathTemplateFact(
    raw,
    context,
    bindings,
    site,
    0,
    new Set(),
  );
  if (fact === undefined) return undefined;
  if (
    fact.asarUnpacked !== undefined &&
    fact.asarUnpacked.hasPostRewriteSuffix &&
    fact.asarUnpacked.scopeDirectory === undefined
  )
    return undefined;
  const usesPlatform = fact.pieces.some(
    (piece) => piece.kind === "host" && piece.axis === "platform",
  );
  const usesArch = fact.pieces.some(
    (piece) => piece.kind === "host" && piece.axis === "arch",
  );
  const platforms = usesPlatform ? HOST_PLATFORMS : ([null] as const);
  const arches = usesArch ? HOST_ARCHES : ([null] as const);
  const rawDisplay = renderTemplatePieces(fact.pieces, null, null);
  const display =
    fact.asarUnpacked?.hasPostRewriteSuffix === true &&
    fact.asarUnpacked.scopeDirectory !== undefined
      ? posix.join(fact.asarUnpacked.scopeDirectory, rawDisplay)
      : rawDisplay;
  const candidates: string[] = [];
  for (const platform of platforms) {
    for (const arch of arches) {
      const value = renderTemplatePieces(fact.pieces, platform, arch);
      if (value.includes("\0") || !isNativeSpecifier(value, "require"))
        return undefined;
      candidates.push(value);
    }
  }
  const unique = [...new Set(candidates)].sort(compareUnicodeCodePoints);
  return unique.length === 0
    ? undefined
    : {
        display,
        base: fact.base,
        candidates: unique,
        ...(fact.asarUnpacked === undefined
          ? {}
          : { asarUnpacked: fact.asarUnpacked }),
      };
};

const renderTemplatePieces = (
  pieces: readonly PathPiece[],
  platform: string | null,
  arch: string | null,
): string =>
  pieces
    .map((piece) =>
      piece.kind === "text"
        ? piece.value
        : piece.axis === "platform"
          ? (platform ?? "${platform}")
          : (arch ?? "${arch}"),
    )
    .join("");

const evaluatePathTemplateFact = (
  raw: t.Node,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  site: t.Node,
  depth: number,
  visitedBindings: ReadonlySet<string>,
): NativePathTemplateFact | undefined => {
  if (depth > MAX_TEMPLATE_DEPTH) return undefined;
  const node = unwrapJavaScriptExpression(raw).node;
  const literal = stringValue(node);
  if (literal !== undefined)
    return {
      pieces: [{ kind: "text", value: literal }],
      base: "literal-path",
    };
  if (context.pathIntrinsics?.(node, "source-directory") === true)
    return {
      pieces: [{ kind: "text", value: "." }],
      base: "source-directory",
    };
  const axis = hostAxisAt(node, bindings, site);
  if (axis !== undefined)
    return { pieces: [{ kind: "host", axis }], base: "literal-path" };
  if (t.isIdentifier(node))
    return evaluateIdentifierTemplateFact(
      node,
      context,
      bindings,
      site,
      depth,
      visitedBindings,
    );
  if (t.isTemplateLiteral(node))
    return evaluateTemplateLiteralFact(
      node,
      context,
      bindings,
      site,
      depth,
      visitedBindings,
    );
  if (t.isBinaryExpression(node, { operator: "+" }))
    return evaluateConcatenationFact(
      node,
      context,
      bindings,
      site,
      depth,
      visitedBindings,
    );
  if (t.isCallExpression(node))
    return evaluatePathCallFact(
      node,
      context,
      bindings,
      site,
      depth,
      visitedBindings,
    );
  return undefined;
};

const evaluateIdentifierTemplateFact = (
  node: t.Identifier,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  site: t.Node,
  depth: number,
  visitedBindings: ReadonlySet<string>,
): NativePathTemplateFact | undefined => {
  const constant = staticStringPiece(node, bindings, site);
  if (constant !== undefined)
    return {
      pieces: [{ kind: "text", value: constant }],
      base: "literal-path",
    };
  const binding = resolveSemanticBindingState(bindings, node, node.name);
  if (
    binding === undefined ||
    binding.mutable ||
    binding.referenceInitializers.length > 0 ||
    visitedBindings.has(binding.bindingId)
  )
    return undefined;
  const stable = semanticStableInitializer(binding, bindings);
  return stable !== undefined && stable.projection.length === 0
    ? evaluatePathTemplateFact(
        stable.node,
        context,
        bindings,
        site,
        depth + 1,
        new Set([...visitedBindings, binding.bindingId]),
      )
    : undefined;
};

const evaluateTemplateLiteralFact = (
  node: t.TemplateLiteral,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  site: t.Node,
  depth: number,
  visitedBindings: ReadonlySet<string>,
): NativePathTemplateFact | undefined => {
  const pieces: PathPiece[] = [];
  let leadingAnchored: NativePathTemplateFact | undefined;
  for (let index = 0; index < node.quasis.length; index += 1) {
    const cooked = node.quasis[index]?.value.cooked;
    if (cooked == null) return undefined;
    if (cooked !== "") pieces.push({ kind: "text", value: cooked });
    const expr = node.expressions[index];
    if (expr === undefined || !t.isExpression(expr)) {
      if (expr !== undefined) return undefined;
      continue;
    }
    const evaluated = evaluatePathTemplateFact(
      expr,
      context,
      bindings,
      site,
      depth + 1,
      visitedBindings,
    );
    if (evaluated === undefined) return undefined;
    if (evaluated.base === "source-directory") {
      if (index !== 0 || pieces.length > 0) return undefined;
      leadingAnchored = evaluated;
      continue;
    }
    pieces.push(...evaluated.pieces);
  }
  const compacted = compactPathPieces(pieces);
  if (leadingAnchored !== undefined) {
    const first = compacted[0];
    if (first?.kind !== "text" || !first.value.startsWith("/"))
      return undefined;
    return normalizeJoinedTemplateSegments(
      [leadingAnchored, { pieces: compacted, base: "literal-path" }],
      "source-directory",
    );
  }
  return { pieces: compacted, base: "literal-path" };
};

const evaluateConcatenationFact = (
  node: t.BinaryExpression,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  site: t.Node,
  depth: number,
  visitedBindings: ReadonlySet<string>,
): NativePathTemplateFact | undefined => {
  const rightOperands: t.Node[] = [];
  let current: t.Node = node;
  while (t.isBinaryExpression(current, { operator: "+" })) {
    rightOperands.push(current.right);
    current = unwrapJavaScriptExpression(current.left).node;
  }
  const leading = evaluatePathTemplateFact(
    current,
    context,
    bindings,
    site,
    depth + 1,
    visitedBindings,
  );
  if (leading === undefined) return undefined;
  const pieces: PathPiece[] =
    leading.base === "source-directory" ? [] : [...leading.pieces];
  for (const operand of rightOperands.reverse()) {
    const part = evaluatePathTemplateFact(
      operand,
      context,
      bindings,
      site,
      depth + 1,
      visitedBindings,
    );
    if (part === undefined || part.base !== "literal-path") return undefined;
    pieces.push(...part.pieces);
  }
  const compacted = compactPathPieces(pieces);
  if (leading.base === "source-directory") {
    const first = compacted[0];
    if (first?.kind !== "text" || !first.value.startsWith("/"))
      return undefined;
    return normalizeJoinedTemplateSegments(
      [leading, { pieces: compacted, base: "literal-path" }],
      "source-directory",
    );
  }
  return { pieces: compacted, base: "literal-path" };
};

const evaluatePathCallFact = (
  node: t.CallExpression,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  site: t.Node,
  depth: number,
  visitedBindings: ReadonlySet<string>,
): NativePathTemplateFact | undefined => {
  const unpacked = unwrapAsarUnpackedReplace(node, bindings);
  if (unpacked !== undefined) {
    const inner = evaluatePathTemplateFact(
      unpacked.receiver,
      context,
      bindings,
      site,
      depth + 1,
      visitedBindings,
    );
    if (inner === undefined) return undefined;
    if (inner.base === "literal-path") {
      const replaced = rewriteLiteralAsarPieces(
        inner.pieces,
        unpacked.replaceAll,
      );
      return replaced === undefined
        ? undefined
        : { pieces: replaced, base: "literal-path" };
    }
    if (inner.asarUnpacked !== undefined) return undefined;
    const scopeDirectory =
      inner.pieces.length === 1 &&
      inner.pieces[0]?.kind === "text" &&
      isRelativeSubpath(inner.pieces[0].value)
        ? posix.normalize(inner.pieces[0].value)
        : undefined;
    return {
      pieces: inner.pieces,
      base: "source-directory",
      asarUnpacked: {
        scopeDirectory,
        replaceAll: unpacked.replaceAll,
        hasPostRewriteSuffix: false,
      },
    };
  }
  if (context.pathIntrinsics?.(node.callee, "file-url-to-path") === true)
    return evaluateFileUrlCallFact(
      node,
      context,
      bindings,
      site,
      depth,
      visitedBindings,
    );
  if (context.pathIntrinsics?.(node.callee, "join") === true)
    return evaluatePathJoinFact(
      node,
      context,
      bindings,
      site,
      depth,
      visitedBindings,
    );
  if (context.pathIntrinsics?.(node.callee) === true)
    return evaluatePathResolveFact(
      node,
      context,
      bindings,
      site,
      depth,
      visitedBindings,
    );
  return undefined;
};

const unwrapAsarUnpackedReplace = (
  node: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
): { readonly receiver: t.Node; readonly replaceAll: boolean } | undefined => {
  if (!t.isCallExpression(node) || node.arguments.length !== 2)
    return undefined;
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (!t.isMemberExpression(callee)) return undefined;
  const method = semanticStaticPropertyKey(callee.property, callee.computed);
  if (method !== "replace" && method !== "replaceAll") return undefined;
  if (bindings.ambientWrites.covers(["global", "String", "prototype", method]))
    return undefined;
  const search = stringValue(argumentNode(node.arguments[0]));
  const replacement = stringValue(argumentNode(node.arguments[1]));
  return search === "app.asar" && replacement === "app.asar.unpacked"
    ? { receiver: callee.object, replaceAll: method === "replaceAll" }
    : undefined;
};

const evaluateFileUrlCallFact = (
  node: t.CallExpression,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  site: t.Node,
  depth: number,
  visitedBindings: ReadonlySet<string>,
): NativePathTemplateFact | undefined => {
  const staticFile = staticFileExpressionPath(node, context.pathIntrinsics);
  if (staticFile !== undefined)
    return {
      pieces: [{ kind: "text", value: staticFile.path }],
      base:
        staticFile.base === "source-directory" &&
        !isRelativeSubpath(staticFile.path)
          ? "literal-path"
          : staticFile.base,
    };
  if (node.arguments.length !== 1) return undefined;
  const arg0 = argumentNode(node.arguments[0]);
  if (arg0 === undefined) return undefined;
  const urlNode = unwrapJavaScriptExpression(arg0).node;
  if (
    !t.isNewExpression(urlNode) ||
    urlNode.arguments.length !== 2 ||
    context.pathIntrinsics?.(urlNode, "source-url") !== true ||
    !isUnmodifiedImportMetaUrl(argumentNode(urlNode.arguments[1]), bindings)
  )
    return undefined;
  const specArg = argumentNode(urlNode.arguments[0]);
  if (specArg === undefined || t.isSpreadElement(specArg)) return undefined;
  const inner = evaluatePathTemplateFact(
    specArg,
    context,
    bindings,
    site,
    depth + 1,
    visitedBindings,
  );
  if (inner === undefined || inner.base !== "literal-path") return undefined;
  return decodeUrlTemplatePieces(inner.pieces);
};

const decodeUrlTemplatePieces = (
  rawPieces: readonly PathPiece[],
): NativePathTemplateFact | undefined => {
  const PLATFORM_TOKEN = "__rea_url_platform_token__";
  const ARCH_TOKEN = "__rea_url_arch_token__";
  if (
    rawPieces.some(
      (piece) =>
        piece.kind === "text" &&
        (piece.value.includes(PLATFORM_TOKEN) ||
          piece.value.includes(ARCH_TOKEN)),
    )
  )
    return undefined;
  const tokenizedSpec = renderTemplatePieces(
    rawPieces,
    PLATFORM_TOKEN,
    ARCH_TOKEN,
  );
  const tokenizedParsed = staticSourceRelativeUrlPath(
    t.newExpression(t.identifier("URL"), [
      t.stringLiteral(tokenizedSpec),
      t.identifier("base"),
    ]),
  );
  if (
    tokenizedParsed === undefined ||
    tokenizedParsed.directory ||
    tokenizedParsed.path.startsWith("/")
  )
    return undefined;
  const decodedPieces = splitTokenizedTemplatePieces(
    tokenizedParsed.path,
    PLATFORM_TOKEN,
    ARCH_TOKEN,
  );
  const usesPlatform = rawPieces.some(
    (piece) => piece.kind === "host" && piece.axis === "platform",
  );
  const usesArch = rawPieces.some(
    (piece) => piece.kind === "host" && piece.axis === "arch",
  );
  const platforms = usesPlatform ? HOST_PLATFORMS : ([null] as const);
  const arches = usesArch ? HOST_ARCHES : ([null] as const);
  for (const platform of platforms) {
    for (const arch of arches) {
      const concreteSpec = renderTemplatePieces(rawPieces, platform, arch);
      const concreteParsed = staticSourceRelativeUrlPath(
        t.newExpression(t.identifier("URL"), [
          t.stringLiteral(concreteSpec),
          t.identifier("base"),
        ]),
      );
      if (
        concreteParsed === undefined ||
        concreteParsed.directory ||
        concreteParsed.path.startsWith("/") ||
        concreteParsed.path !==
          renderTemplatePieces(decodedPieces, platform, arch)
      )
        return undefined;
    }
  }
  return { pieces: decodedPieces, base: "source-directory" };
};

const evaluatePathJoinFact = (
  node: t.CallExpression,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  site: t.Node,
  depth: number,
  visitedBindings: ReadonlySet<string>,
): NativePathTemplateFact | undefined => {
  if (node.arguments.length === 0) return undefined;
  const parts: NativePathTemplateFact[] = [];
  for (const argument of node.arguments) {
    const arg = argumentNode(argument);
    if (arg === undefined || t.isSpreadElement(arg)) return undefined;
    const part = evaluatePathTemplateFact(
      arg,
      context,
      bindings,
      site,
      depth + 1,
      visitedBindings,
    );
    if (part === undefined) return undefined;
    parts.push(part);
  }
  const firstNonEmpty = parts.findIndex(
    (part) =>
      !(
        part.pieces.length === 1 &&
        part.pieces[0]?.kind === "text" &&
        part.pieces[0].value === ""
      ),
  );
  const anchors = parts.flatMap((part, index) =>
    part.base === "source-directory" ? [index] : [],
  );
  if (anchors.length > 1) return undefined;
  if (anchors.length === 1 && anchors[0] !== firstNonEmpty) return undefined;
  const base = anchors.length === 1 ? "source-directory" : "literal-path";
  return normalizeJoinedTemplateSegments(parts, base);
};

const evaluatePathResolveFact = (
  node: t.CallExpression,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  site: t.Node,
  depth: number,
  visitedBindings: ReadonlySet<string>,
): NativePathTemplateFact | undefined => {
  const reversed: NativePathTemplateFact[] = [];
  let base: NativePathTemplateFact["base"] | undefined;
  for (let index = node.arguments.length - 1; index >= 0; index -= 1) {
    const arg = argumentNode(node.arguments[index]);
    if (arg === undefined || t.isSpreadElement(arg)) return undefined;
    const part = evaluatePathTemplateFact(
      arg,
      context,
      bindings,
      site,
      depth + 1,
      visitedBindings,
    );
    if (part === undefined) return undefined;
    if (part.base === "source-directory") {
      reversed.push(part);
      base = "source-directory";
      break;
    }
    reversed.push(part);
    const firstPiece = part.pieces[0];
    if (firstPiece?.kind === "text" && posix.isAbsolute(firstPiece.value)) {
      base = "literal-path";
      break;
    }
  }
  if (base === undefined) return undefined;
  return normalizeJoinedTemplateSegments(reversed.reverse(), base);
};

const rewriteLiteralAsarPieces = (
  pieces: readonly PathPiece[],
  replaceAll: boolean,
): PathPiece[] | undefined => {
  const PLATFORM_TOKEN = "__rea_host_platform_token__";
  const ARCH_TOKEN = "__rea_host_arch_token__";
  if (
    pieces.some(
      (piece) =>
        piece.kind === "text" &&
        (piece.value.includes(PLATFORM_TOKEN) ||
          piece.value.includes(ARCH_TOKEN)),
    )
  )
    return undefined;
  const encoded = renderTemplatePieces(pieces, PLATFORM_TOKEN, ARCH_TOKEN);
  const replaced = replaceAll
    ? encoded.replaceAll("app.asar", "app.asar.unpacked")
    : encoded.replace("app.asar", "app.asar.unpacked");
  return splitTokenizedTemplatePieces(replaced, PLATFORM_TOKEN, ARCH_TOKEN);
};

const isEmptyOrDotPart = (part: NativePathTemplateFact): boolean =>
  part.pieces.length === 1 &&
  part.pieces[0]?.kind === "text" &&
  (part.pieces[0].value === "" || part.pieces[0].value === ".");

const normalizeJoinedTemplateSegments = (
  parts: readonly NativePathTemplateFact[],
  base: "source-directory" | "literal-path",
): NativePathTemplateFact | undefined => {
  const PLATFORM_TOKEN = "__rea_host_platform_token__";
  const ARCH_TOKEN = "__rea_host_arch_token__";
  const encoded = parts.map((part) =>
    renderTemplatePieces(part.pieces, PLATFORM_TOKEN, ARCH_TOKEN),
  );
  if (
    encoded.some(
      (segment) =>
        segment.includes("\\") ||
        parts.some((part) =>
          part.pieces.some(
            (piece) =>
              piece.kind === "text" &&
              (piece.value.includes(PLATFORM_TOKEN) ||
                piece.value.includes(ARCH_TOKEN)),
          ),
        ),
    )
  )
    return undefined;
  const anchorIndex = parts.findIndex(
    (part) => part.base === "source-directory",
  );
  const anchorRewrite =
    anchorIndex >= 0 ? parts[anchorIndex]?.asarUnpacked : undefined;
  if (base === "source-directory" && anchorRewrite !== undefined) {
    const suffixParts = parts.slice(anchorIndex + 1);
    const hasNewSuffix = suffixParts.some((part) => !isEmptyOrDotPart(part));
    if (hasNewSuffix || anchorRewrite.hasPostRewriteSuffix) {
      if (anchorRewrite.scopeDirectory === undefined) return undefined;
      const suffixEncoded = [
        ".",
        ...(anchorRewrite.hasPostRewriteSuffix ? [encoded[anchorIndex]!] : []),
        ...encoded.slice(anchorIndex + 1),
      ];
      const suffixJoined = posix.join(...suffixEncoded);
      const suffixTrimmed =
        suffixJoined === "/" ? suffixJoined : suffixJoined.replace(/\/$/u, "");
      return {
        pieces: splitTokenizedTemplatePieces(
          suffixTrimmed,
          PLATFORM_TOKEN,
          ARCH_TOKEN,
        ),
        base: "source-directory",
        asarUnpacked: {
          scopeDirectory: anchorRewrite.scopeDirectory,
          replaceAll: anchorRewrite.replaceAll,
          hasPostRewriteSuffix: true,
        },
      };
    }
    const joined = posix.join(...encoded);
    const trimmed = joined === "/" ? joined : joined.replace(/\/$/u, "");
    return {
      pieces: splitTokenizedTemplatePieces(trimmed, PLATFORM_TOKEN, ARCH_TOKEN),
      base: "source-directory",
      asarUnpacked: anchorRewrite,
    };
  }
  const joined = posix.join(...encoded);
  const trimmed = joined === "/" ? joined : joined.replace(/\/$/u, "");
  return {
    pieces: splitTokenizedTemplatePieces(trimmed, PLATFORM_TOKEN, ARCH_TOKEN),
    base,
  };
};

const splitTokenizedTemplatePieces = (
  text: string,
  platformToken: string,
  archToken: string,
): PathPiece[] => {
  const pieces: PathPiece[] = [];
  const tokenPattern = new RegExp(`(${platformToken}|${archToken})`, "gu");
  let cursor = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > cursor)
      pieces.push({ kind: "text", value: text.slice(cursor, index) });
    pieces.push({
      kind: "host",
      axis: match[0] === platformToken ? "platform" : "arch",
    });
    cursor = index + match[0].length;
  }
  if (cursor < text.length)
    pieces.push({ kind: "text", value: text.slice(cursor) });
  return compactPathPieces(pieces);
};

const compactPathPieces = (pieces: readonly PathPiece[]): PathPiece[] => {
  const merged: PathPiece[] = [];
  for (const piece of pieces) {
    if (piece.kind === "text" && piece.value === "") continue;
    const prev = merged.at(-1);
    if (piece.kind === "text" && prev?.kind === "text") {
      merged[merged.length - 1] = {
        kind: "text",
        value: prev.value + piece.value,
      };
    } else {
      merged.push(piece);
    }
  }
  return merged.length === 0 ? [{ kind: "text", value: "" }] : merged;
};

const hostAxisAt = (
  raw: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
  site: t.Node = raw,
  selectedProjection: readonly string[] = [],
  visited: ReadonlySet<string> = new Set(),
): HostAxis | undefined => {
  const node = unwrapJavaScriptExpression(raw).node;
  if (selectedProjection.length === 0) {
    if (isUnmodifiedGlobalProcessMember(node, bindings, "platform", site))
      return "platform";
    if (isUnmodifiedGlobalProcessMember(node, bindings, "arch", site))
      return "arch";
    if (t.isCallExpression(node) && node.arguments.length === 0) {
      const osPath = builtinDataEffectCallablePath(node.callee, bindings, [
        "os",
      ]);
      if (
        osPath?.length === 1 &&
        (osPath[0] === "platform" || osPath[0] === "arch")
      )
        return osPath[0];
    }
  }
  if (t.isMemberExpression(node)) {
    const key = semanticStaticPropertyKey(node.property, node.computed);
    return key === null
      ? undefined
      : hostAxisAt(
          node.object,
          bindings,
          site,
          [key, ...selectedProjection],
          visited,
        );
  }
  const processAxis = semanticProcessHostAxis(
    node,
    bindings,
    selectedProjection,
    selectedProjection.length === 0 ? node : site,
  );
  if (processAxis !== undefined) return processAxis;
  if (!t.isIdentifier(node)) return undefined;
  const binding = resolveSemanticBindingState(bindings, node, node.name);
  if (
    binding === undefined ||
    visited.has(binding.bindingId) ||
    binding.mutable ||
    binding.referenceInitializers.length > 0
  )
    return undefined;
  const stable = semanticStableInitializer(binding, bindings);
  if (
    stable === undefined ||
    !stable.projection.every((key): key is string => typeof key === "string")
  )
    return undefined;
  return hostAxisAt(
    stable.node,
    bindings,
    selectedProjection.length === 0 ? node : site,
    [...stable.projection, ...selectedProjection],
    new Set([...visited, binding.bindingId]),
  );
};

const staticStringPiece = (
  raw: t.Node | null | undefined,
  bindings: JavaScriptSemanticAnalysisState,
  site: t.Node,
): string | undefined => {
  if (raw == null) return undefined;
  const direct = stringValue(raw);
  if (direct !== undefined) return direct;
  const node = unwrapJavaScriptExpression(raw).node;
  if (!t.isIdentifier(node)) return undefined;
  const evaluated = evaluateSemanticExpression(node, bindings, site);
  return evaluated.status === "literal" && typeof evaluated.value === "string"
    ? evaluated.value
    : undefined;
};

const looksLikeUnresolvedNativePath = (raw: t.Node): boolean => {
  const node = unwrapJavaScriptExpression(raw).node;
  const literal = stringValue(node);
  if (literal !== undefined) return isNativeSpecifier(literal, "import");
  if (t.isTemplateLiteral(node)) {
    const tail = node.quasis.at(-1)?.value.cooked ?? "";
    return isNativeSpecifier(tail, "import");
  }
  if (t.isBinaryExpression(node, { operator: "+" }))
    return looksLikeUnresolvedNativePath(node.right);
  if (
    t.isCallExpression(node) ||
    t.isOptionalCallExpression(node) ||
    t.isNewExpression(node)
  ) {
    const candidate = t.isNewExpression(node)
      ? argumentNode(node.arguments[0])
      : argumentNode(node.arguments.at(-1));
    return candidate !== undefined && looksLikeUnresolvedNativePath(candidate);
  }
  if (t.isConditionalExpression(node))
    return (
      looksLikeUnresolvedNativePath(node.consequent) ||
      looksLikeUnresolvedNativePath(node.alternate)
    );
  if (t.isLogicalExpression(node))
    return (
      looksLikeUnresolvedNativePath(node.left) ||
      looksLikeUnresolvedNativePath(node.right)
    );
  if (t.isSequenceExpression(node)) {
    const last = node.expressions.at(-1);
    return last !== undefined && looksLikeUnresolvedNativePath(last);
  }
  return false;
};
