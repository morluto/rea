import { posix } from "node:path";

import {
  logicalPathEscapesRoot,
  normalizeJoinedLogicalPath,
} from "../../domain/artifactIdentity.js";
import {
  compareUnicodeCodePoints,
  compositeKey,
} from "../../domain/unicodeCodePointOrder.js";
import type {
  ElectronAsarUnpackedRewriteScope,
  ElectronNativeAddonBindingFinding,
} from "../../domain/javascript/electronStaticAnalysisTypes.js";
import type {
  JavaScriptArtifactFile,
  JavaScriptUnanalyzedArtifactLookup,
} from "../../domain/javascript/javascriptArtifactFiles.js";
import { isNativeAddonModuleTarget } from "../../domain/javascript/javascriptModuleResolutionMode.js";
import type { JavaScriptJsonDocuments } from "./JavaScriptJsonDocuments.js";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";

export interface ElectronNativeAddonResolverInput {
  readonly files: ReadonlyMap<string, JavaScriptArtifactFile>;
  readonly jsonDocuments: JavaScriptJsonDocuments;
  readonly directoryPaths?: ReadonlySet<string> | undefined;
  readonly unanalyzedFiles?: JavaScriptUnanalyzedArtifactLookup | undefined;
}

export interface ElectronNativeAddonResolver {
  resolve(
    file: JavaScriptArtifactFile,
    finding: ElectronNativeAddonBindingFinding,
  ): readonly string[];
}

interface NativeAddonInventoryIndex {
  readonly nativeAddonPaths: readonly string[];
  readonly childSegmentsByDir: ReadonlyMap<string, ReadonlySet<string>>;
}

interface NativeAddonResolverState {
  readonly input: ElectronNativeAddonResolverInput;
  inventoryIndex: NativeAddonInventoryIndex | undefined;
  readonly bindingsRootCache: Map<string, string | null>;
  readonly nodeGypBuildCache: Map<string, readonly string[]>;
  readonly bindingsCache: Map<string, readonly string[]>;
  readonly findingCache: WeakMap<
    ElectronNativeAddonBindingFinding,
    Map<string, readonly string[]>
  >;
}

/** Build one request-local native-addon resolver shared by admission, graph, and summary. */
export const createElectronNativeAddonResolver = (
  input: ElectronNativeAddonResolverInput,
): ElectronNativeAddonResolver => {
  const state: NativeAddonResolverState = {
    input,
    inventoryIndex: undefined,
    bindingsRootCache: new Map(),
    nodeGypBuildCache: new Map(),
    bindingsCache: new Map(),
    findingCache: new WeakMap(),
  };

  return {
    resolve(file, finding) {
      let byPath = state.findingCache.get(finding);
      const cached = byPath?.get(file.path);
      if (cached !== undefined) return cached;
      let resolved: readonly string[];
      if (finding.resolution?.asar_unpacked === true) {
        resolved = resolveAsarUnpackedFinding(state, file.path, finding);
      } else if (finding.resolution === undefined) {
        resolved = resolveDirectSpecifierWithUnpackedFallback(
          state.input,
          file.path,
          finding,
        );
      } else if (finding.resolution.kind === "candidates") {
        resolved = resolveCandidatesWithUnpackedFallback(
          state.input,
          file.path,
          finding,
          finding.resolution,
        );
      } else {
        resolved = resolveHelperWithUnpackedFallback(
          state,
          file.path,
          finding.resolution,
        );
      }
      if (byPath === undefined) {
        byPath = new Map();
        state.findingCache.set(finding, byPath);
      }
      byPath.set(file.path, resolved);
      return resolved;
    },
  };
};

const addInventoryPathSegments = (
  childSegmentsByDir: Map<string, Set<string>>,
  path: string,
): void => {
  if (path === "" || path === ".") return;
  const addChildSegment = (dir: string, child: string): void => {
    let set = childSegmentsByDir.get(dir);
    if (set === undefined) {
      set = new Set();
      childSegmentsByDir.set(dir, set);
    }
    set.add(child);
  };
  const segments = path.split("/");
  if (segments[0] !== undefined && segments[0] !== "")
    addChildSegment(".", segments[0]);
  for (let index = 0; index < segments.length - 1; index += 1) {
    const child = segments[index + 1];
    if (child !== undefined && child !== "")
      addChildSegment(segments.slice(0, index + 1).join("/"), child);
  }
};

