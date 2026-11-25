import { Budget } from "../domain/budget.js";
import type { DecodedComponent } from "../domain/wasm/wasmComponent.js";
import type { ComponentSort } from "../domain/wasm/wasmComponentTypes.js";
import type {
  ComponentIndexSpaces,
  IndexOrigin,
} from "./WasmComponentIndexSpaces.js";
import {
  componentLimit,
  MAX_INLINE_RESULT_BYTES,
} from "./WasmComponentReader.js";

/**
 * Serialized bytes that relationship facts of one whole decode may still
 * add, shared by nested components. Lifts and lowers repeat names, so their
 * size can grow multiplicatively; each fact is charged before it is kept.
 */
export class RelationshipBudget {
  readonly #bytes = new Budget(MAX_INLINE_RESULT_BYTES);

  charge(fact: unknown): void {
    this.#bytes.charge(Buffer.byteLength(JSON.stringify(fact), "utf8"), () =>
      componentLimit("output-bytes", MAX_INLINE_RESULT_BYTES),
    );
  }
}

type CoreBinding = DecodedComponent["lowers"][number]["satisfies"][number];
type Defining = { readonly index: number; readonly origin: IndexOrigin };

/**
 * Walk an index chain once per index, caching every index on the path.
 * `step` returns the next index, or a final value; repeated indices end the
 * walk as unresolved instead of looping.
 */
const memoizedWalk = <T>(
  step: (index: number) => { readonly next: number } | { readonly done: T },
): ((index: number) => T | undefined) => {
  const resolved = new Map<number, T | undefined>();
  return (start) => {
    const path: number[] = [];
    const visiting = new Set<number>();
    let current = start;
    let result: T | undefined;
    for (;;) {
      if (resolved.has(current)) {
        result = resolved.get(current);
        break;
      }
      if (visiting.has(current)) break;
      visiting.add(current);
      path.push(current);
      const outcome = step(current);
      if ("done" in outcome) {
        result = outcome.done;
        break;
      }
      current = outcome.next;
    }
    for (const index of path) resolved.set(index, result);
    return result;
  };
};

/**
 * Find an export of an inline-exports instance by name, caching each
 * instance's exports of one sort. The first export of a name wins.
 */
const inlineExportLookup = (
  spaces: ComponentIndexSpaces,
  instanceSort: "instance" | "core instance",
  memberSort: ComponentSort,
): ((instance: number, name: string) => number | undefined) => {
  const byInstance = new Map<number, Map<string, number> | undefined>();
  return (instance, name) => {
    if (!byInstance.has(instance)) {
      const origin = spaces.origin(instanceSort, instance);
      byInstance.set(
        instance,
        origin?.kind === "inline-exports"
          ? new Map(
              origin.exports
                .filter(({ sort }) => sort === memberSort)
                .reverse()
                .map((entry) => [entry.name, entry.index] as const),
            )
          : undefined,
      );
    }
    return byInstance.get(instance)?.get(name);
  };
};

/**
 * Follow export re-aliases and aliases out of inline-exports instances back
 * to the entry that defined an index.
 */
const definingResolver = (
  spaces: ComponentIndexSpaces,
  sort: ComponentSort,
): ((index: number) => Defining | undefined) => {
  const inlineExport = inlineExportLookup(spaces, "instance", sort);
  return memoizedWalk<Defining | undefined>((index) => {
    const origin = spaces.origin(sort, index);
    if (origin === undefined) return { done: undefined };
    if (origin.kind === "export") return { next: origin.of };
    const next =
      origin.kind === "alias-export"
        ? inlineExport(origin.instance, origin.name)
        : undefined;
    return next === undefined ? { done: { index, origin } } : { next };
  });
};

/**
 * Resolve a core function aliased out of inline-export core instances to the
 * index that defines it, such as a lowered function or a module export alias.
 */
const coreFuncResolver = (
  spaces: ComponentIndexSpaces,
): ((index: number) => number | undefined) => {
  const inlineExport = inlineExportLookup(spaces, "core instance", "core func");
  return memoizedWalk<number>((index) => {
    const origin = spaces.origin("core func", index);
    if (origin?.kind !== "alias-core-export") return { done: index };
    const next = inlineExport(origin.instance, origin.name);
    return next === undefined ? { done: index } : { next };
  });
};

const append = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const values = map.get(key);
  if (values === undefined) map.set(key, [value]);
  else values.push(value);
};

/** Decoded function import and export names of each core module, by index. */
interface ModuleInterfaces {
  readonly imports: Map<number, Set<string>>;
  readonly exports: Map<number, Set<string>>;
}

const importKey = (module: string, name: string): string =>
  JSON.stringify([module, name]);

const moduleInterfaces = (component: DecodedComponent): ModuleInterfaces => {
  const imports = new Map<number, Set<string>>();
  const exports = new Map<number, Set<string>>();
  for (const module of component.core_modules) {
    if (module.index === null || module.interface.status !== "decoded")
      continue;
    imports.set(
      module.index,
      new Set(
        module.interface.imports
          .filter(({ type }) => type.kind === "func")
          .map(({ module: from, name }) => importKey(from, name)),
      ),
    );
    exports.set(
      module.index,
      new Set(
        module.interface.exports
          .filter(({ kind }) => kind === "func")
          .map(({ name }) => name),
      ),
    );
  }
  return { imports, exports };
};

