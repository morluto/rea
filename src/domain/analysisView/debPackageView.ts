import { z } from "zod";
import { debPackageSchema } from "../deb/debPackage.js";
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

/** Package identity and counts; member rows and relationships stay in the complete parent. */
export const debPackageSummarySchema = debPackageSchema
  .pick({
    artifact: true,
    ar: true,
    coverage: true,
  })
  .extend({
    package: z.string().min(1).nullable(),
    version: z.string().min(1).nullable(),
    architecture: z.string().min(1).nullable(),
    relationship_group_count: z.int().nonnegative(),
    maintainer_script_count: z.int().nonnegative(),
    data_entry_count: z.int().nonnegative(),
    issue_count: z.int().nonnegative(),
    limitation_count: z.int().nonnegative(),
  });

const readReport = createAnalysisViewResultReader(debPackageSchema);

const relationshipGroupCount = (
  relationships: Record<string, readonly unknown[] | null>,
): number =>
  Object.values(relationships).reduce(
    (total, groups) => total + (groups?.length ?? 0),
    0,
  );

/** Summarize retained Debian package facts without reopening the .deb. */
export const projectDebPackageView = (
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
          message: "Debian package Evidence supports the summary view.",
        },
      ]),
    );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  return ok({
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_deb_package" as const,
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
      ar: report.ar,
      coverage: report.coverage,
      package: report.control?.package ?? null,
      version: report.control?.version?.raw ?? null,
      architecture: report.control?.architecture ?? null,
      relationship_group_count:
        report.control === null
          ? 0
          : relationshipGroupCount(report.control.relationships),
      maintainer_script_count: report.control?.maintainer_scripts.length ?? 0,
      data_entry_count: report.data_entries.length,
      issue_count: report.issues.length,
      limitation_count: report.limitations.length,
    },
    coverage: completeWithinViewCoverage(report.data_entries.length),
  });
};
