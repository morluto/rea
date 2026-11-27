import { androidResultSchemas } from "../android/androidAnalysis.js";
import type { JsonValue } from "../jsonValue.js";
import { jsonValueByteLength } from "../jsonValueByteLength.js";
import { err, ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  boundedViewLimitations,
  completeWithinViewCoverage,
} from "./analysisViewCoverage.js";
import {
  ANALYSIS_VIEW_PAGE_BYTES as PAGE_BYTES,
  analysisViewPageTooLarge,
  analysisViewInputError,
  invalidAnalysisViewSubject,
  invalidAnalysisView,
} from "./analysisViewErrors.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import { evidenceSubjectTarget } from "../evidence.js";

/** Exact requested facts; only the parent Evidence's raw protocol calls are omitted. */
export const androidMethodSummarySchema =
  androidResultSchemas.inspect_android_method;
const readMethod = createAnalysisViewResultReader(androidMethodSummarySchema);
const DIGEST_BYTES = jsonValueByteLength({ view_digest: "0".repeat(64) }) - 1;
const PROJECTION_BYTES = PAGE_BYTES - DIGEST_BYTES;

const boundedSummary = <View extends { readonly parent_evidence_id: string }>(
  result: View,
) =>
  jsonValueByteLength(result as unknown as JsonValue, PROJECTION_BYTES) >
  PROJECTION_BYTES
    ? analysisViewPageTooLarge(
        result.parent_evidence_id,
        "The complete Android method summary exceeds the analysis-view byte budget. Read complete parent Evidence.",
        { remediationAction: "Select complete detail." },
      )
    : ok(result);

/** Reuse authenticated method facts without reopening the APK, mapping or engine. */
export const projectAndroidSymbolSummary = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<SummaryAnalysisView>(admitted, "summary");
  if (view === undefined)
    return invalidAnalysisView(
      "Android method Evidence supports summary views.",
    );
  if (parent.operation !== "inspect_android_method")
    return err(
      analysisViewInputError([
        {
          path: ["source", "operation"],
          reason: "invalid_value",
          message:
            "Android method summaries require method inspection Evidence.",
        },
      ]),
    );
  // The engine artifact digest is the JAR; it cannot identify the APK.
  const subject = evidenceSubjectTarget(parent.subject);
  if (subject === undefined)
    return invalidAnalysisViewSubject(
      "Android symbol summaries require the recorded APK subject identity.",
    );
  const shared = {
    kind: "summary" as const,
    view,
    parent_evidence_id: parent.evidenceId,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: subject.path, sha256: subject.sha256 },
    coverage: completeWithinViewCoverage(1),
    limitations: boundedViewLimitations(parent),
    unknowns: [
      "Static class and method analysis does not establish runtime behavior or APK authenticity.",
    ],
  };
  const parsed = readMethod(parent);
  if (!parsed.ok) return parsed;
  return boundedSummary({
    ...shared,
    parent_operation: "inspect_android_method" as const,
    summary: parsed.value,
    unknowns: [
      ...shared.unknowns,
      ...(parsed.value.source === null
        ? [parsed.value.body_unavailable_reason]
        : []),
      ...(parsed.value.source?.status === "partial"
        ? [
            "The selected method source is partial; retained text does not establish a complete method body.",
          ]
        : []),
    ],
  });
};
