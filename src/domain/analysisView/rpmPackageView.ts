import { z } from "zod";
import { rpmPackageSchema } from "../rpm/package.js";
import { err, ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
} from "./analysisViewCoverage.js";

/** Package identity and counts; dependency and file rows stay in the complete parent. */
export const rpmPackageSummarySchema = rpmPackageSchema
  .pick({
    artifact: true,
    lead: true,
    package: true,
    payload: true,
    coverage: true,
  })
  .extend({
    signature_blob_count: z.int().nonnegative().nullable(),
    dependency_count: z.int().nonnegative().nullable(),
    scriptlet_count: z.int().nonnegative().nullable(),
    file_count: z.int().nonnegative().nullable(),
    limitation_count: z.int().nonnegative(),
  });

const readReport = createAnalysisViewResultReader(rpmPackageSchema);

/** Summarize retained RPM package facts without reopening the file. */
export const projectRpmPackageView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<SummaryAnalysisView>(admitted, "summary");
  if (view === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message: "RPM package Evidence supports the summary view.",
        },
      ]),
    );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  return ok({
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_rpm_package" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: report.artifact.path,
      sha256: report.artifact.sha256,
    },
    limitations: boundedViewMessages(
      [...parent.limitations, ...report.limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: [],
    kind: "summary" as const,
    view,
    summary: {
      artifact: report.artifact,
      lead: report.lead,
      package: report.package,
      payload: report.payload,
      coverage: report.coverage,
      signature_blob_count:
        report.signature === null ? null : report.signature.blobs.length,
      dependency_count: report.coverage.dependencies,
      scriptlet_count:
        report.scriptlets === null ? null : report.scriptlets.length,
      file_count: report.coverage.files,
      limitation_count: report.limitations.length,
    },
    coverage: completeWithinViewCoverage(report.files?.length ?? 0),
  });
};
