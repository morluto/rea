import { join } from "node:path";
import { ok, err, type Result } from "../domain/result.js";

import {
  DEFAULT_APKTOOL_STRING_LIMIT,
  DEFAULT_APKTOOL_TOTAL_STRINGS,
  DEFAULT_APKTOOL_STRING_TABLE_BYTES,
  DEFAULT_APKTOOL_TOTAL_STRING_TABLE_BYTES,
  apktoolStringTablesRequested,
  androidLocaleDirectorySuffix,
  type ApktoolRequest,
  type StringTable,
} from "../domain/apktool/apktoolResourceAnalysis.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  parseDecodedStrings,
  type DecodedStringEntry,
} from "./ApktoolDecodeOutput.js";
import type { ApktoolWorkspace } from "./ApktoolWorkspace.js";

type Selection = Pick<
  Extract<ApktoolRequest, { operation: "decode_android_resources" }>["input"],
  | "include_strings"
  | "locale"
  | "locales"
  | "string_tables_only"
  | "string_offset"
  | "string_limit"
  | "max_total_strings"
  | "max_string_table_bytes"
  | "max_total_string_table_bytes"
>;
type PresentTable = {
  readonly status: "present";
  readonly entries: readonly DecodedStringEntry[];
  readonly totalCount: number;
  readonly unparsedCount: number;
};
type UnavailableTable =
  | {
      readonly status: "missing";
      readonly totalCount: 0;
      readonly unparsedCount: 0;
    }
  | {
      readonly status: "oversized";
      readonly totalCount: null;
      readonly unparsedCount: null;
      readonly byteBudget: number;
    }
  | {
      readonly status: "malformed";
      readonly totalCount: null;
      readonly unparsedCount: null;
      readonly message: string;
    };
type PhysicalTable = PresentTable | UnavailableTable;

