import type {
  JavaScriptModuleOrigin,
  JavaScriptSemanticIr,
  JavaScriptSemanticModuleLink,
} from "./javascriptSemanticIr.js";

/** Module facts needed after file-local semantic projection has finished. */
export type JavaScriptModuleSemanticIr = Pick<
  JavaScriptSemanticIr,
  | "scopes"
  | "bindings"
  | "callables"
  | "moduleLinks"
  | "coverage"
  | "limitations"
>;

/** Retain facts consumed by source-module and export-return composition. */
export const projectJavaScriptModuleSemantics = (
  ir: JavaScriptSemanticIr,
): JavaScriptModuleSemanticIr => {
  const scopes = ir.scopes.filter(({ kind }) => kind === "program");
  const programScopeId = scopes[0]?.scopeId;
  const localNames = new Set(ir.moduleLinks.map(({ localName }) => localName));
  const callableIds = new Set(
    ir.moduleLinks.map(({ callableId }) => callableId),
  );
  return {
    scopes,
    bindings: ir.bindings.filter(
      ({ name, scopeId }) => scopeId === programScopeId && localNames.has(name),
    ),
    callables: ir.callables.filter(({ callableId }) =>
      callableIds.has(callableId),
    ),
    moduleLinks: ir.moduleLinks,
    coverage: ir.coverage,
    limitations: ir.limitations,
  };
};

/** Links that expose a binding of their module. */
export const isJavaScriptExportLink = (
  link: JavaScriptSemanticModuleLink,
): boolean =>
  link.kind === "export" ||
  link.kind === "re-export" ||
  link.kind === "commonjs-export";

/** The module an export re-exposes, directly or through one module-bound local. */
export const javaScriptExportModuleOrigin = (
  ir: Pick<JavaScriptModuleSemanticIr, "scopes" | "bindings">,
  link: JavaScriptSemanticModuleLink,
): JavaScriptModuleOrigin | null => {
  if (link.specifier !== null)
    return {
      ...(link.resolutionMode === undefined
        ? {}
        : { resolutionMode: link.resolutionMode }),
      specifier: link.specifier,
      importedPath: link.importedName === null ? [] : [link.importedName],
    };
  if (link.localName === null) return null;
  const program = ir.scopes.find(({ kind }) => kind === "program");
  const binding = ir.bindings.find(
    ({ name, scopeId }) =>
      name === link.localName && scopeId === program?.scopeId,
  );
  return binding?.provenance.status === "module" &&
    binding.provenance.origins.length === 1
    ? (binding.provenance.origins[0] ?? null)
    : null;
};
