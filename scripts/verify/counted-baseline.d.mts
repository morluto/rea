/** One file whose observed count differs from its recorded baseline. */
export interface CountedBaselineDifference {
  readonly path: string;
  readonly count: number;
  readonly allowed: number;
}

/** Compare per-file counts with a baseline that may only shrink. */
export function compareCountedBaseline(
  counts: ReadonlyMap<string, number>,
  baseline: Readonly<Record<string, number>>,
  shrink: boolean,
): {
  readonly grown: CountedBaselineDifference[];
  readonly stale: CountedBaselineDifference[];
  readonly baseline: Record<string, number>;
};
