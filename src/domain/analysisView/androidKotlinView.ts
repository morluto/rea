import { z } from "zod";
import { androidResultSchemas } from "../android/androidAnalysis.js";
import { androidKotlinClassSchema } from "../android/androidKotlinMetadata.js";
import {
  androidKotlinViewItemsSchema,
  androidKotlinViewRequestSchema,
} from "../android/androidKotlinQuery.js";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import type { JsonValue } from "../jsonValue.js";
import { jsonValueByteLength } from "../jsonValueByteLength.js";
import { err, ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  ANALYSIS_VIEW_PAGE_BUDGET_RECOVERY,
  analysisViewInputError,
} from "./analysisViewErrors.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import {
  analysisViewCoverageSchema,
  boundedViewMessages,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { selectViewRows } from "./selectViewRows.js";

const reportSchema = androidResultSchemas.inspect_android_kotlin_metadata;
const readReport = createAnalysisViewResultReader(reportSchema);
const SUMMARY_ROWS = 64;

/** Whole-APK histograms plus a bounded preview; every retained row stays pageable. */
export const androidKotlinSummarySchema = reportSchema
  .pick({
    engine: true,
    coverage: true,
    versions: true,
    kinds: true,
    matching_classes: true,
    markers: true,
  })
  .extend({
    retained_classes: z.int().nonnegative(),
    classes: z.array(androidKotlinClassSchema),
    class_coverage: analysisViewCoverageSchema,
  });

/** Source facts are already parsed; views never reopen the APK or rerun the DEX reader. */
export const projectAndroidKotlinView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (
    parent.operation !== "inspect_android_kotlin_metadata" ||
    (view.kind !== "summary" && view.kind !== "android-kotlin")
  )
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Kotlin metadata Evidence supports summary or android-kotlin class pages.",
        },
      ]),
    );
  assertOwnedView<
    SummaryAnalysisView | z.output<typeof androidKotlinViewRequestSchema>
  >(view, "summary", "android-kotlin");
  // The engine artifact digest is the JAR; it cannot identify the APK.
  if (parent.subject == null)
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message:
            "Kotlin metadata views require the recorded APK subject identity.",
        },
      ]),
    );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const shared = {
    parent_operation: "inspect_android_kotlin_metadata" as const,
    parent_evidence_id: parent.evidenceId,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: parent.subject.local_path,
      sha256: parent.subject.digest.sha256,
    },
    limitations: boundedViewMessages(
      parent.limitations,
      parent.evidenceId,
      "limitations",
    ),
    unknowns: boundedViewMessages(
      report.unknowns,
      parent.evidenceId,
      "unknowns",
    ),
  };
  const overBudget = (value: object): boolean =>
    jsonValueByteLength(value as unknown as JsonValue, 1024 * 1024 - 128) >
    1024 * 1024 - 128;
  const budgetError = () =>
    err(
      new AnalysisResourceConstraintError(
        "inspect_analysis_view",
        "transport",
        "Kotlin metadata view exceeds its 1 MiB serialized allowance.",
        { parent_evidence_id: parent.evidenceId, limit_bytes: 1024 * 1024 },
        ANALYSIS_VIEW_PAGE_BUDGET_RECOVERY,
      ),
    );
  if (view.kind === "summary") {
    const classes = report.classes.slice(0, SUMMARY_ROWS);
    const summary = {
      ...shared,
      kind: "summary" as const,
      view,
      coverage: pageViewCoverage(0, classes.length, report.classes.length),
      summary: {
        engine: report.engine,
        coverage: report.coverage,
        versions: report.versions,
        kinds: report.kinds,
        matching_classes: report.matching_classes,
        markers: report.markers,
        retained_classes: report.classes.length,
        classes,
        class_coverage: pageViewCoverage(
          0,
          classes.length,
          report.classes.length,
        ),
      },
    };
    if (overBudget(summary)) return budgetError();
    return ok(summary);
  }
  const indices =
    view.indices === undefined ? undefined : new Set(view.indices);
  const names =
    view.class_names === undefined ? undefined : new Set(view.class_names);
  const kinds = view.kinds === undefined ? undefined : new Set(view.kinds);
  const fields =
    view.fields === undefined ? undefined : new Set<string>(view.fields);
  const selected = selectViewRows(
    report.classes,
    view,
    (row, index) =>
      (indices === undefined || indices.has(index)) &&
      (names === undefined || names.has(row.class_name)) &&
      (view.package_prefix === undefined ||
        row.class_name.startsWith(view.package_prefix)) &&
      (kinds === undefined || (row.kind !== undefined && kinds.has(row.kind))),
    (row, index) =>
      fields === undefined
        ? { ...row, row_index: index }
        : {
            ...Object.fromEntries(
              Object.entries(row).filter(([key]) => fields.has(key)),
            ),
            row_index: index,
          },
  );
  const page = {
    ...shared,
    kind: "android-kotlin" as const,
    view,
    source: {
      coverage: report.coverage,
      matching_classes: report.matching_classes,
      retained_classes: report.classes.length,
    },
    items: androidKotlinViewItemsSchema.parse(selected.rows),
    coverage: pageViewCoverage(
      view.offset,
      selected.rows.length,
      selected.total,
    ),
  };
  if (overBudget(page)) return budgetError();
  return ok(page);
};
