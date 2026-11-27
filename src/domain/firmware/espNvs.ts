import { z } from "zod";
import type { AnalysisParameterLimit } from "../analysisSettings.js";
import { knownCoverageStatusSchema } from "../coverage.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  parameterBudgetLimitFor,
  parameterBudgetSchema,
  type ParameterBudget,
} from "../parameterBudget.js";

/** ESP-IDF `nvs_constants.h`: page size, entry size and count, and the page layout. */
export const ESP_NVS_PAGE_BYTES = 4096;
export const ESP_NVS_ENTRY_BYTES = 32;
export const ESP_NVS_ENTRY_COUNT = 126;
/** NVS_CONST_PAGE_ENTRY_TABLE_OFFSET: the 2-bit entry-state bitmap after the 32-byte header. */
export const ESP_NVS_ENTRY_TABLE_OFFSET = 32;
/** NVS_CONST_PAGE_ENTRY_DATA_OFFSET: the first 32-byte entry. */
export const ESP_NVS_ENTRY_DATA_OFFSET = 64;
export const DEFAULT_ESP_NVS_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ESP_NVS_FILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_ESP_NVS_MAX_DECODED_BYTES = 32 * 1024 * 1024;
export const MAX_ESP_NVS_DECODED_BYTES = 128 * 1024 * 1024;
export const MAX_ESP_NVS_INLINE_ENTRIES = 0x7fff_ffff;

export const ESP_NVS_BUDGETS = {
  max_file_bytes: {
    minimum: ESP_NVS_PAGE_BYTES,
    maximum: MAX_ESP_NVS_FILE_BYTES,
    default_value: DEFAULT_ESP_NVS_MAX_FILE_BYTES,
    unit: "bytes",
  },
  /** Estimated bytes of the decoded NVS report, charged before each allocation. */
  max_decoded_bytes: {
    minimum: 1024,
    maximum: MAX_ESP_NVS_DECODED_BYTES,
    default_value: DEFAULT_ESP_NVS_MAX_DECODED_BYTES,
    unit: "bytes",
  },
} as const satisfies Record<string, ParameterBudget>;

export type EspNvsBudgetParameter = keyof typeof ESP_NVS_BUDGETS;

export const espNvsBudgetLimit: (
  parameter: EspNvsBudgetParameter,
  effectiveValue: number,
) => AnalysisParameterLimit = parameterBudgetLimitFor(ESP_NVS_BUDGETS);

export const espNvsProviderInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Local standalone NVS partition image or raw ESP flash dump path.",
  ),
  partition_offset: z
    .number()
    .int()
    .min(0)
    .max(MAX_ESP_NVS_FILE_BYTES)
    .multipleOf(ESP_NVS_PAGE_BYTES)
    .default(0)
    .describe(
      "4096-byte aligned byte offset of the NVS partition within path (for example 36864 for 0x9000 in a full flash dump). Defaults to 0.",
    ),
  partition_bytes: z
    .number()
    .int()
    .min(ESP_NVS_PAGE_BYTES)
    .max(MAX_ESP_NVS_FILE_BYTES)
    .multipleOf(ESP_NVS_PAGE_BYTES)
    .optional()
    .describe(
      "Optional 4096-byte multiple size of the NVS slice to decode starting at partition_offset. Omit to read through the end of the file (clipped to full 4096-byte pages).",
    ),
  max_file_bytes: parameterBudgetSchema(
    ESP_NVS_BUDGETS.max_file_bytes,
  ).describe("Maximum input file size admitted for reading."),
  max_decoded_bytes: parameterBudgetSchema(
    ESP_NVS_BUDGETS.max_decoded_bytes,
  ).describe(
    "Maximum estimated decoded NVS representation bytes admitted before report allocation.",
  ),
});

export type EspNvsProviderInput = z.output<typeof espNvsProviderInputSchema>;

export const inspectEspNvsInputSchema = espNvsProviderInputSchema.extend({
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(MAX_ESP_NVS_INLINE_ENTRIES)
    .optional()
    .describe(
      "Optional inline cap on decoded NVS key-value entries returned in normalized_result.entries; omitted entries remain in the retained complete Evidence.",
    ),
});

export type InspectEspNvsInput = z.output<typeof inspectEspNvsInputSchema>;

export const inspectEspNvsRequestSchema = inspectEspNvsInputSchema.extend({
  detail: z.enum(["complete", "summary"]).optional(),
});

export type InspectEspNvsRequest = z.output<typeof inspectEspNvsRequestSchema>;

