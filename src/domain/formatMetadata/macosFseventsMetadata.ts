import { z } from "zod";
import {
  FSEVENTS_INLINE_BLOCK_LIMIT,
  FSEVENTS_INLINE_DIAGNOSTIC_LIMIT,
  FSEVENTS_INLINE_EVENT_LIMIT,
} from "../apple/macosFsevents.js";
import { offset, uint32 } from "./primitives.js";

const macosFseventsVersionSchema = z.enum(["1SLD", "2SLD", "3SLD"]);

const macosFseventsBlockSchema = z.strictObject({
  index: offset,
  stream_offset: offset,
  version: macosFseventsVersionSchema,
  reserved_word: uint32,
  declared_stream_size: uint32,
  available_bytes: offset,
  record_count: offset,
  first_event_id: z.string().nullable(),
  last_event_id: z.string().nullable(),
  trailing_unparsed_bytes: offset,
  truncated: z.boolean(),
});

const macosFseventsRecordSchema = z.strictObject({
  block_index: offset,
  stream_offset: offset,
  version: macosFseventsVersionSchema,
  event_id: z.string(),
  flags: z.strictObject({
    raw: uint32,
    raw_hex: z.string(),
    names: z.array(z.string()),
    unknown_mask: uint32,
  }),
  path: z.string(),
  path_encoding: z.enum(["utf-8", "invalid-utf8"]),
  raw_path_hex: z.string(),
  node_id: z.string().nullable(),
  extra_word: uint32.nullable(),
  out_of_order: z.boolean(),
  duplicate_event_id: z.boolean(),
  event_id_gap_from_previous: z.string().nullable(),
});

/** macOS `.fseventsd` Disk Log Stream inventory and bounded sampled events. */
export const macosFseventsMetadataSchema = z.strictObject({
  kind: z.literal("macos-fsevents"),
  compression: z.enum(["gzip", "none"]),
  compressed_bytes: offset,
  decompressed_bytes: offset,
  store_versions: z.array(macosFseventsVersionSchema),
  block_count: offset,
  blocks: z.array(macosFseventsBlockSchema).max(FSEVENTS_INLINE_BLOCK_LIMIT),
  omitted_blocks: offset,
  record_count: offset,
  first_event_id: z.string().nullable(),
  last_event_id: z.string().nullable(),
  out_of_order_record_count: offset,
  duplicate_event_id_count: offset,
  event_id_gap_count: offset,
  mount_event_count: offset,
  unmount_event_count: offset,
  end_of_transaction_count: offset,
  truncated_path_flag_count: offset,
  non_utf8_path_count: offset,
  malformed_record_count: offset,
  trailing_zero_bytes: offset,
  flag_counts: z.array(z.strictObject({ name: z.string(), count: offset })),
  diagnostics: z
    .array(
      z.strictObject({
        stream_offset: offset,
        reason: z.string(),
        detail: z.string(),
      }),
    )
    .max(FSEVENTS_INLINE_DIAGNOSTIC_LIMIT),
  omitted_diagnostics: offset,
  records: z.array(macosFseventsRecordSchema).max(FSEVENTS_INLINE_EVENT_LIMIT),
  omitted_records: offset,
});
