import type { TestSelectionPlan } from "./test-selection.d.mts";

export interface ChangePlanRequest {
  readonly event: string | undefined;
  readonly full: boolean;
  readonly skipFull: boolean;
  readonly base: string | undefined;
  readonly head: string | undefined;
  readonly baselineReason?: string | undefined;
}

/** The Git questions a plan asks; a failure propagates as a planning failure. */
export interface ChangePlanRepository {
  readonly mergeBase: (base: string, head: string) => string;
  readonly isAncestor: (ancestor: string, head: string) => boolean;
  readonly changedFiles: (base: string, head: string) => readonly string[];
  readonly readFile: (revision: string, path: string) => string;
  readonly listFiles: (
    revision: string,
    directories: readonly string[],
  ) => readonly string[];
  readonly readFiles: (
    revision: string,
    paths: readonly string[],
  ) => ReadonlyMap<string, string>;
}

export type ChangePlan = Readonly<Record<string, unknown>> & {
  readonly tier: "full" | "fast" | "reused";
  readonly matrix: {
    readonly include: readonly {
      readonly os: string;
      readonly platform: string;
      readonly architecture: string;
    }[];
  };
  readonly files: readonly string[];
  readonly reasons: readonly string[];
  readonly testSelection: TestSelectionPlan;
  readonly testShards: readonly string[];
  /** null requests full typed lint when the file list exceeds the output bound. */
  readonly typedLintFiles: readonly string[] | null;
};

export function planChanges(
  request: ChangePlanRequest,
  repository: ChangePlanRepository,
): ChangePlan;

export function gitRepository(cwd?: string): ChangePlanRepository;