/**
 * ESP-IDF `Page::PageState`: UNINITIALIZED (0xffffffff) is reported as
 * `empty`; `corrupt` (0xfffffff0) is the state firmware writes for a damaged
 * page and `invalid` is 0. Any other value is `unknown`. The header CRC32 is a
 * separate fact on the page summary.
 */
export const espNvsPageStateSchema = z.enum([
  "empty",
  "active",
  "full",
  "freeing",
  "corrupt",
  "invalid",
  "unknown",
]);
export type EspNvsPageState = z.infer<typeof espNvsPageStateSchema>;

export const espNvsPageSummarySchema = z.strictObject({
  page_index: z.number().int().min(0),
  file_offset: z.number().int().min(0),
  raw_state: z.string(),
  state: espNvsPageStateSchema,
  seq_no: z.number().int().min(0).nullable(),
  format_version: z.enum(["v1", "v2", "unknown"]).nullable(),
  header_crc_valid: z.boolean().nullable(),
  /** Whether this page's entries were walked: a valid header in an active, full or freeing state. */
  entries_decoded: z.boolean(),
  written_slot_count: z.number().int().min(0),
  erased_slot_count: z.number().int().min(0),
  empty_slot_count: z.number().int().min(0),
  /** Entry-state bitmap value 0b01, which ESP-IDF only reaches through inconsistent flash. */
  illegal_slot_count: z.number().int().min(0),
  /** Written slots whose 32-byte item header failed CRC32 or ESP-IDF's header consistency rules. */
  inconsistent_item_count: z.number().int().min(0),
});
export type EspNvsPageSummary = z.infer<typeof espNvsPageSummarySchema>;

export const espNvsNamespaceSchema = z.strictObject({
  namespace_id: z.number().int().min(1).max(254),
  name: z.string(),
  page_index: z.number().int().min(0),
  entry_index: z.number().int().min(0),
});
export type EspNvsNamespace = z.infer<typeof espNvsNamespaceSchema>;

export const espNvsDataTypeSchema = z.enum([
  "u8",
  "i8",
  "u16",
  "i16",
  "u32",
  "i32",
  "u64",
  "i64",
  "float",
  "double",
  "sz",
  "blob_v1",
  "blob_v2",
  "blob_data_orphan",
  /** An older copy of a BLOB_DATA chunk whose newer copy a recovered blob used. */
  "blob_data_copy",
  "unknown",
]);
export type EspNvsDataType = z.infer<typeof espNvsDataTypeSchema>;

export const espNvsEntrySchema = z.strictObject({
  page_index: z.number().int().min(0),
  entry_index: z.number().int().min(0),
  file_offset: z.number().int().min(0),
  namespace_id: z.number().int().min(1).max(255),
  namespace: z.string().nullable(),
  key: z.string(),
  data_type: espNvsDataTypeSchema,
  raw_type_code: z.number().int().min(0).max(255),
  span: z.number().int().min(1).max(126),
  value_text: z.string().nullable(),
  value_integer: z.string().nullable(),
  /** Decimal text of a stored IEEE 754 float or double, exact for the stored bits. */
  value_float: z.string().nullable(),
  blob_size: z.number().int().min(0).nullable(),
  blob_preview_hex: z.string().nullable(),
  blob_sha256: z.string().nullable(),
  crc_valid: z.boolean(),
  // domain-vocabulary: NVS entry CRC and v2 multi-chunk blob reassembly state
  completeness: z.enum(["complete", "missing_chunks", "crc_mismatch"]),
  /**
   * A later written copy of the same namespace, key and type exists: a higher
   * page sequence number, or a later slot on the same page. ESP-IDF reads that
   * copy; this one is a leftover from an interrupted rewrite or page move.
   */
  superseded: z.boolean(),
});
export type EspNvsEntry = z.infer<typeof espNvsEntrySchema>;

export const espNvsReportSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bytes: z.number().int().min(0),
  }),
  partition_range: z.strictObject({
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    page_count: z.number().int().min(1),
    trailing_unaligned_bytes: z.number().int().min(0),
  }),
  coverage: z.strictObject({
    status: knownCoverageStatusSchema,
    examined_pages: z.number().int().min(1),
    retained_entries: z.number().int().min(0),
    omitted_entries: z.number().int().min(0),
  }),
  pages: z.array(espNvsPageSummarySchema),
  namespaces: z.array(espNvsNamespaceSchema),
  entries: z.array(espNvsEntrySchema),
  corrupt_entry_count: z.number().int().min(0),
  /** Pages whose entries were not walked; see each page's state and header_crc_valid. */
  undecoded_page_count: z.number().int().min(0),
  anomalies: z.array(z.string()),
  limitations: z.array(z.string()),
});

export type EspNvsReport = z.infer<typeof espNvsReportSchema>;
