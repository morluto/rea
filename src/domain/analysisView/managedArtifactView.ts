import { evidenceFileTarget } from "../evidence.js";
import { invalidAnalysisView } from "./analysisViewErrors.js";
import { z } from "zod";
import { uniqueSorted } from "../canonicalOrdering.js";
import {
  managedArtifactInspectionSchema,
  managedMemberInspectionSchema,
} from "../managed/managedArtifact.js";
import { managedModuleRow } from "../managed/managedModuleIdentity.js";
import { validateManagedTokenScope } from "../managed/managedInspectionEvidence.js";
import { ok } from "../result.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";

/** Original metadata rows; offsets count entries in the returned parent collection. */
export const managedViewRequestSchema = z.strictObject({
  kind: z.literal("managed"),
  collection: z.enum(["references", "resources", "attributes"]),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
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
      references: z.int().nonnegative(),
      resources: z.int().nonnegative(),
      attributes: z.int().nonnegative(),
    }),
    identity_scope: managedMemberInspectionSchema.shape.identity_scope,
  });

export const managedViewContextSchema = z.strictObject({
  identity_scope: managedMemberInspectionSchema.shape.identity_scope,
  source_metadata_status:
    managedArtifactInspectionSchema.shape.metadata.shape.status,
  unresolved_module_name:
    managedArtifactInspectionSchema.shape.metadata.shape.unresolved_module_name,
  source_coverage: managedArtifactInspectionSchema.shape.coverage,
});

/** Token scope and identity limits shared by every managed metadata view. */
export const managedViewIdentityUnknowns = (
  parent: AnalysisViewParent,
  mvid: string | null,
): string[] => [
  "Metadata tokens are build-local coordinates bound to the recorded artifact SHA-256 and module MVID; this view does not load or execute the assembly.",
  ...(evidenceFileTarget(parent) === undefined
    ? [
        "The parent has no recorded subject; its normalized artifact identity cannot be cross-checked against a subject digest.",
      ]
    : []),
  ...(mvid === null
    ? [
        "The module MVID is unknown; tokens cannot establish a cross-observation module match.",
      ]
    : []),
];

const readManagedArtifact = createAnalysisViewResultReader(
  managedArtifactInspectionSchema,
);

/** Project authenticated metadata without reading a path or invoking a provider. */
export const projectManagedArtifactView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<
    SummaryAnalysisView | z.output<typeof managedViewRequestSchema>
  >(admitted, "summary", "managed");
  if (view === undefined)
    return invalidAnalysisView(
      "Managed artifact inspection supports summary and managed views.",
    );
  const parsed = readManagedArtifact(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const scope = validateManagedTokenScope(
    report,
    "inspect_managed_artifact",
    parent.evidenceId,
  );
  if (!scope.ok) return scope;
  const identity_scope = {
    token_identity: "build-local" as const,
    requires_artifact_sha256: report.artifact.sha256,
    requires_mvid: managedModuleRow(report)?.mvid ?? null,
  };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_managed_artifact" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    limitations: uniqueSorted([...parent.limitations, ...report.limitations]),
    unknowns: [
      "Collection counts and pages cover producer-returned rows; metadata completeness remains the original metadata status and coverage, not an absence claim about unreturned rows.",
      ...managedViewIdentityUnknowns(parent, identity_scope.requires_mvid),
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
      kind: "summary" as const,
      view,
      ...shared,
      summary: { ...summary, reported_counts, identity_scope },
      coverage: completeWithinViewCoverage(total),
    });
  }
  const collection = report[view.collection];
  const item = collection.slice(view.offset, view.offset + view.limit);
  return ok({
    kind: "managed" as const,
    view,
    item,
    ...shared,
    identity_scope,
    source_metadata_status: report.metadata.status,
    ...(report.metadata.unresolved_module_name === undefined
      ? {}
      : {
          unresolved_module_name: report.metadata.unresolved_module_name,
        }),
    source_coverage: report.coverage,
    coverage: pageViewCoverage(view.offset, item.length, collection.length),
  });
};
