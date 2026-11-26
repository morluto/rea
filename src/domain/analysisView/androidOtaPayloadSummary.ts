import { z } from "zod";

import {
  androidOtaPayloadMetadataSchema,
  type AndroidOtaPayloadMetadata,
} from "../formatMetadata/androidAndSystemMetadata.js";
import { uint32 } from "../formatMetadata/primitives.js";

/**
 * An Android OTA payload's root facts in the summary view, under their own
 * kind: header and manifest scalars with counts in place of the partition,
 * dynamic partition group and APEX arrays. Each partition stays an
 * occurrence, and the complete Evidence keeps every array.
 */
export const androidOtaPayloadSummaryMetadataSchema =
  androidOtaPayloadMetadataSchema
    .omit({ partitions: true, dynamic_partition_groups: true, apex_info: true })
    .extend({
      kind: z.literal("android-ota-payload-summary"),
      partition_count: uint32,
      extractable_partition_count: uint32,
      dynamic_partition_group_count: uint32,
      apex_info_count: uint32,
    });

/** Compact root facts for an Android OTA payload's summary view. */
export const summarizeAndroidOtaPayload = (
  metadata: AndroidOtaPayloadMetadata,
): z.infer<typeof androidOtaPayloadSummaryMetadataSchema> => {
  const { partitions, dynamic_partition_groups, apex_info, ...rest } = metadata;
  return {
    ...rest,
    kind: "android-ota-payload-summary",
    partition_count: partitions.length,
    extractable_partition_count: partitions.filter(
      ({ extractable }) => extractable,
    ).length,
    dynamic_partition_group_count: dynamic_partition_groups.length,
    apex_info_count: apex_info.length,
  };
};
