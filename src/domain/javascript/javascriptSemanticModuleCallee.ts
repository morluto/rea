import type { JavaScriptSemanticIr } from "./javascriptSemanticIr.js";
import { UNKNOWN_REQUIRE_LOADER_REASON } from "./javascriptSemanticProvenance.js";

/** A call whose callee is a static member chain rooted in one module import. */
export interface JavaScriptModuleCallee {
  readonly specifier: string;
  readonly path: readonly string[];
  /** CommonJS `require` whose loader is not established from source alone. */
  readonly loader_authority?: "candidate";
  /** The module reached the binding through a helper whose effect is unchecked. */
  readonly wrapper?: "unverified";
}

/** A default import of a CommonJS host module names the module itself. */
const withoutDefault = (path: readonly string[]): readonly string[] =>
  path[0] === "default" ? path.slice(1) : path;

/**
 * Module-rooted callees by call site ID, from the call's recorded access path
 * and its root binding's single module origin. A reassigned binding, several
 * origins or an unrooted callee are omitted.
 */
export const semanticModuleCallees = (
  ir: Pick<JavaScriptSemanticIr, "bindings" | "callSites">,
): ReadonlyMap<string, JavaScriptModuleCallee> => {
  const bindings = new Map(
    ir.bindings.map((binding) => [binding.bindingId, binding]),
  );
  const callees = new Map<string, JavaScriptModuleCallee>();
  for (const { callSiteId, calleeAccess } of ir.callSites) {
    if (calleeAccess === undefined) continue;
    const { wrappedSpecifier, path } = calleeAccess;
    if (wrappedSpecifier !== undefined) {
      callees.set(callSiteId, {
        specifier: wrappedSpecifier,
        path: withoutDefault(path),
        loader_authority: "candidate",
        wrapper: "unverified",
      });
      continue;
    }
    const binding = bindings.get(calleeAccess.bindingId);
    if (binding === undefined) continue;
    const { provenance, definitions } = binding;
    const [origin, ...others] = provenance.origins;
    if (origin === undefined || others.length > 0) continue;
    const candidate = origin.loaderAuthority === "candidate";
    // Other ambiguity reasons concern the value itself, not only its loader.
    if (
      provenance.status !== "module" &&
      provenance.reason !== UNKNOWN_REQUIRE_LOADER_REASON
    )
      continue;
    if (definitions.some(({ kind }) => kind === "assignment")) continue;
    callees.set(callSiteId, {
      specifier: origin.specifier,
      path: withoutDefault([...origin.importedPath, ...path]),
      ...(candidate ? { loader_authority: "candidate" as const } : {}),
    });
  }
  return callees;
};
