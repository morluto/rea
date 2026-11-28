import type {
  JavaScriptModuleOrigin,
  JavaScriptSemanticIr,
} from "./javascriptSemanticIr.js";
import type { JavaScriptSourceRange } from "./javascriptStaticAnalysisTypes.js";
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
 * An origin's member path. A `default` from an import names the module; one
 * written on a `require` is a real member.
 */
const originPath = ({
  importedPath,
  resolutionMode,
}: JavaScriptModuleOrigin): readonly string[] =>
  resolutionMode === "require" ? importedPath : withoutDefault(importedPath);

type SemanticBinding = JavaScriptSemanticIr["bindings"][number];

const isBefore = (
  left: JavaScriptSourceRange["start"],
  right: JavaScriptSourceRange["start"],
): boolean =>
  left.line < right.line ||
  (left.line === right.line && left.column < right.column);

/**
 * Whether source earlier than the call writes the called member or an object
 * containing it, through the same binding or another binding of the module.
 */
const replacedMembers = (
  ir: Pick<JavaScriptSemanticIr, "objectOperations">,
  bindings: ReadonlyMap<string, SemanticBinding>,
) => {
  const written = new Map<string, JavaScriptSourceRange["start"]>();
  const record = (key: string, at: JavaScriptSourceRange["start"]) => {
    const earlier = written.get(key);
    if (earlier === undefined || isBefore(at, earlier)) written.set(key, at);
  };
  for (const operation of ir.objectOperations) {
    const { kind, objectBindingId, propertyPath, location } = operation;
    if (kind !== "write" || objectBindingId === null || propertyPath === null)
      continue;
    record(JSON.stringify([objectBindingId, ...propertyPath]), location.start);
    for (const origin of bindings.get(objectBindingId)?.provenance.origins ??
      [])
      record(
        JSON.stringify([
          origin.specifier,
          ...originPath(origin),
          ...propertyPath,
        ]),
        location.start,
      );
  }
  return (
    root: string,
    path: readonly string[],
    call: JavaScriptSourceRange["start"],
  ): boolean =>
    path.some((_, end) => {
      const at = written.get(JSON.stringify([root, ...path.slice(0, end + 1)]));
      return at !== undefined && isBefore(at, call);
    });
};

/**
 * Module-rooted callees by call site ID, from the call's recorded access path
 * and its single module origin: a direct `require`, or the root binding's. A
 * reassigned binding, several origins, a replaced member or an unrooted callee
 * are omitted.
 */
export const semanticModuleCallees = (
  ir: Pick<JavaScriptSemanticIr, "bindings" | "callSites" | "objectOperations">,
): ReadonlyMap<string, JavaScriptModuleCallee> => {
  const bindings = new Map(
    ir.bindings.map((binding) => [binding.bindingId, binding]),
  );
  const replaced = replacedMembers(ir, bindings);
  const callees = new Map<string, JavaScriptModuleCallee>();
  for (const { callSiteId, calleeAccess, location } of ir.callSites) {
    if (calleeAccess === undefined) continue;
    const { bindingId, wrappedSpecifier, requireOrigin, path } = calleeAccess;
    if (wrappedSpecifier !== undefined) {
      if (bindingId !== null && replaced(bindingId, path, location.start))
        continue;
      callees.set(callSiteId, {
        specifier: wrappedSpecifier,
        path: withoutDefault(path),
        loader_authority: "candidate",
        wrapper: "unverified",
      });
      continue;
    }
    let origin = requireOrigin;
    if (bindingId !== null) {
      const binding = bindings.get(bindingId);
      if (binding === undefined) continue;
      const { provenance, definitions } = binding;
      const [only, ...others] = provenance.origins;
      if (only === undefined || others.length > 0) continue;
      // Other ambiguity reasons concern the value itself, not only its loader.
      if (
        provenance.status !== "module" &&
        provenance.reason !== UNKNOWN_REQUIRE_LOADER_REASON
      )
        continue;
      if (definitions.some(({ kind }) => kind === "assignment")) continue;
      origin = only;
    }
    if (origin === undefined) continue;
    const member = [...originPath(origin), ...path];
    if (
      (bindingId !== null && replaced(bindingId, path, location.start)) ||
      replaced(origin.specifier, member, location.start)
    )
      continue;
    callees.set(callSiteId, {
      specifier: origin.specifier,
      path: member,
      ...(origin.loaderAuthority === "candidate"
        ? { loader_authority: "candidate" as const }
        : {}),
    });
  }
  return callees;
};