/** Component export names of each defining function index. */
const exportNamesByFunc = (
  component: DecodedComponent,
  definingFunc: (index: number) => Defining | undefined,
): Map<number, string[]> => {
  const names = new Map<number, string[]>();
  for (const { target, name } of component.exports) {
    if (target.sort !== "func") continue;
    const defining = definingFunc(target.index);
    if (defining !== undefined) append(names, defining.index, name);
  }
  return names;
};

/** Core import bindings of each lowered core function, found in linear time. */
const coreImportBindings = (
  component: DecodedComponent,
  interfaces: ModuleInterfaces,
  canonicalCoreFunc: (index: number) => number | undefined,
  budget: RelationshipBudget,
): ((coreFunc: number) => CoreBinding[]) => {
  const providers = new Map<number, { instance: number; name: string }[]>();
  const consumers = new Map<
    number,
    { instance: number; module: number; argument: string }[]
  >();
  for (const instance of component.core_instances) {
    const index = instance.index;
    if (index === null) continue;
    if (instance.kind === "inline-exports") {
      for (const exported of instance.exports) {
        if (exported.sort !== "core func") continue;
        const defining = canonicalCoreFunc(exported.index);
        if (defining !== undefined)
          append(providers, defining, { instance: index, name: exported.name });
      }
    } else
      for (const argument of instance.args)
        append(consumers, argument.instance, {
          instance: index,
          module: instance.module,
          argument: argument.name,
        });
  }
  return (coreFunc) => {
    const bindings: CoreBinding[] = [];
    for (const provider of providers.get(coreFunc) ?? [])
      for (const consumer of consumers.get(provider.instance) ?? []) {
        const declared = interfaces.imports.get(consumer.module);
        const binding: CoreBinding = {
          core_instance: consumer.instance,
          core_module: consumer.module,
          import_module: consumer.argument,
          import_name: provider.name,
          declared_by_module:
            declared === undefined
              ? null
              : declared.has(importKey(consumer.argument, provider.name)),
        };
        budget.charge(binding);
        bindings.push(binding);
      }
    return bindings;
  };
};

const coreSource = (
  spaces: ComponentIndexSpaces,
  interfaces: ModuleInterfaces,
  coreFunc: number | undefined,
): DecodedComponent["lifts"][number]["core_source"] => {
  if (coreFunc === undefined) return null;
  const origin = spaces.origin("core func", coreFunc);
  if (origin?.kind !== "alias-core-export") return null;
  const instance = spaces.origin("core instance", origin.instance);
  const module = instance?.kind === "core-instantiate" ? instance.module : null;
  const declared = module === null ? undefined : interfaces.exports.get(module);
  return {
    core_instance: origin.instance,
    name: origin.name,
    core_module: module,
    declared_by_module:
      declared === undefined ? null : declared.has(origin.name),
  };
};

const componentSource = (
  definingFunc: (index: number) => Defining | undefined,
  definingInstance: (index: number) => Defining | undefined,
  func: number,
): DecodedComponent["lowers"][number]["component_source"] => {
  const defining = definingFunc(func);
  if (defining?.origin.kind === "import")
    return { kind: "import", name: defining.origin.name };
  if (defining?.origin.kind !== "alias-export") return null;
  const instance = definingInstance(defining.origin.instance);
  return {
    kind: "instance-export",
    instance: defining.origin.instance,
    name: defining.origin.name,
    instance_import:
      instance?.origin.kind === "import" ? instance.origin.name : null,
  };
};

/**
 * Trace each canonical lift to the core export it wraps, and each lower to
 * its component source and the core imports it is bound to. Memoized
 * resolvers and lookup tables keep the work linear, the budget bounds the
 * serialized facts, and unknown indices leave facts null or empty.
 */
export const resolveCanonRelationships = (
  component: DecodedComponent,
  spaces: ComponentIndexSpaces,
  budget: RelationshipBudget,
): Pick<DecodedComponent, "lifts" | "lowers"> => {
  const definingFunc = definingResolver(spaces, "func");
  const definingInstance = definingResolver(spaces, "instance");
  const canonicalCoreFunc = coreFuncResolver(spaces);
  const interfaces = moduleInterfaces(component);
  const exportedAs = exportNamesByFunc(component, definingFunc);
  const bindingsOf = coreImportBindings(
    component,
    interfaces,
    canonicalCoreFunc,
    budget,
  );
  const lifts: DecodedComponent["lifts"] = [];
  const lowers: DecodedComponent["lowers"] = [];
  for (const [position, canon] of component.canons.entries()) {
    if (
      canon.kind === "lift" &&
      canon.core_func !== undefined &&
      canon.type !== undefined
    ) {
      const func = canon.defines.index;
      const lift: DecodedComponent["lifts"][number] = {
        canon: position,
        func,
        core_func: canon.core_func,
        type: canon.type,
        core_source: coreSource(
          spaces,
          interfaces,
          canonicalCoreFunc(canon.core_func),
        ),
        exported_as: func === null ? [] : (exportedAs.get(func) ?? []),
      };
      budget.charge(lift);
      lifts.push(lift);
    }
    if (canon.kind === "lower" && canon.func !== undefined) {
      const coreFunc = canon.defines.index;
      const lower: DecodedComponent["lowers"][number] = {
        canon: position,
        func: canon.func,
        core_func: coreFunc,
        component_source: componentSource(
          definingFunc,
          definingInstance,
          canon.func,
        ),
        satisfies: [],
      };
      budget.charge(lower);
      if (coreFunc !== null) lower.satisfies = bindingsOf(coreFunc);
      lowers.push(lower);
    }
  }
  return { lifts, lowers };
};