/** One physical read owns parsed counts independently of output allocation. */
const readTable = async (
  resources: Pick<ApktoolWorkspace, "readText">,
  path: string,
  budget: number,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<{ readonly fact: PhysicalTable; readonly bytes: number }> => {
  const source = await resources.readText(path, budget, signal);
  if (source.text === null)
    return {
      bytes: 0,
      fact: { status: "missing", totalCount: 0, unparsedCount: 0 },
    };
  if (source.truncated)
    return {
      bytes: source.sourceBytes,
      fact: {
        status: "oversized",
        totalCount: null,
        unparsedCount: null,
        byteBudget: budget,
      },
    };
  const bytes = source.sourceBytes;
  const parsed = parseDecodedStrings(source.text);
  if (!parsed.ok)
    return {
      bytes,
      fact: {
        status: "malformed",
        totalCount: null,
        unparsedCount: null,
        message: parsed.error.message,
      },
    };
  return {
    bytes,
    fact: {
      status: "present",
      // Cache only the requested page for aliases. Counts describe the whole
      // examined table, independently of selection and output allocation.
      entries: parsed.value.entries.slice(
        offset,
        offset +
          Math.min(limit, Math.max(0, parsed.value.entries.length - offset)),
      ),
      totalCount: parsed.value.entries.length,
      unparsedCount: parsed.value.unparsedCount,
    },
  };
};

const unavailableTableLimitation = (
  fact: UnavailableTable,
  directory: string,
  locale: string | null,
  input: Selection,
): string => {
  if (fact.status === "missing")
    return locale === null
      ? "No default res/values/strings.xml was found in the decoded workspace"
      : `No strings.xml was found for locale ${locale}`;
  if (fact.status === "oversized")
    return (
      (input.locales === undefined || locale === null
        ? `strings.xml exceeds the ${String(fact.byteBudget)}-byte projection budget`
        : `strings.xml for locale ${locale} exceeds the ${String(fact.byteBudget)}-byte projection budget`) +
      "; raise max_string_table_bytes and max_total_string_table_bytes as needed on the next decode, or select fewer locales. No REA restart is required; decode_timeout_ms does not raise these read budgets."
    );
  return `String table ${JSON.stringify(`res/${directory}/strings.xml`)} could not be projected: ${fact.message}; entry counts are unknown`;
};

export interface ApktoolStringProjection {
  readonly strings: readonly DecodedStringEntry[];
  readonly tables: readonly StringTable[];
  readonly limitations: readonly string[];
  readonly coverage: "complete" | "partial";
}

/** Project caller labels from shared physical facts for both request shapes. */
export const projectApktoolStringTables = async (
  resources: Pick<ApktoolWorkspace, "readText">,
  workspace: string,
  input: Selection,
  signal?: AbortSignal,
): Promise<
  Result<
    ApktoolStringProjection,
    { readonly cause: unknown; readonly partial: ApktoolStringProjection }
  >
> => {
  if (!input.include_strings)
    return ok({
      strings: [],
      tables: [],
      limitations: [],
      coverage: "complete",
    });
  const primary = input.locale ?? null;
  const offset = input.string_offset ?? 0;
  const limit = input.string_limit ?? DEFAULT_APKTOOL_STRING_LIMIT;
  const maxTotalStrings =
    input.max_total_strings ?? DEFAULT_APKTOOL_TOTAL_STRINGS;
  const tableBytes =
    input.max_string_table_bytes ?? DEFAULT_APKTOOL_STRING_TABLE_BYTES;
  const totalTableBytes =
    input.max_total_string_table_bytes ??
    DEFAULT_APKTOOL_TOTAL_STRING_TABLE_BYTES;
  const includeTables = apktoolStringTablesRequested(input);
  const includePage =
    input.string_offset !== undefined ||
    input.string_limit !== undefined ||
    input.max_total_strings !== undefined ||
    input.max_string_table_bytes !== undefined ||
    input.max_total_string_table_bytes !== undefined;
  const locales = [...new Set([primary, ...(input.locales ?? [])])];
  const physical = new Map<string, PhysicalTable>();
  const tables: StringTable[] = [];
  const limitations = new Set<string>();
  let xmlBytes = 0;
  let outputEntries = 0;
  const exhausted = new Set<
    "max_total_strings" | "max_total_string_table_bytes"
  >();
  const projection = (): ApktoolStringProjection => {
    for (const setting of exhausted) {
      const value =
        setting === "max_total_strings" ? maxTotalStrings : totalTableBytes;
      const unit =
        setting === "max_total_strings"
          ? "returned string copies"
          : "XML source bytes";
      const source = input[setting] === undefined ? "default" : "request";
      limitations.add(
        `Aggregate string table projection reached ${setting}=${String(value)} ${unit} (source ${source}). Raise ${setting} or select fewer locales for the next decode. ${setting === "max_total_strings" ? "string_tables_only avoids a duplicate primary copy. " : "max_string_table_bytes independently bounds each XML source read. "}No REA restart is required.`,
      );
    }
    return {
      strings:
        input.string_tables_only === true ? [] : (tables[0]?.strings ?? []),
      tables,
      limitations: [...limitations],
      coverage: tables.some((table) => table.coverage === "partial")
        ? "partial"
        : "complete",
    };
  };
  let pendingIndex = 0;
  try {
    for (const [index, locale] of locales.entries()) {
      pendingIndex = index;
      if (signal?.aborted)
        throw new AnalysisCancelledError("decode_android_resources", {
          cause: signal.reason,
        });
      const directory =
        locale === null
          ? "values"
          : `values-${androidLocaleDirectorySuffix(locale)}`;
      const label =
        locale === null
          ? "default res/values/strings.xml"
          : `res/${directory}/strings.xml`;
      let fact = physical.get(directory);
      if (fact === undefined) {
        const budget = Math.min(tableBytes, totalTableBytes - xmlBytes);
        if (budget <= 0 || outputEntries >= maxTotalStrings) {
          tables.push({
            locale,
            status: "skipped",
            strings: [],
            total_count: null,
            unparsed_count: null,
            coverage: "partial",
          });
          limitations.add(
            `Projection for ${label} skipped: aggregate resource limit reached`,
          );
          if (budget <= 0) exhausted.add("max_total_string_table_bytes");
          if (outputEntries >= maxTotalStrings)
            exhausted.add("max_total_strings");
          continue;
        }
        const read = await readTable(
          resources,
          join(workspace, "res", directory, "strings.xml"),
          budget,
          offset,
          limit,
          signal,
        );
        fact = read.fact;
        xmlBytes += read.bytes;
        if (fact.status === "oversized" && budget < tableBytes)
          exhausted.add("max_total_string_table_bytes");
        physical.set(directory, fact);
      }
      if (fact.status !== "present") {
        tables.push({
          locale,
          status: fact.status,
          strings: [],
          total_count: fact.totalCount,
          unparsed_count: fact.unparsedCount,
          coverage: fact.status === "missing" ? "complete" : "partial",
        });
        limitations.add(
          unavailableTableLimitation(fact, directory, locale, input),
        );
        continue;
      }
      // The default batch shape repeats primary entries in strings and tables;
      // table-only output charges one copy. Account before selecting entries.
      const copies =
        index === 0 && includeTables && input.string_tables_only !== true
          ? 2
          : 1;
      const remaining = Math.max(0, maxTotalStrings - outputEntries);
      const selected = fact.entries.slice(0, Math.floor(remaining / copies));
      outputEntries += selected.length * copies;
      const skipped = selected.length === 0 && fact.entries.length > 0;
      const limited = selected.length < fact.entries.length;
      if (limited) exhausted.add("max_total_strings");
      tables.push({
        locale,
        status: skipped ? "skipped" : "present",
        strings: selected,
        // Output exhaustion cannot erase counts from an already examined table.
        total_count: fact.totalCount,
        unparsed_count: fact.unparsedCount,
        ...(includePage
          ? {
              page: {
                offset,
                limit,
                returned_count: selected.length,
                next_offset:
                  offset < fact.totalCount &&
                  selected.length < fact.totalCount - offset
                    ? offset + selected.length
                    : null,
              },
            }
          : {}),
        coverage:
          selected.length < fact.totalCount || fact.unparsedCount > 0
            ? "partial"
            : "complete",
      });
      if (skipped)
        limitations.add(
          `Projection for ${label} skipped: aggregate resource limit reached`,
        );
      if (fact.unparsedCount > 0)
        limitations.add(
          input.locales === undefined || locale === null
            ? `String entries omitted due to unsupported markup or missing names: ${String(fact.unparsedCount)}`
            : `String entries omitted in locale ${locale} due to unsupported markup or missing names: ${String(fact.unparsedCount)}`,
        );
      if (limited && !skipped)
        limitations.add(
          `Locale ${locale ?? "default"} strings reports ${String(selected.length)} entries due to aggregate strings limit`,
        );
      else if (fact.totalCount > limit && offset === 0 && !skipped)
        limitations.add(
          input.locales === undefined || locale === null
            ? `strings reports the first ${String(selected.length)} of ${String(fact.totalCount)} entries`
            : `Locale ${locale} strings reports the first ${String(selected.length)} of ${String(fact.totalCount)} entries`,
        );
      if (selected.length < fact.totalCount && !skipped)
        limitations.add(
          `String page for ${label} starts at string_offset=${String(offset)} and returns ${String(selected.length)} of ${String(fact.totalCount)} valid entries. ${offset + selected.length < fact.totalCount ? `Continue with string_offset=${String(offset + selected.length)} and the same APK digest and locale;` : "This page reaches the end of the table;"} string_limit=${String(limit)} controls each page and max_total_strings=${String(maxTotalStrings)} controls returned copies. Table coverage describes the entire source table.`,
        );
    }
  } catch (cause) {
    limitations.add(
      `String projection stopped at locale ${JSON.stringify(locales[pendingIndex])}; this selection and ${String(locales.length - pendingIndex - 1)} remaining selections were not projected`,
    );
    return err({ cause, partial: { ...projection(), coverage: "partial" } });
  }
  return ok(projection());
};
