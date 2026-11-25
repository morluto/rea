import type { ComponentSort } from "../domain/wasm/wasmComponentTypes.js";

/** How an index-space entry was introduced; used to trace canonical relationships. */
export type IndexOrigin =
  | { readonly kind: "import"; readonly name: string }
  | { readonly kind: "export"; readonly of: number }
  | {
      readonly kind: "alias-export";
      readonly instance: number;
      readonly name: string;
    }
  | {
      readonly kind: "alias-core-export";
      readonly instance: number;
      readonly name: string;
    }
  | {
      readonly kind: "core-instantiate";
      readonly module: number;
      readonly args: readonly { name: string; instance: number }[];
    }
  | {
      /** A core or component instance made of exports of earlier indices. */
      readonly kind: "inline-exports";
      readonly exports: readonly {
        name: string;
        sort: ComponentSort;
        index: number;
      }[];
    }
  | { readonly kind: "canon"; readonly canon: number }
  | { readonly kind: "other" };

const OTHER: IndexOrigin = { kind: "other" };

interface IndexSpace {
  length: number;
  /** Only traceable origins are stored; every other known index is `other`. */
  readonly origins: Map<number, IndexOrigin>;
}

/**
 * Index spaces of one component. Counts are numbers, so file-controlled
 * counts such as start results cost no per-entry memory. After an undecoded
 * definition, a sort keeps its known prefix; only later indices are unknown.
 */
export class ComponentIndexSpaces {
  readonly #spaces = new Map<ComponentSort, IndexSpace>();
  /** Known prefix length of each sort that an undecoded definition ended. */
  readonly #prefixes = new Map<ComponentSort, number>();
  #allUnknown = false;

  #space(sort: ComponentSort): IndexSpace {
    let space = this.#spaces.get(sort);
    if (space === undefined) {
      space = { length: 0, origins: new Map() };
      this.#spaces.set(sort, space);
    }
    return space;
  }

  /** Whether an undecoded definition ended this sort's known prefix. */
  #ended(sort: ComponentSort): boolean {
    return this.#allUnknown || this.#prefixes.has(sort);
  }

  /** Number of leading indices whose positions are known. */
  #knownLength(sort: ComponentSort): number {
    if (!this.#ended(sort)) return this.#spaces.get(sort)?.length ?? 0;
    return this.#prefixes.get(sort) ?? 0;
  }

  /** Append one entry; its index is null once the sort's count is unknown. */
  add(sort: ComponentSort, origin: IndexOrigin = OTHER): number | null {
    const space = this.#space(sort);
    const index = space.length;
    space.length += 1;
    if (this.#ended(sort)) return null;
    if (origin.kind !== "other") space.origins.set(index, origin);
    return index;
  }

  /** Append `count` entries without traceable origins in constant time. */
  addAnonymous(sort: ComponentSort, count: number): void {
    this.#space(sort).length += count;
  }

  /** Origin at a known index, or undefined when it is unknown or absent. */
  origin(sort: ComponentSort, index: number): IndexOrigin | undefined {
    if (index >= this.#knownLength(sort)) return undefined;
    return this.#spaces.get(sort)?.origins.get(index) ?? OTHER;
  }

  /** End the known prefix of these sorts at their current lengths. */
  invalidate(sorts: readonly ComponentSort[] | "all"): void {
    if (sorts === "all") {
      for (const [sort, space] of this.#spaces)
        if (!this.#prefixes.has(sort)) this.#prefixes.set(sort, space.length);
      this.#allUnknown = true;
      return;
    }
    for (const sort of sorts)
      if (!this.#prefixes.has(sort))
        this.#prefixes.set(sort, this.#knownLength(sort));
  }
}
