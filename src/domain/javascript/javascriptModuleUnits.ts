import type { ApplicationNode } from "./javascriptApplicationGraphSchemas.js";

/** Export declarations retain graph identity but are not independently loaded modules. */
export const isJavaScriptModuleUnit = (
  node: ApplicationNode,
): node is ApplicationNode & {
  readonly kind: "javascript-asset" | "javascript-module" | "source-module";
} =>
  (node.kind === "javascript-asset" ||
    node.kind === "javascript-module" ||
    node.kind === "source-module") &&
  !node.observations.some(
    ({ properties }) => properties.semantic_role === "export-binding",
  );

/** Historical source units can retain the javascript-module graph kind. */
export const isJavaScriptSourceModule = (node: ApplicationNode): boolean =>
  node.kind === "source-module" ||
  node.observations.some(
    ({ properties }) => properties.semantic_role === "source-module",
  );