const ensureInventoryIndex = (
  state: NativeAddonResolverState,
): NativeAddonInventoryIndex => {
  if (state.inventoryIndex !== undefined) return state.inventoryIndex;
  const nativeAddonPaths: string[] = [];
  const childSegmentsByDir = new Map<string, Set<string>>();
  for (const [path, file] of state.input.files) {
    if (isNativeAddonFile(path, state.input.files, file))
      nativeAddonPaths.push(path);
    addInventoryPathSegments(childSegmentsByDir, path);
  }
  if (state.input.directoryPaths !== undefined) {
    for (const dirPath of state.input.directoryPaths)
      addInventoryPathSegments(childSegmentsByDir, dirPath);
  }
  nativeAddonPaths.sort(compareUnicodeCodePoints);
  state.inventoryIndex = { nativeAddonPaths, childSegmentsByDir };
  return state.inventoryIndex;
};

const hasBindingsRootMarker = (
  state: NativeAddonResolverState,
  directory: string,
): boolean => {
  const { childSegmentsByDir } = ensureInventoryIndex(state);
  const children = childSegmentsByDir.get(directory);
  if (
    children?.has("package.json") === true ||
    children?.has("node_modules") === true
  )
    return true;
  const unanalyzed = state.input.unanalyzedFiles;
  if (unanalyzed === undefined) return false;
  const packageJsonPath =
    directory === "." ? "package.json" : `${directory}/package.json`;
  const nodeModulesPath =
    directory === "." ? "node_modules" : `${directory}/node_modules`;
  return (
    unanalyzed.get(packageJsonPath) !== undefined ||
    unanalyzed.get(nodeModulesPath) !== undefined ||
    unanalyzed.hasDirectory(packageJsonPath, undefined) ||
    unanalyzed.hasDirectory(nodeModulesPath, undefined)
  );
};

