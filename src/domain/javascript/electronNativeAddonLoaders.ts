import { posix } from "node:path";

import * as t from "@babel/types";

import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { stripQueryAndFragment } from "../artifactPathSyntax.js";
import type {
  ElectronNativeAddonBindingFinding,
  ElectronNativeAddonResolution,
} from "./electronStaticAnalysisTypes.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { builtinDataEffectCallablePath } from "./javascriptSemanticDataEffectHelpers.js";
import {
  isUnmodifiedGlobalReference,
  isUnmodifiedImportMetaUrl,
} from "./javascriptSemanticAmbientWrites.js";
import {
  isUnshadowedGlobal,
  semanticEffectTiming,
} from "./javascriptSemanticMutationInitializers.js";
import { semanticRequireCallAt } from "./javascriptSemanticRequireOrigin.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  evaluateSemanticExpression,
  evaluateSemanticExpressionProvenance,
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

interface NativePathTemplateFact {
  readonly pieces: readonly PathPiece[];
  readonly base: "source-directory" | "literal-path";
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

const hasDlopenCalleeSyntax = (
  call: t.CallExpression | t.OptionalCallExpression,
): boolean => {
  if (call.arguments.length < 2) return false;
  const callee = unwrapJavaScriptExpression(call.callee).node;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return false;
  return (
    semanticStaticPropertyKey(callee.property, callee.computed) === "dlopen"
  );
};

/** Fast syntax check for `*.dlopen(module, filename)` calls. */
export const isDlopenCallCandidate = (
  node: t.Node | null | undefined,
): node is t.CallExpression | t.OptionalCallExpression =>
  (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
  hasDlopenCalleeSyntax(node);

/** Fast syntax check for value sites that may invoke a native addon loader. */
export const mayInvokeNativeLoader = (
  node: t.Node | null | undefined,
): boolean => {
  const call = nativeCallReceiver(node);
  if (
    call === undefined ||
    call.arguments.length > 3 ||
    hasDlopenCalleeSyntax(call)
  )
    return false;
  const callee = unwrapJavaScriptExpression(call.callee).node;
  return (
    t.isIdentifier(callee) ||
    t.isMemberExpression(callee) ||
    t.isOptionalMemberExpression(callee) ||
    t.isCallExpression(callee) ||
    t.isOptionalCallExpression(callee)
  );
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

/** Resolve `process.dlopen(module, filename[, flags])` when `process.dlopen` is proven. */
export const resolveDlopenCall = (
  node: t.CallExpression | t.OptionalCallExpression,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
): ResolvedDlopenCall | undefined => {
  if (!isProvenProcessDlopen(node.callee, bindings)) return undefined;
  const rawModule = argumentNode(node.arguments[0]);
  const rawFilename = argumentNode(node.arguments[1]);
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
    const resolvedCall = semanticRequireCallAt(
      filenameExpr,
      bindings,
      context.accumulator.factoryRequireBindingIds,
    );
    if (resolvedCall !== undefined && resolvedCall.operation === "resolve") {
      if (resolvedCall.loader === "local") return undefined;
      if (resolvedCall.loader === "unknown" || !resolvedCall.sourceRelative) {
        context.accumulator.unknownFindings += 1;
        return undefined;
      }
      const resolveArg = argumentNode(resolvedCall.arguments?.[0]);
      const expanded =
        resolveArg === undefined
          ? undefined
          : expandNativePathTemplate(
              resolveArg,
              context,
              bindings,
              filenameExpr,
            );
      if (expanded === undefined) {
        context.accumulator.unknownFindings += 1;
        return undefined;
      }
      return {
        specifier: expanded.display,
        kind,
        access,
        resolution:
          expanded.base === "source-directory"
            ? {
                kind: "candidates",
                resolution_context: "filesystem-expression",
                candidates: expanded.candidates,
              }
            : {
                kind: "candidates",
                resolution_context: "module-specifier",
                candidates: expanded.candidates,
                ...(resolvedCall.sourceRelativePath === undefined
                  ? {}
                  : { resolution_base_path: resolvedCall.sourceRelativePath }),
              },
      };
    }
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
      resolution_context: "filesystem-expression",
      // Relative/absolute literal strings in process.dlopen depend on cwd or
      // host mount layout unless anchored to the source file's directory.
      candidates:
        expanded.base === "source-directory" ? expanded.candidates : [],
    },
  };
};

/** Resolve `require(...)`, `createRequire(...)`, `node-gyp-build`, or `bindings`. */
export const resolveNativeLoaderCall = (
  node: t.Node | null | undefined,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
): ResolvedNativeLoaderCall | undefined => {
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
    hasDlopenCalleeSyntax(node)
  )
    return undefined;
  const access: NativeMemberAccess = {
    members: member === null ? [] : [member],
    namespaceAccess: !hasMemberAccess,
    dynamicMemberAccess: hasMemberAccess && member === null,
  };
  const helper = provenHelperPackage(node.callee, bindings);
  if (helper === "node-gyp-build")
    return resolveNodeGypBuildCall(
      node,
      context,
      bindings,
      hasMemberAccess,
      access,
    );
  if (helper === "bindings")
    return resolveBindingsHelperCall(
      node,
      context,
      bindings,
      hasMemberAccess,
      access,
    );
  return resolveRequireNativeCall(
    node,
    context,
    bindings,
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

const resolveNodeGypBuildCall = (
  node: t.CallExpression | t.OptionalCallExpression,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  hasMemberAccess: boolean,
  access: NativeMemberAccess,
): ResolvedNativeLoaderCall | undefined => {
  if (node.arguments.length === 0)
    return {
      specifier: "node-gyp-build",
      hasMemberAccess,
      access,
      resolution: { kind: "node-gyp-build", directory: null },
    };
  if (node.arguments.length > 1 || t.isSpreadElement(node.arguments[0])) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  const arg0 = argumentNode(node.arguments[0]);
  if (arg0 === undefined) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  const unwrapped = unwrapJavaScriptExpression(arg0).node;
  if (isUnshadowedGlobal(unwrapped, bindings, "undefined"))
    return {
      specifier: "node-gyp-build",
      hasMemberAccess,
      access,
      resolution: { kind: "node-gyp-build", directory: null },
    };
  const directory = resolveSourceAnchoredDirectory(
    unwrapped,
    context,
    bindings,
  );
  if (directory === undefined) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  return {
    specifier: `node-gyp-build:${directory}`,
    hasMemberAccess,
    access,
    resolution: { kind: "node-gyp-build", directory },
  };
};

const resolveBindingsHelperCall = (
  node: t.CallExpression | t.OptionalCallExpression,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  hasMemberAccess: boolean,
  access: NativeMemberAccess,
): ResolvedNativeLoaderCall | undefined => {
  if (node.arguments.length !== 1 || t.isSpreadElement(node.arguments[0])) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  const arg0 = argumentNode(node.arguments[0]);
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
  const objectNode = resolveStaticObjectExpression(arg0, bindings);
  if (objectNode === undefined) {
    context.accumulator.unknownFindings += 1;
    return undefined;
  }
  let rawAddonName: string | undefined;
  let moduleRoot: string | null = null;
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
      } else {
        const resolved = resolveSourceAnchoredDirectory(
          valueNode,
          context,
          bindings,
        );
        if (resolved === undefined) {
          context.accumulator.unknownFindings += 1;
          return undefined;
        }
        moduleRoot = resolved;
      }
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
  return {
    specifier: addonName,
    hasMemberAccess,
    access,
    resolution: {
      kind: "bindings",
      addon_name: addonName,
      module_root: moduleRoot,
    },
  };
};

const resolveRequireNativeCall = (
  node: t.CallExpression | t.OptionalCallExpression,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  hasMemberAccess: boolean,
  access: NativeMemberAccess,
): ResolvedNativeLoaderCall | undefined => {
  const call = semanticRequireCallAt(
    node,
    bindings,
    context.accumulator.factoryRequireBindingIds,
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
            resolution_context: "filesystem-expression",
            candidates: expanded.candidates,
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
  return raw.toLowerCase().endsWith(".node") ? raw : `${raw}.node`;
};

const resolveSourceAnchoredDirectory = (
  raw: t.Node,
  context: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  visited: ReadonlySet<string> = new Set(),
): string | undefined => {
  const node = unwrapJavaScriptExpression(raw).node;
  const unpackedReceiver = unwrapAsarUnpackedReplace(node, bindings);
  if (unpackedReceiver !== undefined)
    return resolveSourceAnchoredDirectory(
      unpackedReceiver,
      context,
      bindings,
      visited,
    );
  if (context.pathIntrinsics?.(node, "source-directory") === true) return ".";
  const fileExpr = staticFileExpressionPath(node, context.pathIntrinsics);
  if (fileExpr?.base === "source-directory")
    return posix.normalize(fileExpr.path);
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
    if (stable !== undefined && stable.projection.length === 0)
      return resolveSourceAnchoredDirectory(
        stable.node,
        context,
        bindings,
        new Set([...visited, binding.bindingId]),
      );
  }
  return undefined;
};

const resolveStaticObjectExpression = (
  raw: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
  visited: ReadonlySet<string> = new Set(),
): t.ObjectExpression | undefined => {
  const node = unwrapJavaScriptExpression(raw).node;
  if (t.isObjectExpression(node)) return node;
  if (!t.isIdentifier(node)) return undefined;
  const binding = resolveSemanticBindingState(bindings, node, node.name);
  if (
    binding === undefined ||
    binding.mutable ||
    binding.referenceInitializers.length > 0 ||
    binding.memberWrites.length > 0 ||
    visited.has(binding.bindingId)
  )
    return undefined;
  const stable = semanticStableInitializer(binding, bindings);
  return stable !== undefined && stable.projection.length === 0
    ? resolveStaticObjectExpression(
        stable.node,
        bindings,
        new Set([...visited, binding.bindingId]),
      )
    : undefined;
};

const isProvenProcessDlopen = (
  callee: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
): boolean => {
  if (isUnmodifiedGlobalReference(callee, bindings, ["process", "dlopen"]))
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
  const usesPlatform = fact.pieces.some(
    (piece) => piece.kind === "host" && piece.axis === "platform",
  );
  const usesArch = fact.pieces.some(
    (piece) => piece.kind === "host" && piece.axis === "arch",
  );
  const platforms = usesPlatform ? HOST_PLATFORMS : ([null] as const);
  const arches = usesArch ? HOST_ARCHES : ([null] as const);
  const render = (platform: string | null, arch: string | null): string =>
    fact.pieces
      .map((piece) =>
        piece.kind === "text"
          ? piece.value
          : piece.axis === "platform"
            ? (platform ?? "${platform}")
            : (arch ?? "${arch}"),
      )
      .join("");
  const display = render(null, null);
  const candidates: string[] = [];
  for (const platform of platforms) {
    for (const arch of arches) {
      const value = render(platform, arch);
      if (value.includes("\0") || !isNativeSpecifier(value, "require"))
        return undefined;
      candidates.push(value);
    }
  }
  const unique = [...new Set(candidates)].sort(compareUnicodeCodePoints);
  return unique.length === 0
    ? undefined
    : { display, base: fact.base, candidates: unique };
};

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
  const axis = hostAxisAt(node, bindings);
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
  let anchored = false;
  for (let index = 0; index < node.quasis.length; index += 1) {
    const cooked = node.quasis[index]?.value.cooked;
    if (cooked == null) return undefined;
    if (index === 1 && anchored && !cooked.startsWith("/")) return undefined;
    if (cooked !== "")
      pieces.push({
        kind: "text",
        value: index === 1 && anchored ? posix.join(".", cooked) : cooked,
      });
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
      anchored = true;
      continue;
    }
    pieces.push(...evaluated.pieces);
  }
  if (anchored && pieces.length === 0) return undefined;
  return {
    pieces: compactPathPieces(pieces),
    base: anchored ? "source-directory" : "literal-path",
  };
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
    return {
      pieces: [
        { kind: "text", value: posix.join(".", first.value) },
        ...compacted.slice(1),
      ],
      base: "source-directory",
    };
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
  const unpackedReceiver = unwrapAsarUnpackedReplace(node, bindings);
  if (unpackedReceiver !== undefined) {
    const inner = evaluatePathTemplateFact(
      unpackedReceiver,
      context,
      bindings,
      site,
      depth + 1,
      visitedBindings,
    );
    return inner?.base === "source-directory" ? inner : undefined;
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
): t.Node | undefined => {
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
    ? callee.object
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
      base: staticFile.base,
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
  // Validate with concrete safe tokens via staticSourceRelativeUrlPath.
  const probeText = inner.pieces
    .map((piece) => (piece.kind === "text" ? piece.value : "darwin"))
    .join("");
  const probeNode = t.newExpression(t.identifier("URL"), [
    t.stringLiteral(probeText),
    t.identifier("base"),
  ]);
  const probeResult = staticSourceRelativeUrlPath(probeNode);
  if (
    probeResult === undefined ||
    probeResult.directory ||
    probeResult.path.startsWith("/")
  )
    return undefined;
  return normalizeJoinedTemplateSegments([inner], "source-directory");
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

const normalizeJoinedTemplateSegments = (
  parts: readonly NativePathTemplateFact[],
  base: "source-directory" | "literal-path",
): NativePathTemplateFact | undefined => {
  const PLATFORM_TOKEN = "__rea_host_platform_token__";
  const ARCH_TOKEN = "__rea_host_arch_token__";
  const encoded = parts.map((part) =>
    part.pieces
      .map((piece) =>
        piece.kind === "text"
          ? piece.value
          : piece.axis === "platform"
            ? PLATFORM_TOKEN
            : ARCH_TOKEN,
      )
      .join(""),
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
  const joined = posix.join(...encoded);
  const trimmed = joined === "/" ? joined : joined.replace(/\/$/u, "");
  const pieces: PathPiece[] = [];
  const tokenPattern = new RegExp(`(${PLATFORM_TOKEN}|${ARCH_TOKEN})`, "gu");
  let cursor = 0;
  for (const match of trimmed.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > cursor)
      pieces.push({ kind: "text", value: trimmed.slice(cursor, index) });
    pieces.push({
      kind: "host",
      axis: match[0] === PLATFORM_TOKEN ? "platform" : "arch",
    });
    cursor = index + match[0].length;
  }
  if (cursor < trimmed.length)
    pieces.push({ kind: "text", value: trimmed.slice(cursor) });
  return { pieces: compactPathPieces(pieces), base };
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
  selectedProjection: readonly string[] = [],
  visited: ReadonlySet<string> = new Set(),
): HostAxis | undefined => {
  const node = unwrapJavaScriptExpression(raw).node;
  if (selectedProjection.length === 0) {
    if (isUnmodifiedGlobalReference(node, bindings, ["process", "platform"]))
      return "platform";
    if (isUnmodifiedGlobalReference(node, bindings, ["process", "arch"]))
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
          [key, ...selectedProjection],
          visited,
        );
  }
  if (!t.isIdentifier(node)) return undefined;
  const binding = resolveSemanticBindingState(bindings, node, node.name);
  if (binding === undefined) {
    if (
      selectedProjection.length === 1 &&
      (selectedProjection[0] === "platform" ||
        selectedProjection[0] === "arch") &&
      !bindings.ambientWrites.covers([
        "global",
        "process",
        selectedProjection[0],
      ]) &&
      isUnmodifiedGlobalReference(node, bindings, "process")
    )
      return selectedProjection[0];
    return undefined;
  }
  if (visited.has(binding.bindingId)) return undefined;
  const provenance = evaluateSemanticExpressionProvenance(node, bindings);
  if (provenance.status === "module" && provenance.origins.length === 1) {
    const origin = provenance.origins[0]!;
    if (origin.specifier.replace(/^node:/u, "") === "process") {
      const imported =
        origin.resolutionMode !== "require" &&
        origin.importedPath[0] === "default"
          ? origin.importedPath.slice(1)
          : origin.importedPath;
      const fullPath = [...imported, ...selectedProjection];
      if (
        fullPath.length === 1 &&
        (fullPath[0] === "platform" || fullPath[0] === "arch") &&
        !bindings.ambientWrites.covers(["global", "process", fullPath[0]]) &&
        binding.memberWrites.length === 0
      )
        return fullPath[0];
    }
  }
  if (binding.mutable || binding.referenceInitializers.length > 0)
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
  if (t.isTemplateLiteral(node)) {
    const tail = node.quasis.at(-1)?.value.cooked ?? "";
    return tail.toLowerCase().endsWith(".node");
  }
  if (t.isBinaryExpression(node, { operator: "+" })) {
    const right = stringValue(node.right);
    return right !== undefined && right.toLowerCase().endsWith(".node");
  }
  if (t.isCallExpression(node)) {
    const last = argumentNode(node.arguments.at(-1));
    return last !== undefined && looksLikeUnresolvedNativePath(last);
  }
  return false;
};
