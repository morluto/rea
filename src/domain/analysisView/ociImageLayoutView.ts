import { z } from "zod";
import { ociImageLayoutSchema } from "../oci/imageLayout.js";
import { ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { invalidAnalysisView } from "./analysisViewErrors.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import {
  boundedViewLimitations,
  completeWithinViewCoverage,
} from "./analysisViewCoverage.js";

/** Layout identity and counts; index rows, images and blobs stay in the complete parent. */
export const ociImageLayoutSummarySchema = ociImageLayoutSchema
  .pick({
    artifact: true,
    coverage: true,
  })
  .extend({
    index_count: z.int().nonnegative(),
    image_count: z.int().nonnegative(),
    blob_count: z.int().nonnegative(),
    finding_count: z.int().nonnegative(),
    finding_kinds: z.array(z.string().min(1)),
    limitation_count: z.int().nonnegative(),
  });

const readReport = createAnalysisViewResultReader(ociImageLayoutSchema);

/** Summarize retained OCI image-layout facts without reopening the directory. */
export const projectOciImageLayoutView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<SummaryAnalysisView>(admitted, "summary");
  if (view === undefined)
    return invalidAnalysisView(
      "OCI image layout Evidence supports the summary view.",
    );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  return ok({
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_oci_image_layout" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: report.artifact.path,
      sha256: report.artifact.snapshot_sha256,
    },
    limitations: boundedViewLimitations(parent, report.limitations),
    unknowns: [],
    kind: "summary" as const,
    view,
    summary: {
      artifact: report.artifact,
      coverage: report.coverage,
      index_count: report.indexes.length,
      image_count: report.images.length,
      blob_count: report.blobs.length,
      finding_count: report.findings.length,
      finding_kinds: [
        ...new Set(report.findings.map((finding) => finding.kind)),
      ],
      limitation_count: report.limitations.length,
    },
    coverage: completeWithinViewCoverage(report.images.length),
  });
};
