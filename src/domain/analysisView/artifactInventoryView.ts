import { z } from "zod";
import { AnalysisInputError } from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import { err, ok, type Result } from "../result.js";
import {
  parseArtifactInventoryEvidence,
  parseArtifactInventoryResult,
  validateArtifactInventorySubject,
  type InventorySet,
} from "../artifactInventoryEvidence.js";
import {
  artifactInspectionResultSchema,
  type ArtifactInspectionResult,
} from "../artifactInspection.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";

const inputError = (message: string): AnalysisInputError =>
  new AnalysisInputError("inspect_analysis_view", undefined, [
    {
      path: ["source"],
      reason: "invalid_value",
      message,
    },
  ]);

interface InventorySource {
  readonly inventory: InventorySet;
  readonly evidenceIds: readonly string[];
  readonly inspection: ArtifactInspectionResult | null;
}

/** Reuse the owning inventory integrity/completeness parser for both carriers. */
const parseSource = (
  parent: AnalysisViewParent,
): Result<InventorySource, AnalysisError> => {
  try {
    if (parent.operation === "inventory_artifact")
      return ok({
        inventory: parseArtifactInventoryResult(
          parent.normalizedResult,
          parent.subject ?? null,
        ),
        evidenceIds: [parent.evidenceId],
        inspection: null,
      });
    const inspection = artifactInspectionResultSchema.parse(
      parent.normalizedResult,
    );
    for (const step of inspection.substeps) {
      if (
        step.evidence_id !== step.evidence.evidence_id ||
        step.evidence.operation !== step.operation
      )
        throw new TypeError(
          "Inspection substep identity differs from its source Evidence",
        );
    }
    const parsed = parseArtifactInventoryEvidence(
      inspection.substeps.map(({ evidence }) => evidence),
    );
    const manifest = parsed.inventory.manifest;
    validateArtifactInventorySubject(parent.subject ?? null, manifest);
    if (
      inspection.subject.manifest_id !== manifest.manifest_id ||
      inspection.subject.root_artifact_id !== manifest.root_artifact_id ||
      inspection.subject.root_sha256 !== manifest.root_sha256 ||
      inspection.subject.root_format !== manifest.root_format
    )
      throw new TypeError(
        "Inspection subject differs from its inventory manifest",
      );
    return ok({
      inventory: parsed.inventory,
      evidenceIds: parsed.evidence.map(({ evidence_id }) => evidence_id),
      inspection,
    });
  } catch (cause: unknown) {
    if (!(cause instanceof TypeError) && !(cause instanceof z.ZodError))
      throw cause;
    return err(inputError(cause.message));
  }
};

/** Project exact source records; exhausted pages cover available records, not runtime behavior. */
export const projectArtifactInventoryView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  const operation = parent.operation;
  if (operation !== "inventory_artifact" && operation !== "inspect_artifact")
    return err(
      inputError(
        "Inventory views require inventory_artifact or inspect_artifact Evidence.",
      ),
    );
  if (view.kind !== "summary" && view.kind !== "inventory")
    return err(
      inputError("Artifact Evidence supports summary and inventory views."),
    );
  const parsed = parseSource(parent);
  if (!parsed.ok) return parsed;
  const { inventory, evidenceIds, inspection } = parsed.value;
  const limitations = uniqueSorted([
    ...parent.limitations,
    ...inventory.limitations,
    ...(inspection?.limitations ?? []),
  ]);
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: operation,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: parent.artifact?.path ?? "",
      sha256: inventory.manifest.root_sha256,
    },
    limitations,
    unknowns: [
      "Inventory does not establish application runtime behavior or complete format-specific analysis.",
      ...(inventory.complete
        ? []
        : [
            "Parent inventory is partial; counts and exhausted pages cover only available records. Missing matches do not establish absence.",
          ]),
    ],
  } satisfies Pick<
    UnsignedAnalysisView,
    | "parent_evidence_id"
    | "parent_operation"
    | "parent_digest"
    | "artifact"
    | "limitations"
    | "unknowns"
  >;
  if (view.kind === "summary") {
    const counts = { file: 0, directory: 0, symlink: 0, slice: 0 };
    for (const occurrence of inventory.occurrences)
      counts[occurrence.entry_kind]++;
    const examined =
      inventory.nodes.length +
      inventory.occurrences.length +
      inventory.edges.length;
    return ok({
      kind: "summary",
      view,
      summary: {
        manifest: inventory.manifest,
        available_counts: {
          nodes: inventory.nodes.length,
          occurrences: inventory.occurrences.length,
          edges: inventory.edges.length,
          integrity_contradictions: inventory.integrityContradictions.length,
        },
        observed_entry_kind_counts: counts,
        source_complete: inventory.complete,
        inventory_evidence_ids: [...evidenceIds],
        inspection:
          inspection === null
            ? null
            : {
                coverage: inspection.coverage,
                unexplored_branches: inspection.unexplored_branches,
              },
        limitation_count: limitations.length,
      },
      coverage: completeWithinViewCoverage(examined, examined),
      ...shared,
    });
  }
  const paths =
    view.collection === "occurrences" && view.logical_paths !== undefined
      ? new Set(view.logical_paths)
      : undefined;
  const rows =
    view.collection === "occurrences" && paths !== undefined
      ? inventory.occurrences.filter((row) => paths.has(row.logical_path))
      : view.collection === "occurrences"
        ? inventory.occurrences
        : view.collection === "nodes"
          ? inventory.nodes
          : view.collection === "edges"
            ? inventory.edges
            : inventory.integrityContradictions;
  const items = rows.slice(view.offset, view.offset + view.limit);
  return ok({
    kind: "inventory",
    view,
    manifest: inventory.manifest,
    inventory_evidence_ids: [...evidenceIds],
    source_complete: inventory.complete,
    items,
    coverage: pageViewCoverage(view.offset, items.length, rows.length),
    ...shared,
  });
};
