import { z } from "zod";
import { vsixPackageSchema } from "../vsix/vsixPackage.js";
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

/** Package identity and counts; member rows stay in the complete parent. */
export const vsixPackageSummarySchema = vsixPackageSchema
  .pick({
    artifact: true,
    vsix_identity: true,
    package_identity: true,
    identity_disagreements: true,
    engine: true,
    target_platform: true,
    entry_points: true,
    signatures: true,
    vsixmanifest: true,
    package_json: true,
    coverage: true,
  })
  .extend({
    activation_event_count: z.int().nonnegative(),
    eager_activation_event_count: z.int().nonnegative(),
    contribute_key_count: z.int().nonnegative(),
    command_count: z.int().nonnegative(),
    content_count: z.int().nonnegative(),
    interesting_member_count: z.int().nonnegative(),
    limitation_count: z.int().nonnegative(),
  });

const readReport = createAnalysisViewResultReader(vsixPackageSchema);

/** Summarize retained VS Code extension package facts without reopening the .vsix. */
export const projectVsixPackageView = (
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
          message:
            "VS Code extension package Evidence supports the summary view.",
        },
      ]),
    );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  return ok({
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_vsix_package" as const,
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
      vsix_identity: report.vsix_identity,
      package_identity: report.package_identity,
      identity_disagreements: report.identity_disagreements,
      engine: report.engine,
      target_platform: report.target_platform,
      entry_points: report.entry_points,
      signatures: report.signatures,
      vsixmanifest: report.vsixmanifest,
      package_json: report.package_json,
      coverage: report.coverage,
      activation_event_count: report.activation_events.length,
      eager_activation_event_count: report.activation_events.filter(
        (event) => event.eager,
      ).length,
      contribute_key_count: report.contributes.keys.length,
      command_count: report.contributes.commands_total,
      content_count: report.contents.length,
      interesting_member_count: report.interesting_members.length,
      limitation_count: report.limitations.length,
    },
    coverage: completeWithinViewCoverage(report.contents.length),
  });
};
