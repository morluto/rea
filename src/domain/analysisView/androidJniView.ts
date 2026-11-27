import { z } from "zod";
import { androidResultSchemas } from "../android/androidAnalysis.js";
import {
  androidJniBindingSchema,
  androidJniCandidateSchema,
  androidJniDeclarationSchema,
  androidJniLibrarySchema,
} from "../android/androidJniBindings.js";
import {
  androidJniViewItemsSchema,
  androidJniViewRequestSchema,
} from "../android/androidJniQuery.js";
import { boundedList } from "../boundedList.js";
import type { JsonValue } from "../jsonValue.js";
import { jsonValueByteLength } from "../jsonValueByteLength.js";
import { ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  ANALYSIS_VIEW_PAGE_BYTES as PAGE_BYTES,
  analysisViewPageTooLarge,
  invalidAnalysisView,
} from "./analysisViewErrors.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import {
  boundedViewMessages,
  pageViewCoverage,
  analysisViewCoverageSchema,
} from "./analysisViewCoverage.js";
import { selectIndexedViewRows, selectViewRows } from "./selectViewRows.js";

const reportSchema = androidResultSchemas.inspect_android_jni_bindings;
const readReport = createAnalysisViewResultReader(reportSchema);
/** A bounded relation closure; preview coverage counts selected binding rows only. */
export const androidJniSummarySchema = reportSchema
  .pick({
    engine: true,
    apk: true,
    selection: true,
    native_inventory: true,
    library_inventory: true,
  })
  .extend({
    counts: z.strictObject({
      declarations: z.int().nonnegative(),
      selected_declarations: z.int().nonnegative(),
      libraries: z.int().nonnegative(),
      candidates: z.int().nonnegative(),
      bindings: z.int().nonnegative(),
      matched: z.int().nonnegative(),
      unmatched: z.int().nonnegative(),
      ambiguous: z.int().nonnegative(),
      unknown: z.int().nonnegative(),
    }),
    bindings: z.array(androidJniBindingSchema),
    declarations: z.array(androidJniDeclarationSchema),
    candidates: z.array(androidJniCandidateSchema),
    libraries: z.array(androidJniLibrarySchema),
    /** Libraries the summary lists; page collection libraries for the rest. */
    library_coverage: analysisViewCoverageSchema,
    selected_declaration_ids: z.array(z.string()),
    declaration_coverage: analysisViewCoverageSchema,
  });

/** Rows of each collection the summary previews at most. */
const SUMMARY_PREVIEW = 16;
/**
 * Serialized bytes the previews may use, so a summary stays within the
 * default agent result budget. A binding counts with the candidates and
 * declarations it brings in: one registration candidate can name hundreds
 * of same-signature declarations. Collection pages read the rest.
 */
const PREVIEW_BYTES = { relations: 16 * 1024, libraries: 8 * 1024 } as const;

type JniReport = z.output<typeof reportSchema>;

const rowBytes = (row: object): number =>
  jsonValueByteLength(row as unknown as JsonValue);

/** Leading rows within the preview's count and byte allowance. */
const previewRows = <Row extends object>(
  rows: readonly Row[],
  bytes: number,
): Row[] => {
  const kept: Row[] = [];
  let used = 0;
  for (const row of boundedList(rows, SUMMARY_PREVIEW).items) {
    used += rowBytes(row);
    if (used > bytes) break;
    kept.push(row);
  }
  return kept;
};

/**
 * The selected declaration IDs and leading bindings the relation allowance
 * admits, each with the declarations and candidates it adds to the closure.
 */
const previewRelations = (report: JniReport) => {
  const declarations = new Map(
    report.declarations.map((row) => [row.declaration_id, row]),
  );
  const candidates = new Map(
    report.candidates.map((row) => [row.candidate_id, row]),
  );
  const declarationIds = new Set<string>();
  const candidateIds = new Set<string>();
  let used = 0;
  /** Admit one row and its new relations, or report that it does not fit. */
  const admit = (
    row: object,
    newCandidates: readonly string[],
    newDeclarations: readonly string[],
  ): boolean => {
    let added = rowBytes(row);
    const addedCandidates = newCandidates.filter((id) => !candidateIds.has(id));
    for (const id of addedCandidates) {
      const candidate = candidates.get(id);
      if (candidate !== undefined) added += rowBytes(candidate);
    }
    const addedDeclarations = new Set(
      [
        ...newDeclarations,
        ...addedCandidates.flatMap(
          (id) => candidates.get(id)?.declaration_ids ?? [],
        ),
      ].filter((id) => !declarationIds.has(id)),
    );
    for (const id of addedDeclarations) {
      const declaration = declarations.get(id);
      if (declaration !== undefined) added += rowBytes(declaration);
    }
    if (used + added > PREVIEW_BYTES.relations) return false;
    used += added;
    for (const id of addedCandidates) candidateIds.add(id);
    for (const id of addedDeclarations) declarationIds.add(id);
    return true;
  };
  const selectedIds: string[] = [];
  for (const id of boundedList(report.selected_declaration_ids, SUMMARY_PREVIEW)
    .items) {
    if (!admit({ id }, [], [id])) break;
    selectedIds.push(id);
  }
  const bindings: JniReport["bindings"] = [];
  for (const binding of boundedList(report.bindings, SUMMARY_PREVIEW).items) {
    if (!admit(binding, binding.candidate_ids, [binding.declaration_id])) break;
    bindings.push(binding);
  }
  return {
    selectedIds,
    bindings,
    candidates: report.candidates.filter((row) =>
      candidateIds.has(row.candidate_id),
    ),
    declarations: report.declarations.filter((row) =>
      declarationIds.has(row.declaration_id),
    ),
  };
};

