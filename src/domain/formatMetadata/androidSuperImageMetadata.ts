import { z } from "zod";

import { offset, sha256Hex, uint32 } from "./primitives.js";

const byteCount = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);

const nameBytesHex = z
  .string()
  .regex(/^(?:[0-9a-f]{2})+$/u)
  .nullable();

const extentFields = {
  index: offset,
  record_offset: offset,
  logical_offset: byteCount,
  length_bytes: byteCount,
};

const extentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...extentFields,
    kind: z.literal("linear"),
    device_index: offset,
    device_name: z.string().nullable(),
    device_name_bytes_hex: nameBytesHex,
    device_flags: uint32.exactOptional(),
    physical_offset: byteCount,
    image_offset: offset.nullable(),
    image_range_status: z
      .enum(["present", "truncated", "not-in-image"])
      .exactOptional(),
  }),
  z.strictObject({
    ...extentFields,
    kind: z.literal("zero"),
  }),
]);

export const androidSuperPartitionMetadataSchema = z.strictObject({
  kind: z.literal("android-super-partition"),
  slot: offset.nullable(),
  index: offset,
  name: z.string(),
  attributes: uint32,
  group_index: offset,
  group_name: z.string().nullable(),
  group_name_bytes_hex: nameBytesHex,
  group_flags: uint32.exactOptional(),
  logical_bytes: byteCount,
  extents: z.array(extentSchema),
});

const failureFacts = {
  format: z.string(),
  detail: z.string(),
  offset: offset.exactOptional(),
  field: z.string().exactOptional(),
};

const copyFailureSchema = z.strictObject({
  slot: offset,
  copy: z.enum(["primary", "backup"]),
  metadata_offset: offset,
  failure: z.discriminatedUnion("kind", [
    z.strictObject({ ...failureFacts, kind: z.literal("malformed") }),
    z.strictObject({
      ...failureFacts,
      kind: z.literal("truncated"),
      extent: z
        .strictObject({ availableBytes: offset, requiredBytes: offset })
        .exactOptional(),
    }),
    z.strictObject({
      ...failureFacts,
      kind: z.literal("unsupported"),
      undecodedContent: z.boolean(),
    }),
  ]),
});

export const androidSuperImageMetadataSchema = z.strictObject({
  kind: z.literal("android-super-image"),
  layout: z.enum(["raw", "metadata-only"]),
  geometry_offset: offset,
  geometry_sha256: sha256Hex,
  metadata_max_size: offset,
  metadata_slot_count: offset,
  logical_block_size: offset,
  // Older Evidence predates per-copy failure and extent availability reporting.
  failed_copies: z.array(copyFailureSchema).exactOptional(),
  copies: z.array(
    z.strictObject({
      slot: offset.nullable(),
      copy: z.enum(["primary", "backup", "template"]),
      metadata_offset: offset,
      major_version: offset,
      minor_version: offset,
      header_size: offset,
      header_sha256: sha256Hex,
      tables_size: offset,
      tables_sha256: sha256Hex,
      flags: uint32.nullable(),
      partition_count: offset,
      extent_count: offset,
      group_count: offset,
      block_device_count: offset,
    }),
  ),
});

export type AndroidSuperPartitionMetadata = z.infer<
  typeof androidSuperPartitionMetadataSchema
>;
export type AndroidSuperImageMetadata = z.infer<
  typeof androidSuperImageMetadataSchema
>;
