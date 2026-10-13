import { posix } from "node:path";

/** Loader evidence retained for a source-level module reference. */
export type JavaScriptModuleResolutionMode =
  | "import"
  | "require"
  | "compiler-dependent";

/** Derive source mode only when syntax or an explicit source format owns it. */
export const moduleResolutionModeForJavaScriptReference = (
  sourcePath: string,
  referenceKind: "static-import" | "dynamic-import" | "require",
  explicitMode?: JavaScriptModuleResolutionMode,
): JavaScriptModuleResolutionMode => {
  if (explicitMode !== undefined) return explicitMode;
  if (referenceKind === "require") return "require";
  if (referenceKind === "dynamic-import") return "import";
  const extension = posix.extname(sourcePath).toLowerCase();
  if (extension === ".cts") return "require";
  if (extension === ".mts") return "import";
  if (extension === ".ts" || extension === ".tsx") return "compiler-dependent";
  return "import";
};
