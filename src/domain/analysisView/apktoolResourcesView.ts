import { z } from "zod";

import {
  apktoolResultSchemas,
  stringTableSchema,
  type ApktoolDecodeResult,
} from "../apktool/apktoolResourceAnalysis.js";
import { apktoolResourcesViewRequestSchema } from "../apktool/apktoolResourcesQuery.js";
import type { JsonValue } from "../jsonValue.js";
import { isRecord } from "../../kernel/isRecord.js";
import { err, ok } from "../result.js";
import {
  PLACEHOLDER_COVERAGE,
  selectByteBoundedViewRows,
} from "./byteBoundedViewRows.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  analysisTextPage,
  analysisTextPageItemSchema,
} from "./analysisViewText.js";

export const DECODE_ANDROID_RESOURCES_OPERATION =
  "decode_android_resources" as const;

const decodeSchema = apktoolResultSchemas.decode_android_resources;
type ResourcesView = z.output<typeof apktoolResourcesViewRequestSchema>;

/** A decoded table's facts without its string rows, which page separately. */
export const apktoolStringTableSummarySchema = stringTableSchema
  .omit({ strings: true })
  .extend({ returned_count: z.int().nonnegative() });

/** The decode without manifest text or string rows. */
export const apktoolResourcesSummarySchema = decodeSchema
  .omit({ manifest: true, strings: true, string_tables: true })
  .extend({
    manifest: z
      .strictObject({ code_units: z.int().nonnegative() })
      .nullable()
      .describe(
        "The decoded manifest's length in UTF-16 code units, or null when it was not decoded; page it with facet manifest",
      ),
    primary_strings: z.strictObject({
      returned_count: z.int().nonnegative(),
    }),
    string_tables: z.array(apktoolStringTableSummarySchema).optional(),
  });

/** One decoded string with the table it came from. */
export const apktoolStringRowSchema = z.strictObject({
  locale: z.string().nullable(),
  name: z.string().min(1),
  value: z.string(),
});

export const apktoolManifestPageItemSchema = analysisTextPageItemSchema;

const readReport = createAnalysisViewResultReader(decodeSchema);

type StringRow = z.output<typeof apktoolStringRowSchema>;

/**
 * Every decoded string with the table it came from, built once per retained
 * decode. A decode that reported string_tables owns its rows there; otherwise
 * the primary strings are the selected table's.
 */
const decodedRows = new WeakMap<ApktoolDecodeResult, readonly StringRow[]>();
const stringRows = (report: ApktoolDecodeResult): readonly StringRow[] => {
  const known = decodedRows.get(report);
  if (known !== undefined) return known;
  const tables = report.string_tables ?? [
    { locale: report.locale, strings: report.strings },
  ];
  const rows = tables.flatMap((table) =>
    table.strings.map((row) => ({ locale: table.locale, ...row })),
  );
  decodedRows.set(report, rows);
  return rows;
};

/** The decode's own record that it read no strings, when it says so. */
const stringsUnread = (parent: AnalysisViewParent) =>
  isRecord(parent.parameters) && parent.parameters.include_strings === false;

const summarize = (
  report: ApktoolDecodeResult,
): z.output<typeof apktoolResourcesSummarySchema> => {
  const { manifest, strings, string_tables, ...facts } = report;
  return {
    ...facts,
    manifest: manifest === null ? null : { code_units: manifest.length },
    primary_strings: { returned_count: strings.length },
    ...(string_tables === undefined
      ? {}
      : {
          string_tables: string_tables.map(({ strings: rows, ...table }) => ({
            ...table,
            returned_count: rows.length,
          })),
        }),
  };
};

const invalid = (path: string, message: string) =>
  err(
    analysisViewInputError([
      { path: ["view", path], reason: "invalid_value", message },
    ]),
  );

/** One page of string rows across the selected decoded tables. */
const stringsPage = <Shared extends object>(
  parent: AnalysisViewParent,
  report: ApktoolDecodeResult,
  view: Extract<ResourcesView, { facet: "strings" }>,
  shared: Shared,
) => {
  if (stringsUnread(parent))
    return invalid(
      "facet",
      "This decode did not read strings (include_strings false); decode again with include_strings true to page them.",
    );
  const rows = stringRows(report);
  const locales =
    view.locales === undefined ? undefined : new Set(view.locales);
  if (locales !== undefined) {
    const decoded = new Set(
      (report.string_tables ?? [{ locale: report.locale }]).map(
        (table) => table.locale,
      ),
    );
    const missing = [...locales].filter((locale) => !decoded.has(locale));
    if (missing.length > 0)
      return invalid(
        "locales",
        `This decode has no string table for ${missing.map((locale) => JSON.stringify(locale)).join(", ")}; decode those locales first. Decoded tables: ${[...decoded].map((locale) => JSON.stringify(locale)).join(", ")}.`,
      );
  }
  const exact = view.names === undefined ? undefined : new Set(view.names);
  const prefixes = view.name_prefixes;
  const matches =
    locales === undefined && exact === undefined && prefixes === undefined
      ? undefined
      : (row: StringRow) =>
          (locales === undefined || locales.has(row.locale)) &&
          (exact === undefined || exact.has(row.name)) &&
          (prefixes === undefined ||
            prefixes.some((prefix) => row.name.startsWith(prefix)));
  const context = {
    ...shared,
    kind: "android-resources" as const,
    facet: "strings" as const,
    view,
    // Each selected table's own completeness travels with every page.
    tables: (report.string_tables ?? []).flatMap(
      ({ strings: tableRows, ...table }) =>
        locales === undefined || locales.has(table.locale)
          ? [{ ...table, returned_count: tableRows.length }]
          : [],
    ),
    decode_coverage: report.coverage,
  };
  const page = selectByteBoundedViewRows(
    rows,
    view,
    { matches, project: (row) => row },
    {
      parentEvidenceId: parent.evidenceId,
      envelope: {
        ...context,
        items: [],
        byte_limited: false,
        coverage: PLACEHOLDER_COVERAGE,
      } as unknown as JsonValue,
      facet: "strings",
    },
  );
  if (!page.ok) return page;
  return ok({
    ...context,
    items: page.value.rows,
    byte_limited: page.value.byte_limited,
    coverage: pageViewCoverage(
      view.offset,
      page.value.rows.length,
      page.value.total,
    ),
  });
};

/** Project a retained decode's summary, one strings page or one manifest page. */
export const projectApktoolResourcesView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  if (admitted.kind !== "android-resources" && admitted.kind !== "summary")
    return invalid("kind", "Select an android-resources or summary view.");
  assertOwnedView<SummaryAnalysisView | ResourcesView>(
    admitted,
    "summary",
    "android-resources",
  );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: DECODE_ANDROID_RESOURCES_OPERATION,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.target.path, sha256: report.target.sha256 },
    limitations: boundedViewMessages(
      [...parent.limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: [
      "Decoded resources are static declarations; they do not establish which strings or components the app uses at runtime.",
    ],
  };
  if (admitted.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view: admitted,
      summary: summarize(report),
      coverage: completeWithinViewCoverage(1),
    });
  const view = admitted;
  if (view.facet === "manifest") {
    if (report.manifest === null)
      return invalid("facet", "This decode recorded no manifest text.");
    const page = analysisTextPage(
      report.manifest,
      view.offset,
      view.limit,
      "Manifest",
    );
    if (!page.ok) return page;
    return ok({
      ...shared,
      kind: "android-resources" as const,
      facet: "manifest" as const,
      view,
      item: page.value.item,
      coverage: page.value.coverage,
    });
  }
  return stringsPage(parent, report, view, shared);
};
