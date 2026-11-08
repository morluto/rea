import { posix } from "node:path";

import {
  logicalPathEscapesRoot,
  normalizeJoinedLogicalPath,
} from "../../domain/artifactIdentity.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";
import type { ElectronNativeAddonBindingFinding } from "../../domain/javascript/electronStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import type { JavaScriptJsonDocuments } from "./JavaScriptJsonDocuments.js";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";

export interface ResolveElectronNativeAddonInput {
  readonly file: JavaScriptArtifactFile;
  readonly finding: ElectronNativeAddonBindingFinding;
  readonly files: ReadonlyMap<string, JavaScriptArtifactFile>;
  readonly jsonDocuments: JavaScriptJsonDocuments;
  readonly directoryPaths?: ReadonlySet<string> | undefined;
}

/** Resolve all inventoried `.node` addon artifacts targeted by one binding. */
export const resolveElectronNativeAddonPaths = (
  input: ResolveElectronNativeAddonInput,
): readonly string[] => {
  const direct = resolveFromSourcePath(input, input.file.path);
  if (direct.length > 0) return direct;
  const unpackedSourcePath = siblingAsarUnpackedSourcePath(input.file.path);
  return unpackedSourcePath === undefined
    ? []
    : resolveFromSourcePath(input, unpackedSourcePath);
};

const resolveFromSourcePath = (
  input: ResolveElectronNativeAddonInput,
  sourcePath: string,
): readonly string[] => {
  const { finding, files } = input;
  const resolution = finding.resolution;
  if (resolution === undefined) {
    const resolved = resolveSinglePath(input, {
      declaredPath: finding.specifier,
      sourcePath,
      context: "module-specifier",
      moduleKind: finding.module_kind,
    });
    return resolved === undefined ? [] : [resolved];
  }
  if (resolution.kind === "candidates") {
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
    if (logicalPathEscapesRoot(baseSourcePath)) return [];
    const matched = resolution.candidates.flatMap((candidate) => {
      const resolved =
        resolution.resolution_context === "filesystem-expression"
          ? resolveSinglePath(input, {
              declaredPath: candidate,
              sourcePath: baseSourcePath,
              context: "filesystem-expression",
              runtimePathKind: "exact-file",
            })
          : resolveSinglePath(input, {
              declaredPath: candidate,
              sourcePath: baseSourcePath,
              context: "module-specifier",
              moduleKind: finding.module_kind,
            });
      return resolved === undefined ? [] : [resolved];
    });
    return [...new Set(matched)].sort(compareUnicodeCodePoints);
  }
  if (resolution.kind === "node-gyp-build") {
    const searchRoot = resolveHelperSearchRoot(
      sourcePath,
      resolution.directory,
      files,
      ["prebuilds", "build"],
    );
    return searchRoot === undefined
      ? []
      : scanNodeGypBuildTargets(searchRoot, files);
  }
  const searchRoot = resolveHelperSearchRoot(
    sourcePath,
    resolution.module_root,
    files,
    ["build", "out", "Release", "Debug", "compiled", "addon-build", "lib"],
  );
  return searchRoot === undefined
    ? []
    : scanBindingsTargets(searchRoot, resolution.addon_name, files);
};

const resolveSinglePath = (
  input: ResolveElectronNativeAddonInput,
  options: {
    readonly declaredPath: string;
    readonly sourcePath: string;
    readonly context: "module-specifier" | "filesystem-expression";
    readonly moduleKind?: "import" | "require";
    readonly runtimePathKind?: "exact-file";
  },
): string | undefined => {
  const resolved = resolveArtifactPathByContext({
    declaredPath: options.declaredPath,
    sourcePath: options.sourcePath,
    context: options.context,
    files: input.files,
    jsonDocuments: input.jsonDocuments,
    ...(input.directoryPaths === undefined
      ? {}
      : { directoryPaths: input.directoryPaths }),
    ...(options.moduleKind === undefined
      ? {}
      : { moduleKind: options.moduleKind }),
    ...(options.runtimePathKind === undefined
      ? {}
      : { runtimePathKind: options.runtimePathKind }),
  }).resolved_path;
  return resolved !== null && isNativeAddonFile(resolved, input.files)
    ? resolved
    : undefined;
};

