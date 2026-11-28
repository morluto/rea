import type {
  JavaScriptModuleOrigin,
  JavaScriptSemanticIr,
} from "./javascriptSemanticIr.js";
import { UNKNOWN_REQUIRE_LOADER_REASON } from "./javascriptSemanticProvenance.js";

/** A call whose callee is a static member chain rooted in one module import. */
export interface JavaScriptModuleCallee {
  readonly specifier: string;
  readonly path: readonly string[];
  /** CommonJS `require` whose loader is not established from source alone. */
  readonly loader_authority?: "candidate";
  /** The module reached the binding through a helper whose effect is unchecked. */
  readonly wrapper?: "unverified";
  /** The source also writes this member or an object containing it. */
  readonly replacement?: "possible";
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
  importSyntax,
}: JavaScriptModuleOrigin): readonly string[] =>
  resolutionMode === "require" && importSyntax !== true
    ? importedPath
    : withoutDefault(importedPath);

type SemanticBinding = JavaScriptSemanticIr["bindings"][number];

/**
 * Whether the source writes a member or an object containing it, through the
 * same binding or another binding of the module. Write order and execution are
 * not established, so a write anywhere leaves the member possibly replaced.
 */
const writtenMembers = (
  ir: Pick<JavaScriptSemanticIr, "objectOperations">,
  bindings: ReadonlyMap<string, SemanticBinding>,
) => {
  const written = new Set<string>();
  for (const operation of ir.objectOperations) {
    const { kind, objectBindingId, requireOrigin, propertyPath } = operation;
    if (kind !== "write" || propertyPath === null) continue;
    if (objectBindingId !== null)
      written.add(JSON.stringify([objectBindingId, ...propertyPath]));
    for (const origin of requireOrigin !== undefined
      ? [requireOrigin]
      : objectBindingId === null
        ? []
        : (bindings.get(objectBindingId)?.provenance.origins ?? []))
      written.add(
        JSON.stringify([
          origin.specifier,
          ...originPath(origin),
          ...propertyPath,
        ]),
      );
  }
  return (root: string, path: readonly string[]): boolean =>
    path.some((_, end) =>
      written.has(JSON.stringify([root, ...path.slice(0, end + 1)])),
    );
};

const POSSIBLE = { replacement: "possible" } as const;

/**
 * Module-rooted callees by call site ID, from the call's recorded access path
 * and its single module origin: a direct `require`, or the root binding's. A
 * reassigned binding, several origins or an unrooted callee are omitted.
 */
export const semanticModuleCallees = (
  ir: Pick<JavaScriptSemanticIr, "bindings" | "callSites" | "objectOperations">,
): ReadonlyMap<string, JavaScriptModuleCallee> => {
  const bindings = new Map(
    ir.bindings.map((binding) => [binding.bindingId, binding]),
  );
  const written = writtenMembers(ir, bindings);
  const callees = new Map<string, JavaScriptModuleCallee>();
  for (const { callSiteId, calleeAccess } of ir.callSites) {
    if (calleeAccess === undefined) continue;
    const { bindingId, wrappedSpecifier, requireOrigin, path } = calleeAccess;
    if (wrappedSpecifier !== undefined) {
      callees.set(callSiteId, {
        specifier: wrappedSpecifier,
        path: withoutDefault(path),
        loader_authority: "candidate",
        wrapper: "unverified",
        ...(bindingId !== null && written(bindingId, path) ? POSSIBLE : {}),
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
    callees.set(callSiteId, {
      specifier: origin.specifier,
      path: member,
      ...(origin.loaderAuthority === "candidate"
        ? { loader_authority: "candidate" as const }
        : {}),
      ...((bindingId !== null && written(bindingId, path)) ||
      written(origin.specifier, member)
        ? POSSIBLE
        : {}),
    });
  }
  return callees;
};
