import {
  metadataReportSubjectFormat,
  type MachoTargetSelection,
} from "../apple/machoTargetSelection.js";
import { binaryMetadataArchitecture } from "../binaryMetadataArchitecture.js";
import { evidenceFileTarget } from "../evidence.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { ok, type Result } from "../result.js";
import { invalidAnalysisViewSubject } from "./analysisViewErrors.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";

/**
 * One owner for the metadata-report subject check. The parent subject must
 * name the report artifact's digest, container format and CPU family.
 */
export const requireMetadataReportSubject = (
  parent: AnalysisViewParent,
  report: {
    readonly format: "elf" | "pe" | "macho" | "wasm";
    readonly architecture: string;
    readonly artifact: { readonly sha256: string };
    readonly selected_slice?: MachoTargetSelection;
  },
  message: string,
): Result<void, AnalysisError> => {
  const subject = evidenceFileTarget(parent);
  if (
    subject == null ||
    subject.sha256 !== report.artifact.sha256 ||
    subject.format !== metadataReportSubjectFormat(report) ||
    subject.architecture !==
      (binaryMetadataArchitecture(report.architecture) ?? null)
  )
    return invalidAnalysisViewSubject(message);
  return ok(undefined);
};
