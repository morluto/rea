import { parse } from "@babel/parser";
import { traverseFast } from "@babel/types";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PURE_LAYERS = new Set(["domain", "contracts"]);
const MIGRATED_PROVIDER_ROOTS = new Set([
  "evm",
  "android",
  "firmware",
  "ghidra",
  "hopper",
  "ida",
  "inspector",
  "javascript",
]);
const PROVIDER_ROOTS = new Set([
  ...MIGRATED_PROVIDER_ROOTS,
  "artifacts",
  "browser",
  "dotnet",
  "native",
]);

const repositoryPath = (root, path) =>
  relative(root, path).replaceAll("\\", "/");

const literalValue = (node) => {
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
};

const importSpecifier = (node) => {
  switch (node.type) {
    case "ImportDeclaration":
    case "ExportNamedDeclaration":
    case "ExportAllDeclaration":
    case "ImportExpression":
    case "TSImportType":
      return literalValue(node.source);
    case "TSImportEqualsDeclaration":
      return node.moduleReference.type === "TSExternalModuleReference"
        ? literalValue(node.moduleReference.expression)
        : undefined;
    default:
      return undefined;
  }
};

const sourceTarget = (file, specifier) => {
  if (specifier.startsWith("file:")) return fileURLToPath(specifier);
  if (isAbsolute(specifier)) return resolve(specifier);
  return specifier.startsWith(".")
    ? fileURLToPath(new URL(specifier, pathToFileURL(file)))
    : undefined;
};

const failedBoundary = (file, target) => {
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
  if (
    PROVIDER_ROOTS.has(layer) &&
    /^src\/generatedMcpToolCatalog\.(?:js|ts)$/u.test(target)
  )
    return "provider-generated-catalog";
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
  const tree = parse(source, {
    sourceType: "module",
    plugins: ["typescript"],
  });
  const violations = [];
  traverseFast(tree, (node) => {
    const specifier = importSpecifier(node);
    if (specifier === undefined) return;
    const resolved = sourceTarget(absoluteFile, specifier);
    if (resolved === undefined) return;
    const target = repositoryPath(root, resolved);
    const boundary = failedBoundary(importer, target);
    if (boundary !== undefined)
      violations.push({
        file: importer,
        line: node.loc?.start.line ?? 1,
        specifier,
        target,
        boundary,
      });
  });
  return violations;
};
