import {
  createEvidence,
  type Evidence,
  type EvidenceLocation,
  type EvidenceProvider,
} from "../domain/evidence.js";

/** Bind a file inspection to its reported bytes and ordered source locations. */
export const observedFileEvidence = (
  report: {
    readonly artifact: { readonly path: string; readonly sha256: string };
    readonly limitations: readonly string[];
  },
  provider: EvidenceProvider,
  operation: string,
  parameters: unknown,
  additionalLocations: readonly EvidenceLocation[] = [],
): Evidence =>
  createEvidence(
    {
      path: report.artifact.path,
      format: "file",
      sha256: report.artifact.sha256,
    },
    provider,
    {
      operation,
      parameters,
      result: report,
      confidence: "observed",
      limitations: report.limitations,
      locations: [
        { kind: "artifact-path", path: report.artifact.path },
        ...additionalLocations,
      ],
    },
  );
