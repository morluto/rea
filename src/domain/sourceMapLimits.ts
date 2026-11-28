import { z } from "zod";
import type { AnalysisParameterLimit } from "./analysisSettings.js";
import {
  parameterBudgetLimit,
  type ParameterBudget,
} from "./parameterBudget.js";

/** Local map admission calibrated against public Actual Budget maps; other policies remain conservative. */
export const WEB_SOURCE_MAP_LIMITS = {
  mapBytes: 8 * 1024 * 1024,
  outputBytes: 32 * 1024 * 1024,
  decodedRows: 262144,
  decodedSegments: 262144,
  decodedRecords: 262144,
  sectionDepth: 64,
  decodeTimeoutMs: 20000,
  codecHeapMiB: 192,
  fetchBytes: 64 * 1024 * 1024,
};

// A complete encoded request/reply must remain below Node's single-string range.
export const MAX_SOURCE_MAP_ENCODED_BYTES = 536870887;
const MAX_RECORD_COUNT = 0x7fffffff;
const MAX_CODEC_HEAP_MIB = 16384;

export const SOURCE_MAP_LIMIT_FIELDS = [
  "map_bytes",
  "output_bytes",
  "decoded_rows",
  "decoded_segments",
  "decoded_records",
  "section_depth",
  "codec_heap_mib",
  "fetch_bytes",
] as const;

export type SourceMapLimitField = (typeof SOURCE_MAP_LIMIT_FIELDS)[number];

/** Per-call source-map budgets shared by the input schema and refusal limits. */
export const SOURCE_MAP_BUDGETS = {
  map_bytes: {
    minimum: 1,
    maximum: MAX_SOURCE_MAP_ENCODED_BYTES,
    default_value: WEB_SOURCE_MAP_LIMITS.mapBytes,
    unit: "bytes",
  },
  output_bytes: {
    minimum: 1,
    maximum: MAX_SOURCE_MAP_ENCODED_BYTES,
    default_value: WEB_SOURCE_MAP_LIMITS.outputBytes,
    unit: "bytes",
  },
  decoded_rows: {
    minimum: 1,
    maximum: MAX_RECORD_COUNT,
    default_value: WEB_SOURCE_MAP_LIMITS.decodedRows,
    unit: "count",
  },
  decoded_segments: {
    minimum: 1,
    maximum: MAX_RECORD_COUNT,
    default_value: WEB_SOURCE_MAP_LIMITS.decodedSegments,
    unit: "count",
  },
  decoded_records: {
    minimum: 1,
    maximum: MAX_RECORD_COUNT,
    default_value: WEB_SOURCE_MAP_LIMITS.decodedRecords,
    unit: "count",
  },
  section_depth: {
    minimum: 1,
    maximum: MAX_RECORD_COUNT,
    default_value: WEB_SOURCE_MAP_LIMITS.sectionDepth,
    unit: "count",
  },
  codec_heap_mib: {
    minimum: 128,
    maximum: MAX_CODEC_HEAP_MIB,
    default_value: WEB_SOURCE_MAP_LIMITS.codecHeapMiB,
    unit: "MiB",
  },
  fetch_bytes: {
    minimum: 1,
    maximum: MAX_SOURCE_MAP_ENCODED_BYTES,
    default_value: WEB_SOURCE_MAP_LIMITS.fetchBytes,
    unit: "bytes",
  },
} as const satisfies Record<SourceMapLimitField, ParameterBudget>;

/** Build a structured per-call refusal limit using the input schema's own bounds. */
export const sourceMapBudgetLimit = (
  field: SourceMapLimitField,
  effectiveValue: number,
  requiredValue?: number,
): AnalysisParameterLimit => ({
  ...parameterBudgetLimit(
    `source_map_limits.${field}`,
    SOURCE_MAP_BUDGETS[field],
    effectiveValue,
  ),
  ...(requiredValue === undefined ? {} : { required_value: requiredValue }),
});

const optionalBudget = (budget: ParameterBudget) =>
  z.int().min(budget.minimum).max(budget.maximum).exactOptional();

