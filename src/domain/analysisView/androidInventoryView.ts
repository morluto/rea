import { z } from "zod";
import { androidResultSchemas } from "../android/androidAnalysis.js";
import {
  androidClassesViewItemsSchema,
  androidClassesViewRequestSchema,
  androidReferencesViewItemsSchema,
  androidReferencesViewRequestSchema,
} from "../android/androidInventoryQuery.js";
import { androidReferenceSchema } from "../android/androidReferenceSchemas.js";
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

const classesSchema = androidResultSchemas.search_android_classes;
const referencesSchema = androidResultSchemas.trace_android_references;
const readClasses = createAnalysisViewResultReader(classesSchema);
const readReferences = createAnalysisViewResultReader(referencesSchema);
/** Rows previewed by a summary; every retained row stays pageable. */
const PREVIEW_ROWS = 64;
/** Groups shown in a derived histogram; the rest is counted, not listed. */
const HISTOGRAM_ROWS = 20;
const PAGE_BYTES = 1024 * 1024;

const rowIndexSchema = z.int().nonnegative();
const previewReferenceSchema = androidReferenceSchema
  .partial()
  .extend({ row_index: rowIndexSchema });

/** Whole-APK counts, a derived package histogram and a bounded preview of the names. */
export const androidClassesSummarySchema = classesSchema
  .pick({ engine: true, query: true, total_classes: true, coverage: true })
  .extend({
    counts: z.strictObject({
      matches: z.int().nonnegative(),
      duplicate_names: z.int().nonnegative(),
    }),
    /** Derived from the retained names: classes per leading two package segments. */
    packages: z.strictObject({
      depth: z.literal(2),
      total_prefixes: z.int().nonnegative(),
      top: z.array(
        z.strictObject({ prefix: z.string(), classes: z.int().positive() }),
      ),
    }),
    matches: z.array(z.string()),
    duplicate_names: classesSchema.shape.duplicate_names,
    match_coverage: analysisViewCoverageSchema,
    duplicate_coverage: analysisViewCoverageSchema,
  });

/** Whole-trace counts, derived histograms and a bounded preview without raw invokes. */
export const androidReferencesSummarySchema = referencesSchema
  .pick({
    engine: true,
    target_definition: true,
    reference_scope: true,
    class_name: true,
    method_name: true,
    overload_index: true,
    reported_signature: true,
    dex_descriptor: true,
    total: true,
    direct_invokes_coverage: true,
    coverage: true,
    reference_unit: true,
  })
  .extend({
    counts: z.strictObject({ references: z.int().nonnegative() }),
    /** Derived from the retained rows: using nodes per provider node kind. */
    kinds: z.array(
      z.strictObject({ kind: z.string(), references: z.int().positive() }),
    ),
    /** Derived from the retained rows: using nodes per top-level class. */
    top_classes: z.strictObject({
      total_top_classes: z.int().nonnegative(),
      top: z.array(
        z.strictObject({
          top_class: z.string(),
          references: z.int().positive(),
        }),
      ),
    }),
    /** Preview rows omit `direct_invokes`; select it with a page's `fields`. */
    references: z.array(previewReferenceSchema),
    reference_coverage: analysisViewCoverageSchema,
  });

const overBudget = (value: object): boolean =>
  jsonValueByteLength(value as unknown as JsonValue, PAGE_BYTES - 128) >
  PAGE_BYTES - 128;

const budgetError = (parentEvidenceId: string, what: string) =>
  err(
    new AnalysisResourceConstraintError(
      "inspect_analysis_view",
      "transport",
      `${what} view exceeds its 1 MiB serialized allowance.`,
      { parent_evidence_id: parentEvidenceId, limit_bytes: PAGE_BYTES },
      ANALYSIS_VIEW_PAGE_BUDGET_RECOVERY,
    ),
  );

/** Descending count, then exact key order, so equal histograms are byte-identical. */
const histogram = (
  keys: Iterable<string>,
): { readonly key: string; readonly count: number }[] => {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
    );
};

const packagePrefix = (name: string): string =>
  name.split(".").slice(0, 2).join(".");