const findBindingsModuleRoot = (
  state: NativeAddonResolverState,
  sourceDir: string,
): string | undefined => {
  const normalizedDir = sourceDir === "" ? "." : sourceDir;
  if (state.bindingsRootCache.has(normalizedDir))
    return state.bindingsRootCache.get(normalizedDir) ?? undefined;
  let current = normalizedDir;
  let resolved: string | null = null;
  while (true) {
    if (hasBindingsRootMarker(state, current)) {
      resolved = current;
      break;
    }
    if (state.input.unanalyzedFiles?.coverage.status === "unknown") break;
    const parent = posix.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  state.bindingsRootCache.set(normalizedDir, resolved);
  return resolved ?? undefined;
};

const resolveHelperSearchRoot = (
  state: NativeAddonResolverState,
  sourcePath: string,
  explicitDirectory: string | null,
): string | undefined => {
  const sourceDir = posix.dirname(sourcePath);
  if (explicitDirectory !== null) {
    const joined = normalizeJoinedLogicalPath(
      posix.join(sourceDir, explicitDirectory),
    );
    if (logicalPathEscapesRoot(joined)) return undefined;
    const stripped = joined.replace(/\/+$/u, "");
    return stripped === "" ? "." : stripped;
  }
  return findBindingsModuleRoot(state, sourceDir);
};

const scanNodeGypBuildTargets = (
  state: NativeAddonResolverState,
  root: string,
): readonly string[] => {
  const cached = state.nodeGypBuildCache.get(root);
  if (cached !== undefined) return cached;
  const prefix = root === "." ? "" : `${root}/`;
  const matched: string[] = [];
  for (const path of ensureInventoryIndex(state).nativeAddonPaths) {
    if (!isNativeAddonModuleTarget(path, state.input.files.get(path)?.kind))
      continue;
    if (!path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    const segments = rel.split("/");
    if (segments.includes("node_modules")) continue;
    const isPrebuild = segments.length === 3 && segments[0] === "prebuilds";
    const isGypBuild =
      segments.length === 3 &&
      segments[0] === "build" &&
      (segments[1] === "Release" || segments[1] === "Debug");
    if (isPrebuild || isGypBuild) matched.push(path);
  }
  state.nodeGypBuildCache.set(root, matched);
  return matched;
};

const scanBindingsTargets = (
  state: NativeAddonResolverState,
  root: string,
  addonName: string,
): readonly string[] => {
  const cacheKey = compositeKey([root, addonName]);
  const cached = state.bindingsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const prefix = root === "." ? "" : `${root}/`;
  const matched: string[] = [];
  for (const path of ensureInventoryIndex(state).nativeAddonPaths) {
    if (!isNativeAddonModuleTarget(path, state.input.files.get(path)?.kind))
      continue;
    if (!path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    const segments = rel.split("/");
    if (segments.includes("node_modules")) continue;
    if (segments.at(-1) !== addonName) continue;
    if (matchesBindingsSearchDirectory(segments.slice(0, -1)))
      matched.push(path);
  }
  state.bindingsCache.set(cacheKey, matched);
  return matched;
};

const resolveHelperWithUnpackedFallback = (
  state: NativeAddonResolverState,
  sourcePath: string,
  resolution: Extract<
    NonNullable<ElectronNativeAddonBindingFinding["resolution"]>,
    { readonly kind: "node-gyp-build" | "bindings" }
  >,
): readonly string[] => {
  const searchRoot =
    resolution.kind === "node-gyp-build"
      ? resolveHelperSearchRoot(state, sourcePath, resolution.directory)
      : resolveHelperSearchRoot(state, sourcePath, resolution.module_root);
  if (searchRoot === undefined) return [];
  const direct =
    resolution.kind === "node-gyp-build"
      ? scanNodeGypBuildTargets(state, searchRoot)
      : scanBindingsTargets(state, searchRoot, resolution.addon_name);
  if (direct.length > 0) return direct;
  const unpackedRoot = siblingAsarUnpackedDirectory(searchRoot);
  if (unpackedRoot === undefined) return [];
  return resolution.kind === "node-gyp-build"
    ? scanNodeGypBuildTargets(state, unpackedRoot)
    : scanBindingsTargets(state, unpackedRoot, resolution.addon_name);
};

const resolveDirectSpecifierWithUnpackedFallback = (
  input: ElectronNativeAddonResolverInput,
  sourcePath: string,
  finding: ElectronNativeAddonBindingFinding,
): readonly string[] => {
  const direct = resolveSinglePathOutcome(input, {
    declaredPath: finding.specifier,
    sourcePath,
    context: "module-specifier",
    moduleKind: finding.module_kind,
  });
  if (direct.kind === "native") return [direct.path];
  if (direct.kind !== "not-found") return [];
  const unpackedSourcePath = siblingAsarUnpackedSourcePath(sourcePath);
  if (unpackedSourcePath === undefined) return [];
  const fallback = resolveSinglePathOutcome(input, {
    declaredPath: finding.specifier,
    sourcePath: unpackedSourcePath,
    context: "module-specifier",
    moduleKind: finding.module_kind,
  });
  return fallback.kind === "native" ? [fallback.path] : [];
};

type CandidateNativeResolution = Extract<
  NonNullable<ElectronNativeAddonBindingFinding["resolution"]>,
  { readonly kind: "candidates" }
>;

const candidateRuntimePathKind = (
  resolution: CandidateNativeResolution,
): "exact-file" | "node-entrypoint" =>
  resolution.lookup === "exact-file" ||
  (resolution.lookup === undefined && resolution.loader === "dlopen")
    ? "exact-file"
    : "node-entrypoint";

const resolveCandidateSingleOutcome = (
  input: ElectronNativeAddonResolverInput,
  sourcePath: string,
  finding: ElectronNativeAddonBindingFinding,
  resolution: CandidateNativeResolution,
  candidate: string,
): SinglePathResolutionOutcome => {
  const baseSourcePath =
    resolution.resolution_context === "module-specifier" &&
    resolution.resolution_base_path !== undefined
      ? normalizeJoinedLogicalPath(
          posix.join(
            posix.dirname(sourcePath),
            resolution.resolution_base_path,
          ),
        )
      : sourcePath;
  if (logicalPathEscapesRoot(baseSourcePath)) return { kind: "non-native" };
  return resolution.resolution_context === "filesystem-expression"
    ? resolveSinglePathOutcome(input, {
        declaredPath: candidate,
        sourcePath: baseSourcePath,
        context: "filesystem-expression",
        moduleKind: finding.module_kind,
        runtimePathKind: candidateRuntimePathKind(resolution),
        ...(resolution.loader === undefined
          ? {}
          : { loader: resolution.loader }),
      })
    : resolveSinglePathOutcome(input, {
        declaredPath: candidate,
        sourcePath: baseSourcePath,
        context: "module-specifier",
        moduleKind: finding.module_kind,
        ...(resolution.loader === undefined
          ? {}
          : { loader: resolution.loader }),
      });
};

const resolveCandidatesWithUnpackedFallback = (
  input: ElectronNativeAddonResolverInput,
  sourcePath: string,
  finding: ElectronNativeAddonBindingFinding,
  resolution: CandidateNativeResolution,
): readonly string[] => {
  const unpackedSourcePath = siblingAsarUnpackedSourcePath(sourcePath);
  const matched: string[] = [];
  for (const candidate of resolution.candidates) {
    const direct = resolveCandidateSingleOutcome(
      input,
      sourcePath,
      finding,
      resolution,
      candidate,
    );
    if (direct.kind === "native") {
      matched.push(direct.path);
      continue;
    }
    if (direct.kind !== "not-found" || unpackedSourcePath === undefined)
      continue;
    const fallback = resolveCandidateSingleOutcome(
      input,
      unpackedSourcePath,
      finding,
      resolution,
      candidate,
    );
    if (fallback.kind === "native") matched.push(fallback.path);
  }
  return [...new Set(matched)].sort(compareUnicodeCodePoints);
};

const resolveCandidatePaths = (
  input: ElectronNativeAddonResolverInput,
  sourcePath: string,
  finding: ElectronNativeAddonBindingFinding,
  resolution: CandidateNativeResolution,
): readonly string[] => {
  const matched: string[] = [];
  for (const candidate of resolution.candidates) {
    const outcome = resolveCandidateSingleOutcome(
      input,
      sourcePath,
      finding,
      resolution,
      candidate,
    );
    if (outcome.kind === "native") matched.push(outcome.path);
  }
  return [...new Set(matched)].sort(compareUnicodeCodePoints);
};

const resolveAsarUnpackedFinding = (
  state: NativeAddonResolverState,
  sourcePath: string,
  finding: ElectronNativeAddonBindingFinding,
): readonly string[] => {
  const resolution = finding.resolution;
  if (resolution === undefined) return [];
  if (resolution.kind === "node-gyp-build") {
    const searchRoot = resolveRewrittenAnchoredDirectory(
      sourcePath,
      resolution.directory,
      resolution.asar_unpacked_scope,
      resolution.asar_unpacked_replace_all,
    );
    return searchRoot === undefined
      ? []
      : scanNodeGypBuildTargets(state, searchRoot);
  }
  if (resolution.kind === "bindings") {
    if (resolution.module_root !== null) {
      const searchRoot = resolveRewrittenAnchoredDirectory(
        sourcePath,
        resolution.module_root,
        resolution.asar_unpacked_scope,
        resolution.asar_unpacked_replace_all,
      );
      return searchRoot === undefined
        ? []
        : scanBindingsTargets(state, searchRoot, resolution.addon_name);
    }
    const rewrittenDir = resolveRewrittenAnchoredDirectory(
      sourcePath,
      ".",
      resolution.asar_unpacked_scope,
      resolution.asar_unpacked_replace_all,
    );
    if (rewrittenDir === undefined) return [];
    const searchRoot = findBindingsModuleRoot(state, rewrittenDir);
    return searchRoot === undefined
      ? []
      : scanBindingsTargets(state, searchRoot, resolution.addon_name);
  }
  if (resolution.resolution_context === "filesystem-expression") {
    const sourceDir = posix.dirname(sourcePath);
    const matched = resolution.candidates.flatMap((candidate) => {
      const rewrittenPath = resolveRewrittenAnchoredPath(
        sourcePath,
        candidate,
        resolution.asar_unpacked_scope,
        resolution.asar_unpacked_replace_all,
      );
      if (rewrittenPath === undefined || rewrittenPath === ".") return [];
      const relativeRaw = posix.relative(sourceDir, rewrittenPath);
      const relativeToSource =
        rewrittenPath.endsWith("/") &&
        relativeRaw !== "" &&
        !relativeRaw.endsWith("/")
          ? `${relativeRaw}/`
          : relativeRaw === "" && rewrittenPath.endsWith("/")
            ? "./"
            : relativeRaw;
      const declaredPath = relativeToSource.startsWith(".")
        ? relativeToSource
        : `./${relativeToSource}`;
      const resolved = resolveSinglePath(state.input, {
        declaredPath,
        sourcePath,
        context: "filesystem-expression",
        moduleKind: finding.module_kind,
        runtimePathKind: candidateRuntimePathKind(resolution),
        ...(resolution.loader === undefined
          ? {}
          : { loader: resolution.loader }),
      });
      return resolved === undefined ? [] : [resolved];
    });
    return [...new Set(matched)].sort(compareUnicodeCodePoints);
  }
  const rewrittenSourcePath =
    rewriteAppAsarSourcePath(
      sourcePath,
      resolution.asar_unpacked_replace_all,
    ) ?? sourcePath;
  return resolveCandidatePaths(
    state.input,
    rewrittenSourcePath,
    finding,
    resolution,
  );
};

const resolveRewrittenAnchoredPath = (
  sourcePath: string,
  targetRelPath: string,
  scope: ElectronAsarUnpackedRewriteScope | undefined,
  replaceAll = false,
): string | undefined => {
  const sourceDir = posix.dirname(sourcePath);
  if (scope === undefined) {
    const joined = normalizeJoinedLogicalPath(
      posix.join(sourceDir, targetRelPath),
    );
    if (logicalPathEscapesRoot(joined)) return undefined;
    const normalized = joined === "" ? "." : joined;
    return replaceAll
      ? normalized.replaceAll("app.asar", "app.asar.unpacked")
      : normalized.replace("app.asar", "app.asar.unpacked");
  }
  const prefixJoined = normalizeJoinedLogicalPath(
    posix.join(sourceDir, scope.directory),
  );
  if (logicalPathEscapesRoot(prefixJoined)) return undefined;
  const prefixNormalized = prefixJoined === "" ? "." : prefixJoined;
  const rewrittenPrefix =
    scope.replace_all === true
      ? prefixNormalized.replaceAll("app.asar", "app.asar.unpacked")
      : prefixNormalized.replace("app.asar", "app.asar.unpacked");
  const finalJoined = normalizeJoinedLogicalPath(
    posix.join(rewrittenPrefix, targetRelPath),
  );
  if (logicalPathEscapesRoot(finalJoined)) return undefined;
  return finalJoined === "" ? "." : finalJoined;
};

const resolveRewrittenAnchoredDirectory = (
  sourcePath: string,
  targetRelPath: string,
  scope: ElectronAsarUnpackedRewriteScope | undefined,
  replaceAll = false,
): string | undefined => {
  const rewritten = resolveRewrittenAnchoredPath(
    sourcePath,
    targetRelPath,
    scope,
    replaceAll,
  );
  if (rewritten === undefined) return undefined;
  const stripped = rewritten.replace(/\/+$/u, "");
  return stripped === "" ? "." : stripped;
};

type SinglePathResolutionOutcome =
  | { readonly kind: "native"; readonly path: string }
  | { readonly kind: "non-native" }
  | { readonly kind: "not-found" };

const resolveSinglePathOutcome = (
  input: ElectronNativeAddonResolverInput,
  options: {
    readonly declaredPath: string;
    readonly sourcePath: string;
    readonly context: "module-specifier" | "filesystem-expression";
    readonly moduleKind?: "import" | "require";
    readonly runtimePathKind?: "exact-file" | "node-entrypoint";
    readonly loader?: "dlopen";
  },
): SinglePathResolutionOutcome => {
  const resolution = resolveArtifactPathByContext({
    declaredPath: options.declaredPath,
    sourcePath: options.sourcePath,
    context: options.context,
    files: input.files,
    jsonDocuments: input.jsonDocuments,
    ...(input.directoryPaths === undefined
      ? {}
      : { directoryPaths: input.directoryPaths }),
    ...(input.unanalyzedFiles === undefined
      ? {}
      : { unanalyzedFiles: input.unanalyzedFiles }),
    ...(options.moduleKind === undefined
      ? {}
      : { moduleKind: options.moduleKind }),
    ...(options.runtimePathKind === undefined
      ? {}
      : { runtimePathKind: options.runtimePathKind }),
  });
  if (resolution.resolution_status === "resolved") {
    const validTarget =
      options.loader === "dlopen"
        ? isNativeAddonFile(resolution.resolved_path, input.files)
        : isNativeAddonModuleTarget(
            resolution.resolved_path,
            input.files.get(resolution.resolved_path)?.kind,
          );
    return validTarget
      ? { kind: "native", path: resolution.resolved_path }
      : { kind: "non-native" };
  }
  return resolution.resolution_status === "not-found"
    ? { kind: "not-found" }
    : { kind: "non-native" };
};

const resolveSinglePath = (
  input: ElectronNativeAddonResolverInput,
  options: {
    readonly declaredPath: string;
    readonly sourcePath: string;
    readonly context: "module-specifier" | "filesystem-expression";
    readonly moduleKind?: "import" | "require";
    readonly runtimePathKind?: "exact-file" | "node-entrypoint";
    readonly loader?: "dlopen";
  },
): string | undefined => {
  const outcome = resolveSinglePathOutcome(input, options);
  return outcome.kind === "native" ? outcome.path : undefined;
};

const matchesBindingsSearchDirectory = (
  dirSegments: readonly string[],
): boolean => {
  if (dirSegments.length === 0) return false;
  if (dirSegments.length === 1)
    return (
      dirSegments[0] === "build" ||
      dirSegments[0] === "Release" ||
      dirSegments[0] === "Debug"
    );
  if (dirSegments.length === 2) {
    const [first, second] = dirSegments;
    return (
      ((first === "build" || first === "out") &&
        (second === "Release" || second === "Debug")) ||
      (first === "build" && second === "default")
    );
  }
  if (dirSegments.length === 3) {
    const [first, second, third] = dirSegments;
    return (
      (first === "lib" && second === "binding") ||
      (first === "addon-build" &&
        (second === "release" || second === "debug" || second === "default") &&
        third === "install-root")
    );
  }
  return dirSegments.length === 4 && dirSegments[0] === "compiled";
};

const isNativeAddonFile = (
  path: string,
  files: ReadonlyMap<string, JavaScriptArtifactFile>,
  file: JavaScriptArtifactFile | undefined = files.get(path),
): boolean =>
  file?.kind === "native-addon" && path.toLowerCase().endsWith(".node");

const rewriteAppAsarSourcePath = (
  sourcePath: string,
  replaceAll = false,
): string | undefined => {
  const segments = sourcePath.split("/");
  let changed = false;
  const copy = [...segments];
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] === "app.asar") {
      copy[index] = "app.asar.unpacked";
      changed = true;
      if (!replaceAll) break;
    }
  }
  return changed ? copy.join("/") : undefined;
};

const siblingAsarUnpackedDirectory = (
  directoryPath: string,
): string | undefined => {
  if (directoryPath === "" || directoryPath === ".") return undefined;
  const segments = directoryPath.split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    if (
      segment.toLowerCase().endsWith(".asar") &&
      !segment.toLowerCase().endsWith(".asar.unpacked")
    ) {
      const copy = [...segments];
      copy[index] = `${segment}.unpacked`;
      return copy.join("/");
    }
  }
  return undefined;
};

const siblingAsarUnpackedSourcePath = (
  sourcePath: string,
): string | undefined => {
  const segments = sourcePath.split("/");
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const segment = segments[index]!;
    if (
      segment.toLowerCase().endsWith(".asar") &&
      !segment.toLowerCase().endsWith(".asar.unpacked")
    ) {
      const copy = [...segments];
      copy[index] = `${segment}.unpacked`;
      return copy.join("/");
    }
  }
  return undefined;
};
