interface RvaSection<T> {
  readonly start: number;
  readonly end: number;
  readonly section: T;
}

interface RvaSectionMatch<T> {
  readonly section: RvaSection<T> | undefined;
  readonly overlaps: boolean;
  readonly nextStart: number;
}

/** Index declared virtual extents. Consumers still own their file-backing rules. */
export const indexPeSectionRvas = <T>(
  ranges: RvaSection<T>[],
): ((rva: number) => RvaSectionMatch<T>) => {
  const sorted = ranges
    .filter(({ start, end }) => start < end)
    .sort((a, b) => a.start - b.start);

  // At any query start, only sections beginning at or before it can own it.
  // The two greatest endpoints in that prefix identify both ownership and
  // ambiguity, including when one long section contains many expired sections.
  const prefixes: {
    readonly farthest: RvaSection<T>;
    readonly secondEnd: number;
  }[] = [];
  let farthest: RvaSection<T> | undefined;
  let secondEnd = 0;
  for (const range of sorted) {
    if (farthest === undefined || range.end > farthest.end) {
      secondEnd = farthest?.end ?? 0;
      farthest = range;
    } else {
      secondEnd = Math.max(secondEnd, range.end);
    }
    prefixes.push({ farthest, secondEnd });
  }

  return (rva) => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sorted[middle]!.start <= rva) low = middle + 1;
      else high = middle;
    }
    const prefix = prefixes[low - 1];
    return {
      section:
        prefix !== undefined && prefix.farthest.end > rva
          ? prefix.farthest
          : undefined,
      overlaps: prefix !== undefined && prefix.secondEnd > rva,
      nextStart: sorted[low]?.start ?? Infinity,
    };
  };
};
