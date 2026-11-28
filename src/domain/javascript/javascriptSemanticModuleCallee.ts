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

type SemanticBinding = JavaScriptSemanticIr["bindings"][number];

/**
 * Whether the file writes the called member or an object containing it, through
 * the same binding or another binding of the same module.
 */
const replacedMembers = (
  ir: Pick<JavaScriptSemanticIr, "objectOperations">,
  bindings: ReadonlyMap<string, SemanticBinding>,
) => {
  const written = new Set<string>();
  for (const { kind, objectBindingId, propertyPath } of ir.objectOperations) {
    if (kind !== "write" || objectBindingId === null || propertyPath === null)
      continue;
    written.add(JSON.stringify([objectBindingId, ...propertyPath]));
    for (const origin of bindings.get(objectBindingId)?.provenance.origins ??
      [])
      written.add(
        JSON.stringify([
          origin.specifier,
          ...withoutDefault([...origin.importedPath, ...propertyPath]),
        ]),
      );
  }
  return (root: string, path: readonly string[]): boolean =>
    path.some((_, end) =>
      written.has(JSON.stringify([root, ...path.slice(0, end + 1)])),
    );
};

/**
 * Module-rooted callees by call site ID, from the call's recorded access path
 * and its root binding's single module origin. A reassigned binding, several
 * origins or an unrooted callee are omitted.
 */
export const semanticModuleCallees = (
  ir: Pick<JavaScriptSemanticIr, "bindings" | "callSites" | "objectOperations">,
): ReadonlyMap<string, JavaScriptModuleCallee> => {
  const bindings = new Map(
    ir.bindings.map((binding) => [binding.bindingId, binding]),
  );
  const replaced = replacedMembers(ir, bindings);
  const callees = new Map<string, JavaScriptModuleCallee>();
  for (const { callSiteId, calleeAccess } of ir.callSites) {
    if (calleeAccess === undefined) continue;
    const { wrappedSpecifier, path } = calleeAccess;
    if (wrappedSpecifier !== undefined) {
      if (replaced(calleeAccess.bindingId, path)) continue;
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
    // Only the import itself supplies a `default` to drop; one written in the
    // source is a real member access.
    const member = [...withoutDefault(origin.importedPath), ...path];
    if (
      replaced(calleeAccess.bindingId, path) ||
      replaced(origin.specifier, member)
    )
      continue;
    callees.set(callSiteId, {
      specifier: origin.specifier,
      path: member,
      ...(candidate ? { loader_authority: "candidate" as const } : {}),
    });
  }
  return callees;
};