const resolveHelperSearchRoot = (
  sourcePath: string,
  explicitDirectory: string | null,
  files: ReadonlyMap<string, JavaScriptArtifactFile>,
  fallbackMarkerDirs: readonly string[],
): string | undefined => {
  const sourceDir = posix.dirname(sourcePath);
  if (explicitDirectory !== null) {
    const joined = normalizeJoinedLogicalPath(
      posix.join(sourceDir, explicitDirectory),
    );
    if (logicalPathEscapesRoot(joined)) return undefined;
    return joined === "" ? "." : joined;
  }
  return findEnclosingPackageRoot(sourceDir, files, fallbackMarkerDirs);
};

const findEnclosingPackageRoot = (
  sourceDir: string,
  files: ReadonlyMap<string, JavaScriptArtifactFile>,
  fallbackMarkerDirs: readonly string[],
): string => {
  let current = sourceDir === "" ? "." : sourceDir;
  const ancestors: string[] = [];
  while (true) {
    ancestors.push(current);
    const packageJson =
      current === "." ? "package.json" : `${current}/package.json`;
    if (files.has(packageJson) || isNodeModulesPackageBoundary(current))
      return current;
    if (isArchiveContainerBoundary(current)) break;
    const parent = posix.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const ancestor of ancestors) {
    const prefix = ancestor === "." ? "" : `${ancestor}/`;
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const remainder = path.slice(prefix.length);
      const firstSegment = remainder.split("/", 1)[0] ?? "";
      if (fallbackMarkerDirs.includes(firstSegment)) return ancestor;
    }
  }
  return sourceDir === "" ? "." : sourceDir;
};

const isNodeModulesPackageBoundary = (directory: string): boolean => {
  if (directory === ".") return false;
  const segments = directory.split("/");
  const last = segments.at(-1) ?? "";
  const prev = segments.at(-2) ?? "";
  const prevPrev = segments.at(-3) ?? "";
  return (
    (prev === "node_modules" && !last.startsWith("@")) ||
    (prevPrev === "node_modules" && prev.startsWith("@"))
  );
};

const isArchiveContainerBoundary = (directory: string): boolean => {
  const base = posix.basename(directory).toLowerCase();
  return base.endsWith(".asar") || base.endsWith(".asar.unpacked");
};

const scanNodeGypBuildTargets = (
  root: string,
  files: ReadonlyMap<string, JavaScriptArtifactFile>,
): readonly string[] => {
  const prefix = root === "." ? "" : `${root}/`;
  const matched: string[] = [];
  for (const [path, file] of files) {
    if (!isNativeAddonFile(path, files, file)) continue;
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
  return matched.sort(compareUnicodeCodePoints);
};

const scanBindingsTargets = (
  root: string,
  addonName: string,
  files: ReadonlyMap<string, JavaScriptArtifactFile>,
): readonly string[] => {
  const prefix = root === "." ? "" : `${root}/`;
  const matched: string[] = [];
  for (const [path, file] of files) {
    if (!isNativeAddonFile(path, files, file)) continue;
    if (!path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    const segments = rel.split("/");
    if (segments.includes("node_modules")) continue;
    if (segments.at(-1) !== addonName) continue;
    if (matchesBindingsSearchDirectory(segments.slice(0, -1)))
      matched.push(path);
  }
  return matched.sort(compareUnicodeCodePoints);
};

const matchesBindingsSearchDirectory = (
  dirSegments: readonly string[],
): boolean => {
  if (dirSegments.length === 0) return true;
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
      (first === "build" && second === "default") ||
      (first === "lib" && second === "binding")
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
