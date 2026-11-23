/** Serving's order of the state's entity keys, which orders a type's collections by their first entity, and each type's collections in the order serving first knew them, which emptying does not change. */
export class ServedOrder {
  #keys: string[] = [];
  readonly #known = new Map<string, Set<string>>();

  /** The keys in state order. */
  get keys(): readonly string[] {
    return this.#keys;
  }

  /** Hold the Evidence's entities in their own order. */
  reset(keys: readonly string[]): void {
    this.#keys = [...keys];
  }

  /** Add a key at `at` of its collection's `members`, beside them as serving places it, or last when the collection is empty. */
  place(key: string, members: readonly string[], at: number): void {
    const anchor =
      at < members.length
        ? this.#keys.indexOf(members[at]!)
        : members.length > 0
          ? this.#keys.indexOf(members.at(-1)!) + 1
          : this.#keys.length;
    this.#keys.splice(anchor, 0, key);
  }

  /** Put these keys, in this order, in the places they already hold among the others. */
  arrange(keys: readonly string[]): void {
    if (keys.length === 0) return;
    const wanted = new Set(keys);
    let next = 0;
    for (let index = 0; index < this.#keys.length; index++) {
      if (wanted.has(this.#keys[index]!)) this.#keys[index] = keys[next++]!;
    }
  }

  remove(key: string): void {
    const index = this.#keys.indexOf(key);
    if (index !== -1) this.#keys.splice(index, 1);
  }

  remember(type: string, collection: string): void {
    const collections = this.#known.get(type) ?? new Set<string>();
    this.#known.set(type, collections.add(collection));
  }

  /** Every collection of a type the state has held, in the order serving remembers them. */
  known(type: string): readonly string[] {
    return [...(this.#known.get(type) ?? [])];
  }
}
