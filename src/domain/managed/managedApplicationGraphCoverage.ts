import type { ApplicationGraphEvidence } from "../javascript/javascriptApplicationGraph.js";
import type {
  ManagedArtifactInspection,
  ManagedMemberInspection,
  ManagedNativeBoundaryInspection,
} from "./managedArtifact.js";

type ManagedCoverageState = "complete" | "partial" | "unavailable";

/** Source observations used to derive managed graph coverage. */
export interface ManagedGraphCoverageSources {
  readonly artifact: ManagedArtifactInspection | null;
  readonly members: ManagedMemberInspection | null;
  readonly boundaries: ManagedNativeBoundaryInspection | null;
}

/** Whether any supplied source has incomplete coverage. */
export interface ManagedGraphProjectionOmissions {
  readonly partialInput: boolean;
}

const completeCoverage = (): ApplicationGraphEvidence["coverage"] => ({
  status: "complete",
  truncated: false,
  omitted_count: 0,
  limits: [],
});

/** Preserve the source parser's coverage state on projected observations. */
export const managedSourceCoverage = (
  state: ManagedCoverageState,
): ApplicationGraphEvidence["coverage"] =>
  state === "complete"
    ? completeCoverage()
    : {
        status: state,
        truncated: false,
        omitted_count: null,
        limits: [],
      };

/** Determine whether any supplied managed inspection was partial. */
export const assessManagedGraphOmissions = (
  sources: ManagedGraphCoverageSources,
): ManagedGraphProjectionOmissions => ({
  partialInput: [
    sources.members?.coverage.state,
    sources.boundaries?.coverage.state,
    sources.artifact?.coverage.state,
  ].some((state) => state !== undefined && state !== "complete"),
});

/** Derive graph coverage solely from the coverage of supplied source evidence. */
export const managedGraphEvidenceCoverage = (
  omissions: ManagedGraphProjectionOmissions,
): ApplicationGraphEvidence["coverage"] =>
  omissions.partialInput
    ? {
        status: "partial",
        truncated: false,
        omitted_count: null,
        limits: [],
      }
    : completeCoverage();

/** Report whether all supplied source evidence was complete. */
export const managedGraphResultCoverage = (
  omissions: ManagedGraphProjectionOmissions,
) => ({
  status: omissions.partialInput
    ? ("partial" as const)
    : ("complete-within-inputs" as const),
});