export const sourceMapLimitsSchema = z.strictObject({
  map_bytes: optionalBudget(SOURCE_MAP_BUDGETS.map_bytes).describe(
    `Local source-map byte admission; default ${String(WEB_SOURCE_MAP_LIMITS.mapBytes)}. Applies before reading and again in the codec.`,
  ),
  output_bytes: optionalBudget(SOURCE_MAP_BUDGETS.output_bytes).describe(
    `Complete encoded request/reply or fetched-map representation budget; default ${String(WEB_SOURCE_MAP_LIMITS.outputBytes)}.`,
  ),
  decoded_rows: optionalBudget(SOURCE_MAP_BUDGETS.decoded_rows).describe(
    `Generated-row admission before codec allocation; default ${String(WEB_SOURCE_MAP_LIMITS.decodedRows)}.`,
  ),
  decoded_segments: optionalBudget(
    SOURCE_MAP_BUDGETS.decoded_segments,
  ).describe(
    `Mapping-segment admission before codec allocation; default ${String(WEB_SOURCE_MAP_LIMITS.decodedSegments)}.`,
  ),
  decoded_records: optionalBudget(SOURCE_MAP_BUDGETS.decoded_records).describe(
    `Shared structural record admission, including declarations, rows, segments and sections; default ${String(WEB_SOURCE_MAP_LIMITS.decodedRecords)}.`,
  ),
  section_depth: optionalBudget(SOURCE_MAP_BUDGETS.section_depth).describe(
    `Indexed-section nesting admission; default ${String(WEB_SOURCE_MAP_LIMITS.sectionDepth)}. Each retained section also consumes the shared structural-record budget.`,
  ),
  codec_heap_mib: optionalBudget(SOURCE_MAP_BUDGETS.codec_heap_mib).describe(
    `Local codec old-generation heap request in MiB; default ${String(WEB_SOURCE_MAP_LIMITS.codecHeapMiB)}. Independent of byte/record budgets and client receive limits.`,
  ),
  fetch_bytes: optionalBudget(SOURCE_MAP_BUDGETS.fetch_bytes).describe(
    `Aggregate fetched response bytes and, independently, retained resolved-identity bytes; each defaults to ${String(WEB_SOURCE_MAP_LIMITS.fetchBytes)}.`,
  ),
});
export type SourceMapLimitSelection = z.output<typeof sourceMapLimitsSchema>;
export type SourceMapLimits = typeof WEB_SOURCE_MAP_LIMITS;
export const selectedSourceMapLimits = (
  selected?: SourceMapLimitSelection,
): SourceMapLimits => ({
  ...WEB_SOURCE_MAP_LIMITS,
  mapBytes: selected?.map_bytes ?? WEB_SOURCE_MAP_LIMITS.mapBytes,
  outputBytes: selected?.output_bytes ?? WEB_SOURCE_MAP_LIMITS.outputBytes,
  decodedRows: selected?.decoded_rows ?? WEB_SOURCE_MAP_LIMITS.decodedRows,
  decodedSegments:
    selected?.decoded_segments ?? WEB_SOURCE_MAP_LIMITS.decodedSegments,
  decodedRecords:
    selected?.decoded_records ?? WEB_SOURCE_MAP_LIMITS.decodedRecords,
  sectionDepth: selected?.section_depth ?? WEB_SOURCE_MAP_LIMITS.sectionDepth,
  codecHeapMiB: selected?.codec_heap_mib ?? WEB_SOURCE_MAP_LIMITS.codecHeapMiB,
  fetchBytes: selected?.fetch_bytes ?? WEB_SOURCE_MAP_LIMITS.fetchBytes,
});
export const sourceMapLimitRecovery = (
  field: keyof SourceMapLimitSelection,
  value: number,
): string => {
  const { minimum, maximum } = SOURCE_MAP_BUDGETS[field];
  const unit =
    field === "codec_heap_mib"
      ? "MiB"
      : field.endsWith("bytes")
        ? "bytes"
        : field === "section_depth"
          ? "levels"
          : "records";
  const action =
    value < maximum
      ? `Increase that per-call field (range ${String(minimum)}..${String(maximum)}) and retry the same complete map after cleanup`
      : "This is the maximum supported value; use a smaller complete map or an independent source-map reader for this workload";
  return `source_map_limits.${field} is ${String(value)} ${unit}. ${action}; no REA restart is required. Other byte, record, heap and client limits remain independent.`;
};

/** Carry the effective policy to the codec before it reads the private request. */
export const sourceMapLimitSelection = (
  limits: SourceMapLimits,
): SourceMapLimitSelection => ({
  map_bytes: limits.mapBytes,
  output_bytes: limits.outputBytes,
  decoded_rows: limits.decodedRows,
  decoded_segments: limits.decodedSegments,
  decoded_records: limits.decodedRecords,
  section_depth: limits.sectionDepth,
  codec_heap_mib: limits.codecHeapMiB,
  fetch_bytes: limits.fetchBytes,
});

export const localSourceMapLimitsSchema = sourceMapLimitsSchema.omit({
  fetch_bytes: true,
});
export const fetchedSourceMapLimitsSchema = sourceMapLimitsSchema.omit({
  map_bytes: true,
  codec_heap_mib: true,
});
