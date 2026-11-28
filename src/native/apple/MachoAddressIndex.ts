import type { FileMapping } from "../../domain/virtualFileMapping.js";
import { lastAtOrBelow } from "../../domain/virtualFileMapping.js";

/** A section's VM span, as the function-starts parser reports it. */
export interface SectionSpan {
  readonly name: string;
  readonly address: bigint;
  readonly size: bigint;
}

/**
 * Disjoint intervals keyed by their sorted start points. `values[k]` covers
 * `[bounds[k], bounds[k + 1])`, so a lookup is one binary search instead of a
 * scan of every declared span.
 */
export interface IntervalIndex<Value> {
  readonly bounds: readonly bigint[];
  readonly values: readonly Value[];
}

export const lookupInterval = <Value>(
  index: IntervalIndex<Value>,
  point: bigint,
): Value | undefined => {
  const at = lastAtOrBelow(index.bounds, point);
  return at < 0 || at >= index.values.length ? undefined : index.values[at];
};

const uniqueSorted = (points: readonly bigint[]): bigint[] => {
  const sorted = [...points].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return sorted.filter(
    (point, index) => index === 0 || point !== sorted[index - 1],
  );
};

/** Min-heap order: smallest size, then the earliest declared section. */
const sectionBefore = (
  left: { readonly section: SectionSpan; readonly order: number },
  right: { readonly section: SectionSpan; readonly order: number },
): boolean =>
  left.section.size < right.section.size ||
  (left.section.size === right.section.size && left.order < right.order);

/**
 * Index the smallest section that contains each address. Overlapping
 * sections resolve the way a scan would: the smallest wins and the first
 * declared breaks a tie. A sweep with a lazily pruned min-heap builds it in
 * O(n log n).
 */
export const indexSmallestSections = (
  sections: readonly SectionSpan[],
): IntervalIndex<SectionSpan | null> => {
  const spans = sections
    .map((section, order) => ({ section, order }))
    .filter((span) => span.section.size > 0n)
    .sort((left, right) =>
      left.section.address < right.section.address
        ? -1
        : left.section.address > right.section.address
          ? 1
          : left.order - right.order,
    );
  const bounds = uniqueSorted(
    spans.flatMap((span) => [
      span.section.address,
      span.section.address + span.section.size,
    ]),
  );
  const heap: (typeof spans)[number][] = [];
  const push = (item: (typeof spans)[number]): void => {
    heap.push(item);
    let at = heap.length - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!sectionBefore(heap[at]!, heap[parent]!)) break;
      [heap[at], heap[parent]] = [heap[parent]!, heap[at]!];
      at = parent;
    }
  };
  const pop = (): void => {
    const last = heap.pop();
    if (last === undefined || heap.length === 0) return;
    heap[0] = last;
    let at = 0;
    for (;;) {
      const left = at * 2 + 1;
      const right = left + 1;
      let best = at;
      if (left < heap.length && sectionBefore(heap[left]!, heap[best]!))
        best = left;
      if (right < heap.length && sectionBefore(heap[right]!, heap[best]!))
        best = right;
      if (best === at) return;
      [heap[at], heap[best]] = [heap[best]!, heap[at]!];
      at = best;
    }
  };
  const values: (SectionSpan | null)[] = [];
  let next = 0;
  for (let index = 0; index + 1 < bounds.length; index += 1) {
    const point = bounds[index] as bigint;
    while (next < spans.length && spans[next]!.section.address <= point) {
      push(spans[next]!);
      next += 1;
    }
    while (
      heap.length > 0 &&
      heap[0]!.section.address + heap[0]!.section.size <= point
    )
      pop();
    values.push(heap[0]?.section ?? null);
  }
  return { bounds, values };
};

/**
 * Index each file offset's VM translation (`address - offset`). An interval
 * that more than one distinct translation covers is ambiguous and stored as
 * `null`, so the lookup reports it unmapped.
 */
export const indexFileOffsets = (
  mappings: readonly FileMapping[],
): IntervalIndex<bigint | null> => {
  const events = mappings
    .filter((mapping) => mapping.size > 0)
    .flatMap((mapping) => {
      const start = BigInt(mapping.offset);
      const delta = mapping.address - start;
      return [
        { point: start, delta, step: 1 },
        { point: start + BigInt(mapping.size), delta, step: -1 },
      ];
    })
    .sort((left, right) =>
      left.point < right.point ? -1 : left.point > right.point ? 1 : 0,
    );
  const bounds = uniqueSorted(events.map((event) => event.point));
  const active = new Map<bigint, number>();
  const values: (bigint | null)[] = [];
  let next = 0;
  for (let index = 0; index + 1 < bounds.length; index += 1) {
    const point = bounds[index] as bigint;
    while (next < events.length && events[next]!.point === point) {
      const event = events[next]!;
      const count = (active.get(event.delta) ?? 0) + event.step;
      if (count === 0) active.delete(event.delta);
      else active.set(event.delta, count);
      next += 1;
    }
    values.push(
      active.size === 1 ? (active.keys().next().value as bigint) : null,
    );
  }
  return { bounds, values };
};

/**
 * Index which addresses at least one of `ranges` covers. Overlaps and
 * adjacent ranges merge, and a lookup is one binary search, so a caller
 * checking many addresses does not scan every range for each one.
 */
export const indexCoveredRanges = (
  ranges: readonly { readonly address: bigint; readonly size: bigint }[],
): IntervalIndex<boolean> => {
  const events = ranges
    .filter((range) => range.size > 0n)
    .flatMap((range) => [
      { point: range.address, step: 1 },
      { point: range.address + range.size, step: -1 },
    ])
    .sort((left, right) =>
      left.point < right.point ? -1 : left.point > right.point ? 1 : 0,
    );
  const bounds = uniqueSorted(events.map((event) => event.point));
  const values: boolean[] = [];
  let depth = 0;
  let next = 0;
  for (let index = 0; index + 1 < bounds.length; index += 1) {
    const point = bounds[index] as bigint;
    while (next < events.length && events[next]!.point === point) {
      depth += events[next]!.step;
      next += 1;
    }
    values.push(depth > 0);
  }
  return { bounds, values };
};
