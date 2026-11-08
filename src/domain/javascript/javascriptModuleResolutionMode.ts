import { posix } from "node:path";
import type { JavaScriptArtifactFileKind } from "./javascriptArtifactFiles.js";

/** JSON dispatch uses the exact loader filename, not the inventory's folded kind. */
export const isJsonModuleTarget = (
  path: string,
  kind: JavaScriptArtifactFileKind | undefined,
): boolean =>
  path.endsWith(".json") && (kind === "json" || kind === "package-json");

/** Native-addon dispatch likewise needs the exact `.node` loader suffix. */
export const isNativeAddonModuleTarget = (
  path: string,
  kind: JavaScriptArtifactFileKind | undefined,
): boolean => path.endsWith(".node") && kind === "native-addon";

/** Exact loader suffixes are separate from case-folded artifact grammar. */
export const explicitJavaScriptLoaderMode = (
  path?: string,
): "module" | "commonjs" | undefined => {
  switch (path?.slice(-4)) {
    case ".mjs":
    case ".mts":
      return "module";
    case ".cjs":
    case ".cts":
      return "commonjs";
    default:
      return undefined;
  }
};

/** Case variants are artifact syntax hints, not recognized loader suffixes. */
export const hasCaseVariantJavaScriptLoaderSuffix = (
  path?: string,
): boolean => {
  if (path === undefined) return false;
  const suffix = /\.(?:js|ts|mjs|cjs|mts|cts)$/iu.exec(path)?.[0];
  return suffix !== undefined && suffix !== suffix.toLowerCase();
};

/** Loader evidence retained for a source-level module reference. */
export type JavaScriptModuleResolutionMode =
  "import" | "require" | "compiler-dependent";

/** Derive source mode only when syntax or an explicit source format owns it. */
export const moduleResolutionModeForJavaScriptReference = (
  sourcePath: string,
  referenceKind: "static-import" | "dynamic-import" | "require",
  explicitMode?: JavaScriptModuleResolutionMode,
): JavaScriptModuleResolutionMode => {
  if (explicitMode !== undefined) return explicitMode;
  if (referenceKind === "require") return "require";
  if (referenceKind === "dynamic-import") return "import";
  const loaderMode = explicitJavaScriptLoaderMode(sourcePath);
  if (loaderMode !== undefined)
    return loaderMode === "commonjs" ? "require" : "import";
  const extension = posix.extname(sourcePath).toLowerCase();
  if (extension === ".ts" || extension === ".tsx") return "compiler-dependent";
  return "import";
};
