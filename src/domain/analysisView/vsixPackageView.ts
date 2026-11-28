import { z } from "zod";
import { vsixPackageSchema } from "../vsix/vsixPackage.js";
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

/** UTF-16 code-unit caps for summary text fields so summaries stay within the 32 KiB agent budget. */
const SUMMARY_TEXT_UNITS = 200;
const SUMMARY_DESCRIPTION_UNITS = 400;

const truncateSummaryText = (
  value: string,
  limit: number,
): { readonly text: string; readonly truncated: boolean } => {
  if (value.length <= limit) return { text: value, truncated: false };
  let end = limit;
  const last = value.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  if (end === 0) end = limit;
  return { text: value.slice(0, end), truncated: true };
};

/** Package identity and counts; member rows and full text stay in the complete parent. */
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
    text_truncated: z.boolean(),
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
    return invalidAnalysisView(
      "VS Code extension package Evidence supports the summary view.",
    );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  let textTruncated = false;
  const boundText = (
    value: string,
    limit: number = SUMMARY_TEXT_UNITS,
  ): string => {
    const bounded = truncateSummaryText(value, limit);
    if (bounded.truncated) textTruncated = true;
    return bounded.text;
  };
  const boundNullable = (
    value: string | null,
    limit: number = SUMMARY_TEXT_UNITS,
  ): string | null => (value === null ? null : boundText(value, limit));
  const summaryVsixIdentity =
    report.vsix_identity === null
      ? null
      : {
          id: boundNullable(report.vsix_identity.id),
          version: boundNullable(report.vsix_identity.version),
          publisher: boundNullable(report.vsix_identity.publisher),
          target_platform: boundNullable(report.vsix_identity.target_platform),
          display_name: boundNullable(report.vsix_identity.display_name),
          description: boundNullable(
            report.vsix_identity.description,
            SUMMARY_DESCRIPTION_UNITS,
          ),
        };
  const summaryPackageIdentity =
    report.package_identity === null
      ? null
      : {
          name: boundNullable(report.package_identity.name),
          publisher: boundNullable(report.package_identity.publisher),
          version: boundNullable(report.package_identity.version),
        };
  const summaryIdentityDisagreements = report.identity_disagreements.map(
    (entry) => ({
      field: boundText(entry.field),
      vsixmanifest: boundNullable(entry.vsixmanifest),
      package_json: boundNullable(entry.package_json),
    }),
  );
  const summaryEngine = {
    vsixmanifest: boundNullable(report.engine.vsixmanifest),
    package_json: boundNullable(report.engine.package_json),
    disagreement: report.engine.disagreement,
  };
  const summaryTargetPlatform = boundNullable(report.target_platform);
  const summaryEntryPoints = {
    main:
      report.entry_points.main === null
        ? null
        : {
            path: boundText(report.entry_points.main.path),
            present: report.entry_points.main.present,
          },
    browser:
      report.entry_points.browser === null
        ? null
        : {
            path: boundText(report.entry_points.browser.path),
            present: report.entry_points.browser.present,
          },
  };
  let eagerActivationEventCount = 0;
  for (const event of report.activation_events) {
    if (event.eager) eagerActivationEventCount++;
  }
  const requiredLimitations = textTruncated
    ? [
        `One or more summary text fields were truncated to fit the summary view; inspect parent Evidence ${parent.evidenceId} for complete values.`,
      ]
    : [];
  return ok({
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_vsix_package" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: report.artifact.path,
      sha256: report.artifact.sha256,
    },
    limitations: boundedViewLimitations(
      parent,
      report.limitations,
      requiredLimitations,
    ),
    unknowns: [],
    kind: "summary" as const,
    view,
    summary: {
      artifact: report.artifact,
      vsix_identity: summaryVsixIdentity,
      package_identity: summaryPackageIdentity,
      identity_disagreements: summaryIdentityDisagreements,
      engine: summaryEngine,
      target_platform: summaryTargetPlatform,
      entry_points: summaryEntryPoints,
      signatures: report.signatures,
      vsixmanifest: report.vsixmanifest,
      package_json: report.package_json,
      coverage: report.coverage,
      text_truncated: textTruncated,
      activation_event_count: report.activation_events.length,
      eager_activation_event_count: eagerActivationEventCount,
      contribute_key_count: report.contributes.keys.length,
      command_count: report.contributes.commands_total,
      content_count: report.contents.length,
      interesting_member_count: report.interesting_members.length,
      limitation_count: report.limitations.length,
    },
    coverage: completeWithinViewCoverage(report.contents.length),
  });
};
