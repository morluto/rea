/**
 * Items retained up to a maximum, with how many more were offered. A bounded
 * list never drops an item without counting it, so a consumer can always say
 * that more exist and how many.
 */
export interface BoundedList<T> {
  readonly items: readonly T[];
  readonly omitted: number;
}

/**
 * Retain the first `maximum` items and count the rest, adding to `omitted`
 * items an earlier bound already left out.
 */
export const boundedList = <T>(
  items: readonly T[],
  maximum: number,
  omitted = 0,
): BoundedList<T> => ({
  items: items.slice(0, maximum),
  omitted: omitted + Math.max(0, items.length - maximum),
});

/** Collects items up to a maximum and counts each item offered past it. */
export class BoundedListCollector<T> {
  readonly #items: T[] = [];
  #omitted = 0;

  constructor(readonly maximum: number) {}

  push(item: T): void {
    if (this.#items.length < this.maximum) this.#items.push(item);
    else this.#omitted += 1;
  }

  /** Whether a retained item equals `item`; omitted items are not kept. */
  retains(item: T): boolean {
    return this.#items.includes(item);
  }

  toList(): BoundedList<T> {
    return { items: [...this.#items], omitted: this.#omitted };
  }
}

/**
 * The retained items joined by `separator`, then "and N more" for the omitted
 * ones: `a; b; and 3 more`.
 */
export const describeBoundedList = (
  list: BoundedList<string>,
  separator: string,
): string => {
  if (list.omitted === 0) return list.items.join(separator);
  const rest = `and ${String(list.omitted)} more`;
  return list.items.length === 0
    ? rest
    : `${list.items.join(separator)}${separator}${rest}`;
};
