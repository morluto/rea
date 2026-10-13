import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import {
  managedArtifactInspectionSchema,
  managedMemberInspectionSchema,
} from "../managed/managedArtifact.js";
import { err, ok, type Result } from "../result.js";
import {
  analysisViewInputError,
  type AnalysisViewParent,
  type AnalysisViewRequest,
  type UnsignedAnalysisView,
} from "./analysisView.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";

/** Original metadata rows; offsets count entries in the returned parent collection. */
export const managedViewRequestSchema = z.strictObject({
  kind: z.literal("managed"),
  collection: z.enum(["references", "resources", "attributes"]),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
});

export const managedViewItemSchema = z.union([
  managedArtifactInspectionSchema.shape.references,
  managedArtifactInspectionSchema.shape.resources,
  managedArtifactInspectionSchema.shape.attributes,
]);

/** Keep complete classification and coverage; unrequested inventories remain retained. */
export const managedSummarySchema = managedArtifactInspectionSchema
  .omit({ references: true, resources: true, attributes: true })
  .extend({
    reported_counts: z.strictObject({
      references: z.number().int().nonnegative(),
      resources: z.number().int().nonnegative(),
      attributes: z.number().int().nonnegative(),
    }),
    identity_scope: managedMemberInspectionSchema.shape.identity_scope,
  });

export const managedViewContextSchema = z.strictObject({
  identity_scope: managedMemberInspectionSchema.shape.identity_scope,
  source_metadata_status:
    managedArtifactInspectionSchema.shape.metadata.shape.status,
  source_coverage: managedArtifactInspectionSchema.shape.coverage,
});

/** Project authenticated metadata without reading a path or invoking a provider. */
export const projectManagedArtifactView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "managed")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Managed artifact inspection supports summary and managed views.",
        },
      ]),
    );
  const parsed = managedArtifactInspectionSchema.safeParse(
    parent.normalizedResult,
  );
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        "inspect_analysis_view",
        parsed.error.issues.map((issue) => ({
          ...issue,
          path: ["source", "normalized_result", ...issue.path],
        })),
        { source: { normalized_result: parent.normalizedResult } },
        { cause: parsed.error },
      ),
    );
  const report = parsed.data;
  const identity_scope = {
    token_identity: "build-local" as const,
    requires_artifact_sha256: report.artifact.sha256,
    requires_mvid: report.module?.mvid ?? null,
  };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_managed_artifact" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    limitations: uniqueSorted([...parent.limitations, ...report.limitations]),
    unknowns: [
      "Collection counts and pages cover producer-returned rows; metadata completeness remains the original metadata status and coverage, not an absence claim about unreturned rows.",
      "Metadata tokens are build-local coordinates bound to the recorded artifact SHA-256 and module MVID; this view does not load or execute the assembly.",
      ...(parent.subject == null
        ? [
            "The parent has no recorded subject; its normalized artifact identity cannot be cross-checked against a subject digest.",
          ]
        : []),
      ...(identity_scope.requires_mvid === null
        ? [
            "The module MVID is unknown; tokens cannot establish a cross-observation module match.",
          ]
        : []),
    ],
  };
  if (view.kind === "summary") {
    const { references, resources, attributes, ...summary } = report;
    const reported_counts = {
      references: references.length,
      resources: resources.length,
      attributes: attributes.length,
    };
    const total = references.length + resources.length + attributes.length;
    return ok({
      kind: "summary",
      view,
      ...shared,
      summary: { ...summary, reported_counts, identity_scope },
      coverage: completeWithinViewCoverage(total, total),
    });
  }
  const collection = report[view.collection];
  const item = collection.slice(view.offset, view.offset + view.limit);
  return ok({
    kind: "managed",
    view,
    item,
    ...shared,
    identity_scope,
    source_metadata_status: report.metadata.status,
    source_coverage: report.coverage,
    coverage: pageViewCoverage(view.offset, item.length, collection.length),
  });
};
