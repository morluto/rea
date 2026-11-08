import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { nugetPackageSchema } from "../nugetPackage/nugetPackage.js";
import { err, ok, type Result } from "../result.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { completeWithinViewCoverage } from "./analysisViewCoverage.js";

/**
 * A summary keeps what triage reads: identity, the declaration facts, the
 * per-kind asset counts and every diagnostic. The full member list stays in the
 * parent Evidence, so the summary counts what it did not repeat.
 */
export const nugetPackageSummarySchema = z.strictObject({
  artifact: nugetPackageSchema.shape.artifact,
  nuspecs: z.array(
    nugetPackageSchema.shape.nuspecs.element.omit({
      dependency_groups: true,
      description: true,
    }),
  ),
  nuspec_count: z.int().nonnegative(),
  asset_counts: z.strictObject(
    Object.fromEntries(
      nugetPackageSchema.shape.assets.element.shape.kind.options.map((kind) => [
        kind,
        z.int().nonnegative(),
      ]),
    ) as Record<string, z.ZodNumber>,
  ),
  asset_count: z.int().nonnegative(),
  assemblies: z.int().nonnegative(),
  diagnostics: nugetPackageSchema.shape.diagnostics,
  source_coverage: nugetPackageSchema.shape.source_coverage,
});

const readReport = createAnalysisViewResultReader(nugetPackageSchema);

/** Project retained declaration and inventory facts without reopening the package. */
export const projectNugetPackageView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
): Result<
  {
    readonly kind: "summary";
    readonly view: SummaryAnalysisView;
    readonly parent_evidence_id: string;
    readonly parent_operation: "inspect_nuget_package";
    readonly parent_digest: string;
    readonly artifact: { readonly path: string; readonly sha256: string };
    readonly summary: z.output<typeof nugetPackageSummarySchema>;
    readonly coverage: ReturnType<typeof completeWithinViewCoverage>;
    readonly limitations: string[];
    readonly unknowns: string[];
  },
  AnalysisError
> => {
  if (view.kind !== "summary")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "NuGet package Evidence supports the summary view; retrieve the parent Evidence for the complete member list.",
        },
      ]),
    );
  assertOwnedView<SummaryAnalysisView>(view, "summary");
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const assetCounts: Record<string, number> = {};
  for (const kind of nugetPackageSchema.shape.assets.element.shape.kind.options)
    assetCounts[kind] = 0;
  for (const asset of report.assets)
    assetCounts[asset.kind] = (assetCounts[asset.kind] ?? 0) + 1;
  return ok({
    kind: "summary" as const,
    view,
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_nuget_package" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    summary: {
      artifact: report.artifact,
      nuspecs: report.nuspecs.map(
        ({ dependency_groups: _groups, description: _description, ...rest }) =>
          rest,
      ),
      nuspec_count: report.nuspecs.length,
      asset_counts: assetCounts,
      asset_count: report.assets.length,
      assemblies: report.summary.assemblies,
      diagnostics: report.diagnostics,
      source_coverage: report.source_coverage,
    },
    coverage: completeWithinViewCoverage(1, 1),
    limitations: [...parent.limitations].sort(),
    unknowns:
      report.source_coverage.status === "partial"
        ? [
            "Package coverage is partial; package identity, declared dependencies or some members are unobserved. The diagnostics on the parent Evidence name each reason.",
          ]
        : [],
  });
};
