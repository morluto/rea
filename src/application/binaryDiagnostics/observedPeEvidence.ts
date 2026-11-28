import type {
  Evidence,
  EvidenceLocation,
  EvidenceProvider,
} from "../../domain/evidence.js";
import { peSubjectArchitecture } from "../../domain/peMachine.js";
import {
  observedFileEvidence,
  type FileInspectionReport,
} from "../observedFileEvidence.js";

/** Bind a PE observation to the architecture supported by its machine and optional header. */
export const observedPeEvidence = (
  report: FileInspectionReport & {
    readonly machine: number;
    readonly format: "pe32" | "pe32-plus";
  },
  provider: EvidenceProvider,
  operation: string,
  parameters: unknown,
  locations: readonly EvidenceLocation[] = [],
): Evidence => {
  const architecture = peSubjectArchitecture(report.machine, report.format);
  return observedFileEvidence(
    report,
    provider,
    operation,
    parameters,
    locations,
    {
      format: "pe",
      ...(architecture === undefined ? {} : { architecture }),
    },
  );
};
