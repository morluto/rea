import { z } from "zod";
import { nugetNupkgSchema } from "../nuget/nupkg.js";
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

/** Package identity and counts; member rows and dependencies stay in the complete parent. */
export const nugetNupkgSummarySchema = nugetNupkgSchema
  .pick({
    artifact: true,
    identity: true,
    license: true,
    repository: true,
    nuspec: true,
    coverage: true,
  })
  .extend({
    dependency_group_count: z.int().nonnegative(),
    dependency_count: z.int().nonnegative(),
    content_count: z.int().nonnegative(),
    limitation_count: z.int().nonnegative(),
  });

const readReport = createAnalysisViewResultReader(nugetNupkgSchema);

/** Summarize retained NuGet package facts without reopening the .nupkg. */
export const projectNugetNupkgView = (
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
          message: "NuGet package Evidence supports the summary view.",
        },
      ]),
    );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  return ok({
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_nuget_nupkg" as const,
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
      identity: report.identity,
      license: report.license,
      repository: report.repository,
      nuspec: report.nuspec,
      coverage: report.coverage,
      dependency_group_count: report.dependency_groups.length,
      dependency_count: report.dependency_groups.reduce(
        (total, group) => total + group.dependencies.length,
        0,
      ),
      content_count: report.contents.length,
      limitation_count: report.limitations.length,
    },
    coverage: completeWithinViewCoverage(
      report.contents.length,
      report.contents.length,
    ),
  });
};