/** Source facts are already parsed; views never reopen the APK or rerun either reader. */
export const projectAndroidJniView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (
    parent.operation !== "inspect_android_jni_bindings" ||
    (view.kind !== "summary" && view.kind !== "android-jni")
  )
    return invalidAnalysisView(
      "JNI Evidence supports summary or android-jni collection pages.",
    );
  assertOwnedView<
    SummaryAnalysisView | z.output<typeof androidJniViewRequestSchema>
  >(view, "summary", "android-jni");
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const shared = {
    parent_operation: "inspect_android_jni_bindings" as const,
    parent_evidence_id: parent.evidenceId,
    parent_digest: parent.evidenceId.slice(3),
    artifact: report.apk,
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
    jsonValueByteLength(value as unknown as JsonValue, PAGE_BYTES - 128) >
    PAGE_BYTES - 128;
  const budgetError = () =>
    analysisViewPageTooLarge(
      parent.evidenceId,
      "JNI view exceeds its 1 MiB serialized allowance.",
    );
  if (view.kind === "summary") {
    const { selectedIds, bindings, candidates, declarations } =
      previewRelations(report);
    const libraries = previewRows(report.libraries, PREVIEW_BYTES.libraries);
    const counts = {
      declarations: report.declarations.length,
      selected_declarations: report.selected_declaration_ids.length,
      libraries: report.libraries.length,
      candidates: report.candidates.length,
      bindings: report.bindings.length,
      matched: 0,
      unmatched: 0,
      ambiguous: 0,
      unknown: 0,
    };
    for (const binding of report.bindings) counts[binding.status]++;
    const summary = {
      ...shared,
      kind: "summary" as const,
      view,
      coverage: pageViewCoverage(0, bindings.length, report.bindings.length),
      summary: {
        engine: report.engine,
        apk: report.apk,
        selection: report.selection,
        native_inventory: report.native_inventory,
        library_inventory: report.library_inventory,
        counts,
        bindings,
        candidates,
        declarations,
        libraries,
        library_coverage: pageViewCoverage(
          0,
          libraries.length,
          report.libraries.length,
        ),
        selected_declaration_ids: selectedIds,
        declaration_coverage: pageViewCoverage(
          0,
          selectedIds.length,
          report.selected_declaration_ids.length,
        ),
      },
    };
    if (overBudget(summary)) return budgetError();
    return ok(summary);
  } else {
    const indices =
      view.indices === undefined ? undefined : new Set(view.indices);
    const fields =
      view.fields === undefined ? undefined : new Set<string>(view.fields);
    const project = <Row extends object>(row: Row, index: number) =>
      fields === undefined
        ? { ...row, row_index: index }
        : {
            ...Object.fromEntries(
              Object.entries(row).filter(([key]) => fields.has(key)),
            ),
            row_index: index,
          };
    const pick = <Row extends object>(
      rows: readonly Row[],
      matches: (row: Row) => boolean,
    ) =>
      indices !== undefined
        ? selectIndexedViewRows(rows, indices, view, matches, project)
        : selectViewRows(rows, view, matches, project);
    const set = (values: readonly string[] | undefined) =>
      values === undefined ? undefined : new Set(values);
    let selected: { rows: object[]; total: number };
    switch (view.collection) {
      case "declarations": {
        const classes = set(view.class_names),
          names = set(view.method_names),
          ids = set(view.declaration_ids),
          descriptors = set(view.descriptors);
        selected = pick(
          report.declarations,
          (row) =>
            (classes === undefined || classes.has(row.class_name)) &&
            (names === undefined || names.has(row.method_name)) &&
            (ids === undefined || ids.has(row.declaration_id)) &&
            (descriptors === undefined || descriptors.has(row.descriptor)),
        );
        break;
      }
      case "libraries": {
        const ids = set(view.library_ids),
          abis = set(view.abis);
        selected = pick(
          report.libraries,
          (row) =>
            (ids === undefined || ids.has(row.library_id)) &&
            (abis === undefined || abis.has(row.abi)),
        );
        break;
      }
      case "candidates": {
        const ids = set(view.declaration_ids),
          libs = set(view.library_ids),
          candidates = set(view.candidate_ids);
        selected = pick(
          report.candidates,
          (row) =>
            (ids === undefined ||
              row.declaration_ids.some((id) => ids.has(id))) &&
            (libs === undefined || libs.has(row.library_id)) &&
            (candidates === undefined || candidates.has(row.candidate_id)),
        );
        break;
      }
      case "bindings": {
        const ids = set(view.declaration_ids),
          abis = set(view.abis),
          statuses = set(view.statuses);
        selected = pick(
          report.bindings,
          (row) =>
            (ids === undefined || ids.has(row.declaration_id)) &&
            (abis === undefined || abis.has(row.abi)) &&
            (statuses === undefined || statuses.has(row.status)),
        );
        break;
      }
    }
    const source = {
      native_inventory: report.native_inventory,
      library_inventory: report.library_inventory,
      selection: report.selection,
    };
    const page = {
      ...shared,
      kind: "android-jni" as const,
      view,
      source,
      items: androidJniViewItemsSchema.parse(selected.rows),
      coverage: pageViewCoverage(
        view.offset,
        selected.rows.length,
        selected.total,
      ),
    };
    if (overBudget(page)) return budgetError();
    return ok(page);
  }
};
