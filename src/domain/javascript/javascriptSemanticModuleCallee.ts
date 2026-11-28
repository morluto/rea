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
  /** The callee's binding may hold something other than this module. */
  readonly identity?: "possible";
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

/** Written member paths, one level per property name. */
interface WrittenSlot {
  written: boolean;
  readonly members: Map<string, WrittenSlot>;
}

const emptySlot = (): WrittenSlot => ({ written: false, members: new Map() });

const childSlot = (
  slots: Map<string, WrittenSlot>,
  key: string,
): WrittenSlot => {
  const found = slots.get(key);
  if (found !== undefined) return found;
  const created = emptySlot();
  slots.set(key, created);
  return created;
};

/**
 * Whether the source writes a member or an object containing it, through the
 * same binding or another binding of the module. Write order and execution are
 * not established, so a write anywhere leaves the member possibly replaced.
 */
const writtenMembers = (
  ir: Pick<JavaScriptSemanticIr, "objectOperations">,
  bindings: ReadonlyMap<string, SemanticBinding>,
) => {
  // Roots are binding IDs and module specifiers.
  const roots = new Map<string, WrittenSlot>();
  const record = (root: string, path: readonly string[]) => {
    let slot = childSlot(roots, root);
    for (const key of path) slot = childSlot(slot.members, key);
    slot.written = true;
  };
  for (const operation of ir.objectOperations) {
    const { kind, objectBindingId, requireOrigin, propertyPath } = operation;
    if (kind !== "write") continue;
    // A computed key may name any member of the object it is written on.
    const path = propertyPath ?? [];
    if (objectBindingId !== null) record(objectBindingId, path);
    for (const origin of requireOrigin !== undefined
      ? [requireOrigin]
      : objectBindingId === null
        ? []
        : (bindings.get(objectBindingId)?.provenance.origins ?? []))
      record(origin.specifier, [...originPath(origin), ...path]);
  }
  /** Walks the path once, so long member chains stay linear. */
  return (root: string, path: readonly string[]): boolean => {
    let slot = roots.get(root);
    for (const key of path) {
      if (slot === undefined || slot.written) break;
      slot = slot.members.get(key);
    }
    return slot?.written === true;
  };
};

const POSSIBLE = { replacement: "possible" } as const;

/**
 * Module-rooted callees by call site ID, from the call's recorded access path
 * and its module origin: a direct `require`, or the root binding's. A binding
 * that may hold something else is marked a possible identity, preferring the
 * origin of `preferred`. A binding with no known origin and an unrooted callee
 * are omitted.
 */
export const semanticModuleCallees = (
  ir: Pick<JavaScriptSemanticIr, "bindings" | "callSites" | "objectOperations">,
  preferred?: string,
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
    let uncertain = false;
    if (bindingId !== null) {
      const binding = bindings.get(bindingId);
      if (binding === undefined) continue;
      const { provenance, definitions } = binding;
      const { origins } = provenance;
      origin =
        origins.find(({ specifier }) => specifier === preferred) ?? origins[0];
      // Other ambiguity reasons concern the value itself, not only its loader.
      uncertain =
        origins.length > 1 ||
        (provenance.status !== "module" &&
          provenance.reason !== UNKNOWN_REQUIRE_LOADER_REASON) ||
        definitions.some(({ kind }) => kind === "assignment");
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
      ...(uncertain ? { identity: "possible" as const } : {}),
    });
  }
  return callees;
};
