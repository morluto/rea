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
  /** True only when `shrink` lowered or removed a recorded count. */
  readonly lowered: boolean;
};

/** Record a lowered baseline under `key`; true when the map changed. */
export function recordLoweredBaseline(
  baselines: Record<string, Record<string, number>>,
  key: string,
  compared: {
    readonly baseline: Record<string, number>;
    readonly lowered: boolean;
  },
): boolean;

/** The baseline file text: guard order kept, each guard's paths in code-unit order. */
export function serializeCountedBaselines(
  baselines: Readonly<Record<string, Readonly<Record<string, number>>>>,
): string;

/** Leave, rewrite or reject the baseline file read as `text`. */
export function reconcileBaselineFile(
  text: string,
  baselines: Readonly<Record<string, Readonly<Record<string, number>>>>,
  shrink: boolean,
):
  | { readonly action: "none" | "reject" }
  | { readonly action: "write"; readonly text: string };
