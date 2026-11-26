import { analysisViewPageFields } from "./analysisViewPageFields.js";
import { z } from "zod";
import {
  nativeExportsSchema,
  peNativeExportsSchema as pe,
  elfNativeExportsSchema as elf,
  type NativeExports,
} from "../native/nativeExports.js";
import { ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { invalidAnalysisView } from "./analysisViewErrors.js";
import { namePrefixesSchema, startsWithAny } from "./namePrefixFilter.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import {
  pickFields,
  selectIndexedViewRows,
  selectViewRows,
} from "./selectViewRows.js";

const peRow = pe.shape.exports.element;
const elfRow = elf.shape.exports.element;
const issue = pe.shape.issues.element;
const sourceIndex = { source_index: z.int().nonnegative() };
const page = analysisViewPageFields("native-exports");

/** Exact names preserve all versions/aliases; indices are scoped to the complete parent. */
export const nativeExportsViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      ...page,
      collection: z.literal("exports"),
      names: z
        .array(z.string())
        .optional()
        .describe(
          "Exact PE names, or UTF-8 ELF source names. ELF display fallbacks and names with unknown encoding are not identities; use indices for those rows. Omitted includes all names; [] matches none.",
        ),
      name_prefixes: namePrefixesSchema(
        "PE names or UTF-8 ELF source names; ELF names that are not valid UTF-8 never match",
      ),
      indices: z.array(z.int().nonnegative()).optional(),
      fields: z.array(z.union([peRow.keyof(), elfRow.keyof()])).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("issues"),
      indices: z.array(z.int().nonnegative()).optional(),
    }),
  ],
);

export const nativeExportsViewItemsSchema = z.union([
  z.array(peRow.partial().extend(sourceIndex)),
  z.array(elfRow.partial().extend(sourceIndex)),
  z.array(issue.extend(sourceIndex)),
]);

const counts = {
  export_count: z.int().nonnegative(),
  issue_count: z.int().nonnegative(),
  limitation_count: z.int().nonnegative(),
};
/** Source coverage remains distinct from page coverage, including an empty partial page. */
export const nativeExportsSummarySchema = z.discriminatedUnion("format", [
  pe.omit({ exports: true, issues: true, limitations: true }).extend(counts),
  elf.omit({ exports: true, issues: true, limitations: true }).extend(counts),
]);

const readReport = createAnalysisViewResultReader(nativeExportsSchema);

type ExportRow = NativeExports["exports"][number];

/**
 * Match exact names and name prefixes with the identity rules of each format.
 * ELF identities are bytes: a non-ASCII name compares its exact UTF-8 bytes,
 * and a name that is not valid UTF-8 has no text to match.
 */
const exportNameMatcher = (
  selectedNames: readonly string[] | undefined,
  prefixes: readonly string[] | undefined,
): ((row: ExportRow) => boolean) | undefined => {
  if (selectedNames === undefined && prefixes === undefined) return undefined;
  const names =
    selectedNames === undefined ? undefined : new Set(selectedNames);
  const encodedNames =
    names === undefined
      ? undefined
      : new Set(
          [...names].flatMap((name) => {
            const bytes = Buffer.from(name, "utf8");
            return bytes.toString("utf8") === name
              ? [bytes.toString("base64")]
              : [];
          }),
        );
  // As for exact names, text that does not round-trip through UTF-8 (an
  // unpaired surrogate) has no bytes to compare and matches nothing.
  const prefixBytes = prefixes?.flatMap((prefix) => {
    const bytes = Buffer.from(prefix, "utf8");
    return bytes.toString("utf8") === prefix ? [bytes] : [];
  });
  const exact = (row: ExportRow): boolean =>
    names === undefined ||
    ("name_utf8_decodable" in row
      ? row.name_utf8_decodable &&
        (row.name_bytes_base64 !== null
          ? encodedNames!.has(row.name_bytes_base64)
          : names.has(row.name))
      : row.name !== null && names.has(row.name));
  const prefixed = (row: ExportRow): boolean => {
    if (prefixes === undefined) return true;
    if (!("name_utf8_decodable" in row))
      return row.name !== null && startsWithAny(row.name, prefixes);
    if (!row.name_utf8_decodable) return false;
    if (row.name_bytes_base64 === null)
      return startsWithAny(row.name, prefixes);
    const bytes = Buffer.from(row.name_bytes_base64, "base64");
    return prefixBytes!.some(
      (prefix) =>
        bytes.length >= prefix.length &&
        bytes.subarray(0, prefix.length).equals(prefix),
    );
  };
  return (row) => exact(row) && prefixed(row);
};

/** Read selected export facts without reopening the artifact or reinterpreting its tables. */
export const projectNativeExportsView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (view.kind !== "summary" && view.kind !== "native-exports")
    return invalidAnalysisView(
      "Native export Evidence supports summary and native-exports views.",
    );
  assertOwnedView<
    SummaryAnalysisView | z.output<typeof nativeExportsViewRequestSchema>
  >(view, "summary", "native-exports");
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const { exports, issues, limitations, ...identity } = report;
  const summary = {
    ...identity,
    export_count: exports.length,
    issue_count: issues.length,
    limitation_count: limitations.length,
  };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_native_exports" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    limitations: boundedViewMessages(
      [...parent.limitations, ...limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns:
      report.coverage.status === "complete"
        ? []
        : [
            report.coverage.reason ??
              "Export-table coverage is incomplete; no-match pages do not prove absence.",
          ],
  };
  if (view.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view,
      summary,
      coverage: completeWithinViewCoverage(exports.length),
    });
  const indices =
    view.indices === undefined ? undefined : new Set(view.indices);
  if (view.collection === "issues") {
    const selected =
      indices === undefined
        ? selectViewRows(issues, view, undefined, (row, source_index) => ({
            ...row,
            source_index,
          }))
        : selectIndexedViewRows(
            issues,
            indices,
            view,
            undefined,
            (row, source_index) => ({ ...row, source_index }),
          );
    return ok({
      ...shared,
      kind: "native-exports" as const,
      view,
      exports: summary,
      items: selected.rows,
      coverage: pageViewCoverage(
        view.offset,
        selected.rows.length,
        selected.total,
      ),
    });
  }
  const allowed =
    report.format === "pe" ? peRow.keyof().options : elfRow.keyof().options;
  const fields =
    view.fields === undefined ? allowed : [...new Set(view.fields)];
  const allowedFields: readonly string[] = allowed;
  if (fields.some((field) => !allowedFields.includes(field)))
    return invalidAnalysisView(
      `Selected export fields do not belong to ${report.format}; available fields: ${allowed.join(", ")}.`,
    );
  // A projected decoded name still carries its exact bytes and encoding qualification.
  const columns = new Set<string>(fields);
  if (report.format === "elf" && columns.has("name")) {
    columns.add("name_bytes_base64");
    columns.add("name_utf8_decodable");
  }
  const rows: readonly NativeExports["exports"][number][] = exports;
  const projectRow = (
    row: NativeExports["exports"][number],
    source_index: number,
  ) => ({
    ...pickFields(row, columns),
    source_index,
  });
  const matchesName = exportNameMatcher(view.names, view.name_prefixes);
  const selected =
    indices !== undefined
      ? selectIndexedViewRows(rows, indices, view, matchesName, projectRow)
      : selectViewRows(rows, view, matchesName, projectRow);
  return ok({
    ...shared,
    kind: "native-exports" as const,
    view,
    exports: summary,
    items: selected.rows,
    coverage: pageViewCoverage(
      view.offset,
      selected.rows.length,
      selected.total,
    ),
  });
};
