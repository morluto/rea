import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { androidResultSchemas } from "../android/androidAnalysis.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import { err, ok, type Result } from "../result.js";
import {
  analysisViewInputError,
  type AnalysisViewParent,
  type AnalysisViewRequest,
  type UnsignedAnalysisView,
} from "./analysisView.js";
import { completeWithinViewCoverage } from "./analysisViewCoverage.js";
import { analysisTextPage } from "./analysisViewText.js";

const packageSchema = androidResultSchemas.inspect_android_package;

/** All package declarations remain inline; decoded manifest text stays retained. */
export const androidPackageSummarySchema = packageSchema.extend({
  manifest: packageSchema.shape.manifest.omit({ text: true }).extend({
    text_code_units: z.number().int().nonnegative(),
    text_included: z.literal(false),
  }),
});

/** Exact decoded text; offsets and limits count UTF-16 code units. */
export const androidViewRequestSchema = z.strictObject({
  kind: z.literal("android"),
  facet: z.literal("manifest"),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive(),
});

export const androidManifestViewItemSchema = z.strictObject({
  text: z.string(),
  unit: z.literal("utf16-code-units"),
  source_status: packageSchema.shape.manifest.shape.status,
  reported_total_bytes: packageSchema.shape.manifest.shape.reported_total_bytes,
});

/** Project an authenticated package record without reopening the APK or engine. */
export const projectAndroidPackageView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "android")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Android package Evidence supports summary and manifest views.",
        },
      ]),
    );
  const parsed = packageSchema.safeParse(parent.normalizedResult);
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
  // Engine artifact_sha256 identifies the JAR, never the APK. A missing
  // authenticated APK subject cannot be repaired using the engine identity.
  if (parent.subject == null)
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message:
            "Android package views require the recorded APK subject identity.",
        },
      ]),
    );
  const report = parsed.data;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_android_package" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: parent.subject.local_path,
      sha256: parent.subject.digest.sha256,
    },
    limitations: [...parent.limitations],
    unknowns: [
      "APK signatures were not verified; package declarations do not establish authenticity or runtime behavior.",
      ...(report.manifest.status === "partial"
        ? [
            "The decoded manifest is partial; exhausting retained text does not establish complete manifest coverage.",
          ]
        : []),
    ],
  };
  if (view.kind === "summary") {
    const { text, ...manifest } = report.manifest;
    return ok({
      kind: "summary",
      view,
      ...shared,
      summary: {
        ...report,
        manifest: {
          ...manifest,
          text_code_units: text.length,
          text_included: false,
        },
      },
      coverage: completeWithinViewCoverage(1, 1),
    });
  }
  const page = analysisTextPage(
    report.manifest.text,
    view.offset,
    view.limit,
    "Manifest",
  );
  if (!page.ok) return page;
  return ok({
    kind: "android",
    view,
    ...shared,
    item: {
      ...page.value.item,
      source_status: report.manifest.status,
      reported_total_bytes: report.manifest.reported_total_bytes,
    },
    coverage: page.value.coverage,
  });
};