const identity = (parent: AnalysisViewParent, subject: string) => {
  // The engine artifact digest is the JAR; it cannot identify the APK.
  if (parent.subject == null)
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message: `${subject} views require the recorded APK subject identity.`,
        },
      ]),
    );
  return ok({
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
  });
};

const projectFields =
  (fields: ReadonlySet<string> | undefined) =>
  <Row extends object>(row: Row, index: number) =>
    fields === undefined
      ? { ...row, row_index: index }
      : {
          ...Object.fromEntries(
            Object.entries(row).filter(([key]) => fields.has(key)),
          ),
          row_index: index,
        };

/** Source facts are already parsed; views never reopen the APK or rerun the decompiler. */
export const projectAndroidClassesView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (
    parent.operation !== "search_android_classes" ||
    (view.kind !== "summary" && view.kind !== "android-classes")
  )
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Android class search Evidence supports summary or android-classes pages.",
        },
      ]),
    );
  assertOwnedView<
    SummaryAnalysisView | z.output<typeof androidClassesViewRequestSchema>
  >(view, "summary", "android-classes");
  const shared = identity(parent, "Android class search");
  if (!shared.ok) return shared;
  const parsed = readClasses(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const base = {
    ...shared.value,
    parent_operation: "search_android_classes" as const,
    unknowns: [
      "Rows are decompiler display names of top-level classes; they do not identify which same-name class node a later lookup selects and omit classes the decompiler nests.",
    ],
  };
  if (view.kind === "summary") {
    const matches = report.matches.slice(0, PREVIEW_ROWS);
    const duplicates = report.duplicate_names.slice(0, PREVIEW_ROWS);
    const prefixes = histogram(report.matches.map(packagePrefix));
    const summary = {
      ...base,
      kind: "summary" as const,
      view,
      coverage: pageViewCoverage(0, matches.length, report.matches.length),
      summary: {
        engine: report.engine,
        query: report.query,
        total_classes: report.total_classes,
        coverage: report.coverage,
        counts: {
          matches: report.matches.length,
          duplicate_names: report.duplicate_names.length,
        },
        packages: {
          depth: 2 as const,
          total_prefixes: prefixes.length,
          top: prefixes
            .slice(0, HISTOGRAM_ROWS)
            .map(({ key, count }) => ({ prefix: key, classes: count })),
        },
        matches,
        duplicate_names: duplicates,
        match_coverage: pageViewCoverage(
          0,
          matches.length,
          report.matches.length,
        ),
        duplicate_coverage: pageViewCoverage(
          0,
          duplicates.length,
          report.duplicate_names.length,
        ),
      },
    };
    return overBudget(summary)
      ? budgetError(parent.evidenceId, "Android class search")
      : ok(summary);
  }
  const indices =
    view.indices === undefined ? undefined : new Set(view.indices);
  const names =
    view.class_names === undefined ? undefined : new Set(view.class_names);
  const prefix =
    view.collection === "matches" ? view.package_prefix : undefined;
  const selected =
    view.collection === "matches"
      ? selectViewRows(
          report.matches,
          view,
          (name, index) =>
            (indices === undefined || indices.has(index)) &&
            (names === undefined || names.has(name)) &&
            (prefix === undefined || name.startsWith(prefix)),
          (name, index) => ({ name, row_index: index }),
        )
      : selectViewRows(
          report.duplicate_names,
          view,
          (row, index) =>
            (indices === undefined || indices.has(index)) &&
            (names === undefined || names.has(row.name)),
          (row, index) => ({ ...row, row_index: index }),
        );
  const page = {
    ...base,
    kind: "android-classes" as const,
    view,
    source: {
      query: report.query,
      total_classes: report.total_classes,
      coverage: report.coverage,
      matches: report.matches.length,
      duplicate_names: report.duplicate_names.length,
    },
    items: androidClassesViewItemsSchema.parse(selected.rows),
    coverage: pageViewCoverage(
      view.offset,
      selected.rows.length,
      selected.total,
    ),
  };
  return overBudget(page)
    ? budgetError(parent.evidenceId, "Android class search")
    : ok(page);
};

