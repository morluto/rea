import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readImportSpecifiers } from "./import-specifiers.mjs";

const PURE_LAYERS = new Set(["domain", "contracts"]);
const MIGRATED_PROVIDER_ROOTS = new Set([
  "sqlite",
  "evm",
  "go",
  "il2cpp",
  "model",
  "gpu",
  "python",
  "rust",
  "wasm",
  "captures",
  "signals",
  "android",
  "binaryNinja",
  "firmware",
  "ghidra",
  "hopper",
  "ida",
  "inspector",
  "javascript",
]);
const CENTRALIZED_CONSTRUCTOR_OWNER =
  /^src\/(?:frida\/FridaInstrumentationManager|cutter\/CutterBridge(?:Client|Service)|gdb\/GdbSessionManager|rizin\/RizinDebugSessionManager)\.(?:js|ts)$/u;
const repositoryPath = (root, path) =>
  relative(root, path).replaceAll("\\", "/");

const packageImports = new Map();

/** Read the package map once per repository root. */
const readPackageImports = (root) => {
  if (!packageImports.has(root)) {
    try {
      const manifest = JSON.parse(
        readFileSync(resolve(root, "package.json"), "utf8"),
      );
      packageImports.set(root, manifest.imports ?? {});
    } catch (cause) {
      throw new Error(
        `Cannot read package imports from ${resolve(root, "package.json")}: ${cause.message}`,
        { cause },
      );
    }
  }
  return packageImports.get(root);
};

/**
 * The own source file a package-map specifier names.
 *
 * The map points at built output under `dist/`, so the same ownership rule is
 * applied to the source file that produces it. Without this the gate silently
 * accepts every `#`-prefixed import, which is the spelling the package map exists
 * to encourage.
 */
const packageMapTarget = (root, specifier) => {
  const target = readPackageImports(root)[specifier];
  if (typeof target !== "string")
    throw new Error(
      `Cannot resolve package import ${JSON.stringify(specifier)}: this boundary check supports exact string mappings only; use a relative source import for conditional, array, pattern, or undeclared mappings.`,
    );
  const source = target.startsWith("./")
    ? repositoryPath(
        root,
        fileURLToPath(
          new URL(target, pathToFileURL(resolve(root, "package.json"))),
        ),
      )
        .replace(/^dist\//u, "src/")
        .replace(/\.(?:js|mjs|cjs)$/u, ".ts")
    : undefined;
  if (source === undefined || !source.startsWith("src/"))
    throw new Error(
      `Cannot resolve package import ${JSON.stringify(specifier)} to a source owner from ${JSON.stringify(target)}; use a relative source import for this boundary check.`,
    );
  return resolve(root, source);
};

const sourceTarget = (root, file, specifier) => {
  if (specifier.startsWith("file:")) return fileURLToPath(specifier);
  if (specifier.startsWith("#")) return packageMapTarget(root, specifier);
  if (isAbsolute(specifier)) return resolve(specifier);
  return specifier.startsWith(".")
    ? fileURLToPath(new URL(specifier, pathToFileURL(file)))
    : undefined;
};

const failedBoundary = (file, target, typeOnly) => {
  if (!file.startsWith("src/") || !target.startsWith("src/")) return undefined;
  const layer = file.split("/")[1];
  const targetLayer = target.split("/")[1];
  if (
    file.startsWith("src/process/capture/") &&
    (["application", "composition", "server", "cli", "main"].includes(
      targetLayer,
    ) ||
      /^src\/(?:cli|main)\./u.test(target))
  )
    return "process-capture";
  if (
    file.startsWith("src/application/javascript/") &&
    /^src\/artifacts\/(?:Asar|Directory)ArtifactReader\.(?:js|ts)$/u.test(
      target,
    )
  )
    return "provider-construction";
  if (
    (file.startsWith("src/artifacts/javascript/") ||
      file.startsWith("src/artifacts/apple/") ||
      file.startsWith("src/artifacts/inventory/") ||
      file.startsWith("src/artifacts/extraction/") ||
      /^src\/artifacts\/ArtifactHash\.(?:js|ts)$/u.test(file)) &&
    (["application", "composition", "server", "cli", "main"].includes(
      targetLayer,
    ) ||
      /^src\/(?:cli|main)\./u.test(target))
  )
    return "artifact-acquisition";
  if (PURE_LAYERS.has(layer)) {
    if (
      (/^src\/[^/]+\//u.test(target) && !PURE_LAYERS.has(targetLayer)) ||
      /^src\/(?:cli|main)\./u.test(target)
    )
      return "pure-layer";
  }
  if (layer === "application" && targetLayer === "composition")
    return "application-composition";
  if (
    (layer === "application" || layer === "server") &&
    !typeOnly &&
    CENTRALIZED_CONSTRUCTOR_OWNER.test(target)
  )
    return "provider-construction";
  if (
    (layer === "application" || layer === "server") &&
    (MIGRATED_PROVIDER_ROOTS.has(targetLayer) ||
      /^src\/(?:artifacts\/ArtifactProvider|dotnet\/ManagedStaticProvider|native\/NativeMacOSProvider)\.[^/]+$/u.test(
        target,
      ) ||
      /^src\/browser\/[^/]*Provider\.[^/]+$/u.test(target))
  )
    return "provider-construction";
  return undefined;
};

/** Check resolved source ownership, including type imports and reexports. */
export const inspectModuleBoundaries = (file, source, root) => {
  const absoluteFile = resolve(root, file);
  const importer = repositoryPath(root, absoluteFile);
  const violations = [];
  for (const { specifier, line, typeOnly } of readImportSpecifiers(source)) {
    const resolved = sourceTarget(root, absoluteFile, specifier);
    if (resolved === undefined) continue;
    const target = repositoryPath(root, resolved);
    const boundary = failedBoundary(importer, target, typeOnly);
    if (boundary !== undefined)
      violations.push({ file: importer, line, specifier, target, boundary });
  }
  return violations;
};
