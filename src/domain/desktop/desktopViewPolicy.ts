import { z } from "zod";
import { MAX_JSON_DEPTH } from "../jsonValue.js";
import { SQLITE_DATABASE_OUTPUT_BYTES } from "../sqlite/sqliteDatabase.js";

// The deepest supported view is a ZIP member in a captured version. Nested
// archives are not interpreted. Count every enclosing property/array member
// from the complete Evidence record to that member's view.
const VIEW_ENVELOPE_DEPTH = [
  "normalized_result",
  "paths",
  0,
  "versions",
  0,
  "view",
  "entries",
  0,
  "view",
].length;
export const MAX_DESKTOP_JSON_VIEW_DEPTH = MAX_JSON_DEPTH - VIEW_ENVELOPE_DEPTH;
// XML projects an element to {root:{attributes:{key:value},children:[...]}}:
// root + attribute dictionary/value add three levels; each element child adds two.
export const MAX_DESKTOP_XML_VIEW_DEPTH = Math.floor(
  (MAX_JSON_DEPTH - VIEW_ENVELOPE_DEPTH - 3) / 2,
);

/** Admission and retention for one desktop state view, shared with exported readers. */
export const DESKTOP_VIEW_DEFAULTS = {
  file_bytes: 64 * 1024 * 1024,
  sqlite_tables: 64,
  sqlite_rows: 500,
  sqlite_view_bytes: SQLITE_DATABASE_OUTPUT_BYTES,
  text_lines: 5000,
  xml_nodes: 5000,
  xml_depth: 64,
  parsed_bytes: 4 * 1024 * 1024,
  json_depth: MAX_JSON_DEPTH / 2,
  zip_entries: 1000,
  zip_entry_bytes: 16 * 1024 * 1024,
  zip_bytes: 64 * 1024 * 1024,
  zip_ratio: 100,
} as const;

const positive = z.int().positive();
export const desktopViewPolicyInputSchema = z.strictObject({
  file_bytes: positive.optional(),
  sqlite_tables: positive.optional(),
  sqlite_rows: positive.optional(),
  sqlite_view_bytes: positive
    .optional()
    .describe(
      `Compact UTF-8 JSON bytes retained per projected SQLite table, default ${String(SQLITE_DATABASE_OUTPUT_BYTES)}. Applies on this call and in exported readers. Each reader counts its native numeric spelling, so float thresholds can differ. Independent native value/record and worker reply limits remain fixed and may refuse earlier.`,
    ),
  text_lines: positive.optional(),
  xml_nodes: positive.optional(),
  xml_depth: positive.max(MAX_DESKTOP_XML_VIEW_DEPTH).optional(),
  parsed_bytes: positive.optional(),
  json_depth: positive.max(MAX_DESKTOP_JSON_VIEW_DEPTH).optional(),
  zip_entries: positive.optional(),
  zip_entry_bytes: positive.optional(),
  zip_bytes: positive.optional(),
  zip_ratio: positive.optional(),
});
export type DesktopViewPolicyInput = z.output<
  typeof desktopViewPolicyInputSchema
>;
export type DesktopViewPolicy = {
  readonly [Key in keyof typeof DESKTOP_VIEW_DEFAULTS]: number;
};

export const desktopViewPolicy = (
  input: DesktopViewPolicyInput = {},
): DesktopViewPolicy => {
  const policy: { -readonly [Key in keyof DesktopViewPolicy]: number } = {
    ...DESKTOP_VIEW_DEFAULTS,
  };
  for (const key of Object.keys(policy) as (keyof DesktopViewPolicy)[]) {
    const value = input[key];
    if (value !== undefined) policy[key] = value;
  }
  return policy;
};

/** Keep refusals exact even when callers select a sub-MiB byte budget. */
export const desktopViewByteDisplay = (bytes: number): string =>
  bytes % (1024 * 1024) === 0
    ? `${String(bytes / (1024 * 1024))} MiB`
    : `${String(bytes)} bytes`;

/** Refusal shared by shipped seed checks and the generated file reader. */
export const desktopViewFileLimitMessage = (
  policy: DesktopViewPolicy,
): string =>
  `larger than ${desktopViewByteDisplay(policy.file_bytes)}, the most the view reads`;

/** Projected-table admission, independent of the SQLite worker's transport. */
export const desktopSqliteViewLimitMessage = (
  policy: DesktopViewPolicy,
): string =>
  `SQLite table view exceeds sqlite_view_bytes=${String(policy.sqlite_view_bytes)} UTF-8 JSON bytes. Increase sqlite_view_bytes in --view-policy on the next call; no restart is needed. The separate SQLite value/record and worker reply limits remain fixed at ${String(SQLITE_DATABASE_OUTPUT_BYTES)} bytes and may refuse earlier.`;

/** Assign the same effective policy to the exported Python reader. */
export const pythonDesktopViewPolicy = (policy: DesktopViewPolicy): string => {
  const names: Record<keyof DesktopViewPolicy, string> = {
    file_bytes: "MAX_VIEW_BYTES",
    sqlite_tables: "MAX_TABLES",
    sqlite_rows: "MAX_ROWS",
    sqlite_view_bytes: "MAX_SQLITE_VIEW_BYTES",
    text_lines: "MAX_LINES",
    xml_nodes: "MAX_XML_NODES",
    xml_depth: "MAX_XML_DEPTH",
    parsed_bytes: "MAX_PARSED_BYTES",
    json_depth: "MAX_JSON_VIEW_DEPTH",
    zip_entries: "MAX_ZIP_ENTRIES",
    zip_entry_bytes: "MAX_ZIP_ENTRY_BYTES",
    zip_bytes: "MAX_ZIP_BYTES",
    zip_ratio: "MAX_ZIP_RATIO",
  };
  return [
    ...(Object.keys(names) as (keyof DesktopViewPolicy)[]).map(
      (key) => `${names[key]} = ${String(policy[key])}`,
    ),
    `VIEW_TOO_LARGE = ${JSON.stringify(desktopViewFileLimitMessage(policy))}`,
    `SQLITE_VIEW_TOO_LARGE = ${JSON.stringify(desktopSqliteViewLimitMessage(policy))}`,
    `SQLITE_VALUE_BYTES = ${String(SQLITE_DATABASE_OUTPUT_BYTES)}`,
  ].join("\n");
};
