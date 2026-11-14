import { z } from "zod";
import { otlpTraceSchema } from "../otlpTrace/otlpTrace.js";
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

export const otlpTraceSummarySchema = otlpTraceSchema
  .pick({ artifact: true, format: true, summary: true, source_coverage: true })
  .extend({
    resource_count: z.int().nonnegative(),
    scope_count: z.int().nonnegative(),
  });
const readReport = createAnalysisViewResultReader(otlpTraceSchema);

/** Project retained format facts; the complete collection stays in the parent. */
export const projectOtlpTraceView = (
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
            "OtlpTrace Evidence supports the summary view; retrieve the parent Evidence for the complete inventory.",
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
    parent_operation: "inspect_otlp_trace" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    summary: {
      artifact: report.artifact,
      format: report.format,
      summary: report.summary,
      source_coverage: report.source_coverage,
      resource_count: report.resources.length,
      scope_count: report.scopes.length,
    },
    coverage: completeWithinViewCoverage(1, 1),
    limitations: boundedViewMessages(
      [...parent.limitations, ...report.limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: ["Recording completeness and cross-clock timing remain unknown."],
  });
};