/** Source facts are already parsed; views never reopen the APK or rerun the decompiler. */
export const projectAndroidReferencesView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (
    parent.operation !== "trace_android_references" ||
    (view.kind !== "summary" && view.kind !== "android-references")
  )
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Android reference trace Evidence supports summary or android-references pages.",
        },
      ]),
    );
  assertOwnedView<
    SummaryAnalysisView | z.output<typeof androidReferencesViewRequestSchema>
  >(view, "summary", "android-references");
  const shared = identity(parent, "Android reference trace");
  if (!shared.ok) return shared;
  const parsed = readReferences(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const base = {
    ...shared.value,
    parent_operation: "trace_android_references" as const,
    unknowns: [
      "Using nodes are static direct references; they do not establish reflection, dynamic dispatch or runtime behavior.",
    ],
  };
  if (view.kind === "summary") {
    const preview = report.references
      .slice(0, PREVIEW_ROWS)
      .map(({ direct_invokes: _omitted, ...row }, index) => ({
        ...row,
        row_index: index,
      }));
    const kinds = histogram(report.references.map((row) => row.kind));
    const topClasses = histogram(report.references.map((row) => row.top_class));
    const summary = {
      ...base,
      unknowns: [
        ...base.unknowns,
        "Preview rows omit direct_invokes; read them with a page that selects that field.",
      ],
      kind: "summary" as const,
      view,
      coverage: pageViewCoverage(0, preview.length, report.references.length),
      summary: {
        engine: report.engine,
        ...(report.target_definition === undefined
          ? {}
          : { target_definition: report.target_definition }),
        ...(report.reference_scope === undefined
          ? {}
          : { reference_scope: report.reference_scope }),
        class_name: report.class_name,
        method_name: report.method_name,
        overload_index: report.overload_index,
        reported_signature: report.reported_signature,
        dex_descriptor: report.dex_descriptor,
        total: report.total,
        ...(report.direct_invokes_coverage === undefined
          ? {}
          : { direct_invokes_coverage: report.direct_invokes_coverage }),
        coverage: report.coverage,
        reference_unit: report.reference_unit,
        counts: { references: report.references.length },
        kinds: kinds.map(({ key, count }) => ({
          kind: key,
          references: count,
        })),
        top_classes: {
          total_top_classes: topClasses.length,
          top: topClasses.slice(0, HISTOGRAM_ROWS).map(({ key, count }) => ({
            top_class: key,
            references: count,
          })),
        },
        references: preview,
        reference_coverage: pageViewCoverage(
          0,
          preview.length,
          report.references.length,
        ),
      },
    };
    return overBudget(summary)
      ? budgetError(parent.evidenceId, "Android reference trace")
      : ok(summary);
  }
  const indices =
    view.indices === undefined ? undefined : new Set(view.indices);
  const kinds = view.kinds === undefined ? undefined : new Set(view.kinds);
  const containing =
    view.containing_classes === undefined
      ? undefined
      : new Set(view.containing_classes);
  const tops =
    view.top_classes === undefined ? undefined : new Set(view.top_classes);
  const fields =
    view.fields === undefined ? undefined : new Set<string>(view.fields);
  const selected = selectViewRows(
    report.references,
    view,
    (row, index) =>
      (indices === undefined || indices.has(index)) &&
      (kinds === undefined || kinds.has(row.kind)) &&
      (containing === undefined || containing.has(row.containing_class)) &&
      (tops === undefined || tops.has(row.top_class)),
    projectFields(fields),
  );
  const page = {
    ...base,
    kind: "android-references" as const,
    view,
    source: {
      class_name: report.class_name,
      method_name: report.method_name,
      overload_index: report.overload_index,
      total: report.total,
      coverage: report.coverage,
      reference_unit: report.reference_unit,
    },
    items: androidReferencesViewItemsSchema.parse(selected.rows),
    coverage: pageViewCoverage(
      view.offset,
      selected.rows.length,
      selected.total,
    ),
  };
  return overBudget(page)
    ? budgetError(parent.evidenceId, "Android reference trace")
    : ok(page);
};
