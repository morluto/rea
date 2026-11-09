import { evtxArchiveSchema } from "../evtxArchive/evtxArchive.js";
import { err, ok } from "../result.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
} from "./analysisViewCoverage.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";

export const evtxArchiveSummarySchema = evtxArchiveSchema.pick({
  artifact: true,
  file_version: true,
  summary: true,
  source_coverage: true,
});
const readReport = createAnalysisViewResultReader(evtxArchiveSchema);

/** Project retained format facts; the complete collection stays in the parent. */
export const projectEvtxArchiveView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (view.kind !== "summary")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "EvtxArchive Evidence supports the summary view; retrieve the parent Evidence for the complete inventory.",
        },
      ]),
    );
  assertOwnedView<SummaryAnalysisView>(view, "summary");
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  return ok({
    kind: "summary" as const,
    view,
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_evtx_archive" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    summary: {
      artifact: report.artifact,
      file_version: report.file_version,
      summary: report.summary,
      source_coverage: report.source_coverage,
    },
    coverage: completeWithinViewCoverage(1, 1),
    limitations: boundedViewMessages(
      [...parent.limitations, ...report.limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: ["Event XML and payload values are not decoded."],
  });
};
