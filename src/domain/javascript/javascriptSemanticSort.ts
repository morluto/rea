/** stably sort owned work arrays, yielding between bounded merge batches. */
export function* stableSemanticSortSteps<T>(
  values: T[],
  compare: (left: T, right: T) => number,
): Generator<void, T[]> {
  let ordered = values;
  let scratch = new Array<T>(values.length);
  let examined = 0;
  for (let width = 1; width < values.length; width *= 2) {
    for (let start = 0; start < values.length; start += width * 2) {
      const middle = Math.min(start + width, values.length);
      const end = Math.min(start + width * 2, values.length);
      let left = start;
      let right = middle;
      for (let index = start; index < end; index++) {
        if (examined++ % 1024 === 0) yield;
        const precedes =
          left < middle &&
          (right >= end || compare(ordered[left]!, ordered[right]!) <= 0);
        scratch[index] = precedes ? ordered[left++]! : ordered[right++]!;
      }
    }
    [ordered, scratch] = [scratch, ordered];
  }
  return ordered;
}
