import {
  metadataReportSubjectFormat,
  type MachoTargetSelection,
} from "../apple/machoTargetSelection.js";
import { binaryMetadataArchitecture } from "../binaryMetadataArchitecture.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { err, ok, type Result } from "../result.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";

/**
 * One owner for the metadata-report subject check. The parent subject must
 * name the report artifact's digest, container format and CPU family.
 */
export const requireMetadataReportSubject = (
  parent: AnalysisViewParent,
  report: {
    readonly format: "elf" | "pe" | "macho";
    readonly architecture: string;
    readonly artifact: { readonly sha256: string };
    readonly selected_slice?: MachoTargetSelection;
  },
  message: string,
): Result<void, AnalysisError> => {
  const subject = parent.subject;
  if (
    subject == null ||
    subject.digest.sha256 !== report.artifact.sha256 ||
    subject.format !== metadataReportSubjectFormat(report) ||
    subject.architecture !==
      (binaryMetadataArchitecture(report.architecture) ?? null)
  )
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message,
        },
      ]),
    );
  return ok(undefined);
};
