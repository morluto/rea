export interface DevelopmentTestRequest {
  readonly mode: "local" | "changed" | "focused";
  readonly paths: readonly string[];
  readonly base: string;
  readonly dryRun: boolean;
}

/** Parse explicit test paths and an optional branch-comparison base. */
export function parseDevelopmentTestRequest(
  mode: string,
  arguments_: readonly string[],
): DevelopmentTestRequest;

/** Plan source feedback or a strict explicit run with its build prerequisite. */
export function developmentTestPlan(
  request: DevelopmentTestRequest,
  baseCommit?: string,
): {
  readonly needsBuild: boolean;
  readonly vitestArguments: readonly string[];
};
