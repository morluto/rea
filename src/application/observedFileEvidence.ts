import {
  createEvidence,
  type Evidence,
  type EvidenceLocation,
  type EvidenceProvider,
  type EvidenceSubjectTarget,
} from "../domain/evidence.js";

/** Report fields shared by file inspection Evidence producers. */
export interface FileInspectionReport {
  readonly artifact: { readonly path: string; readonly sha256: string };
  readonly limitations: readonly string[];
}

/** Bind a file inspection to its reported bytes and ordered source locations. */
export const observedFileEvidence = (
  report: FileInspectionReport,
  provider: EvidenceProvider,
  operation: string,
  parameters: unknown,
  additionalLocations: readonly EvidenceLocation[] = [],
  subject: Pick<EvidenceSubjectTarget, "format" | "architecture"> = {
    format: "file",
  },
): Evidence =>
  createEvidence(
    {
      ...subject,
      path: report.artifact.path,
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
