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
};

export function planChanges(
  request: ChangePlanRequest,
  repository: ChangePlanRepository,
): ChangePlan;

export function gitRepository(cwd?: string): ChangePlanRepository;
