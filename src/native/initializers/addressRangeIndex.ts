/** One half-open address range `[start, end)` and the value it names. */
export interface AddressRange<T> {
  readonly start: bigint;
  readonly end: bigint;
  readonly value: T;
}

const compareBigInt = (left: bigint, right: bigint): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Minimal binary heap; `before(a, b)` is true when `a` belongs on top. */
const heap = <T>(before: (left: T, right: T) => boolean) => {
  const items: T[] = [];
  const swap = (a: number, b: number): void => {
    const held = items[a] as T;
    items[a] = items[b] as T;
    items[b] = held;
  };
  return {
    top: (): T | undefined => items[0],
    push(item: T): void {
      items.push(item);
      let at = items.length - 1;
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if (!before(items[at] as T, items[parent] as T)) break;
        swap(at, parent);
        at = parent;
      }
    },
    pop(): void {
      const last = items.pop();
      if (last === undefined || items.length === 0) return;
      items[0] = last;
      let at = 0;
      for (;;) {
        const left = at * 2 + 1;
        const right = left + 1;
        let best = at;
        if (left < items.length && before(items[left] as T, items[best] as T))
          best = left;
        if (right < items.length && before(items[right] as T, items[best] as T))
          best = right;
        if (best === at) return;
        swap(at, best);
        at = best;
      }
    },
  };
};

/**
 * Disjoint pieces of overlapping ranges, each naming the preferred range that
 * covers it. Built once in O(n log n) so per-address lookups are binary
 * searches instead of walks over every header.
 */
export interface AddressRangeIndex<T> {
  /** The preferred range covering `address`, if any. */
  readonly at: (address: bigint) => AddressRange<T> | undefined;
}

/** `prefer(a, b) < 0` when `a` wins where both cover an address. It must be a total order. */
export const buildAddressRangeIndex = <T>(
  ranges: readonly AddressRange<T>[],
  prefer: (left: T, right: T) => number,
): AddressRangeIndex<T> => {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => compareBigInt(left.start, right.start));
  const bounds = [
    ...new Set(sorted.flatMap((range) => [range.start, range.end])),
  ].sort(compareBigInt);
  const active = heap<AddressRange<T>>(
    (left, right) => prefer(left.value, right.value) < 0,
  );
  const starts: bigint[] = [];
  const ends: bigint[] = [];
  const winners: AddressRange<T>[] = [];
  let next = 0;
  for (let index = 0; index + 1 < bounds.length; index += 1) {
    const bound = bounds[index] as bigint;
    while (
      next < sorted.length &&
      (sorted[next] as AddressRange<T>).start <= bound
    ) {
      active.push(sorted[next] as AddressRange<T>);
      next += 1;
    }
    let top = active.top();
    while (top !== undefined && top.end <= bound) {
      active.pop();
      top = active.top();
    }
    if (top === undefined) continue;
    const pieceEnd = bounds[index + 1] as bigint;
    const last = winners.length - 1;
    if (last >= 0 && winners[last] === top && ends[last] === bound) {
      ends[last] = pieceEnd;
      continue;
    }
    starts.push(bound);
    ends.push(pieceEnd);
    winners.push(top);
  }
  return {
    at(address) {
      let low = 0;
      let high = starts.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if ((starts[middle] as bigint) > address) high = middle - 1;
        else if ((ends[middle] as bigint) <= address) low = middle + 1;
        else return winners[middle];
      }
      return undefined;
    },
  };
};
