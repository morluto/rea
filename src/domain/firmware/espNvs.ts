import { z } from "zod";
import type { AnalysisLimit } from "../analysisSettings.js";
import { knownCoverageStatusSchema } from "../coverage.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

export const ESP_NVS_PAGE_BYTES = 4096;
export const DEFAULT_ESP_NVS_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ESP_NVS_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_ESP_NVS_INLINE_ENTRIES = 0x7fff_ffff;

export const espNvsBudgetLimit = (effectiveValue: number): AnalysisLimit => ({
  control_kind: "parameter",
  parameter: "max_file_bytes",
  applies_at: "next_call",
  unit: "bytes",
  effective_value: effectiveValue,
  default_value: DEFAULT_ESP_NVS_MAX_FILE_BYTES,
  minimum: ESP_NVS_PAGE_BYTES,
  maximum: MAX_ESP_NVS_FILE_BYTES,
});

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
  max_file_bytes: z
    .number()
    .int()
    .min(ESP_NVS_PAGE_BYTES)
    .max(MAX_ESP_NVS_FILE_BYTES)
    .default(DEFAULT_ESP_NVS_MAX_FILE_BYTES)
    .describe("Maximum input file size admitted for reading."),
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

export const espNvsPageStateSchema = z.enum([
  "empty",
  "active",
  "full",
  "freeing",
  "corrupt_or_encrypted",
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
  written_slot_count: z.number().int().min(0),
  erased_slot_count: z.number().int().min(0),
  empty_slot_count: z.number().int().min(0),
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
  "sz",
  "blob_v1",
  "blob_v2",
  "blob_data_orphan",
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
  blob_size: z.number().int().min(0).nullable(),
  blob_preview_hex: z.string().nullable(),
  blob_sha256: z.string().nullable(),
  crc_valid: z.boolean(),
  // domain-vocabulary: NVS entry CRC and v2 multi-chunk blob reassembly state
  completeness: z.enum(["complete", "missing_chunks", "crc_mismatch"]),
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
  corrupt_or_encrypted_page_count: z.number().int().min(0),
  anomalies: z.array(z.string()),
  limitations: z.array(z.string()),
});

export type EspNvsReport = z.infer<typeof espNvsReportSchema>;
