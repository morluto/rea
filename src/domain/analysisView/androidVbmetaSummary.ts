import { z } from "zod";

import {
  androidVbmetaMetadataSchema,
  type AndroidVbmetaMetadata,
} from "../formatMetadata/androidAndSystemMetadata.js";
import { uint32 } from "../formatMetadata/primitives.js";

/**
 * A vbmeta image's root facts in the summary view, under their own kind:
 * header scalars with counts in place of the descriptor array. The complete
 * Evidence keeps every descriptor.
 */
export const androidVbmetaSummaryMetadataSchema = androidVbmetaMetadataSchema
  .omit({ descriptors: true })
  .extend({
    kind: z.literal("android-vbmeta-summary"),
    descriptor_count: uint32,
    property_count: uint32,
    hashtree_count: uint32,
    hash_count: uint32,
    kernel_cmdline_count: uint32,
    chain_partition_count: uint32,
    unknown_count: uint32,
  });

/** Compact root facts for a vbmeta image's summary view. */
export const summarizeAndroidVbmeta = (
  metadata: AndroidVbmetaMetadata,
): z.infer<typeof androidVbmetaSummaryMetadataSchema> => {
  const { descriptors, ...rest } = metadata;
  const counts = {
    PROPERTY: 0,
    HASHTREE: 0,
    HASH: 0,
    KERNEL_CMDLINE: 0,
    CHAIN_PARTITION: 0,
    UNKNOWN: 0,
  } satisfies Record<
    AndroidVbmetaMetadata["descriptors"][number]["tag_name"],
    number
  >;
  for (const descriptor of descriptors) counts[descriptor.tag_name] += 1;
  return {
    ...rest,
    kind: "android-vbmeta-summary",
    descriptor_count: descriptors.length,
    property_count: counts.PROPERTY,
    hashtree_count: counts.HASHTREE,
    hash_count: counts.HASH,
    kernel_cmdline_count: counts.KERNEL_CMDLINE,
    chain_partition_count: counts.CHAIN_PARTITION,
    unknown_count: counts.UNKNOWN,
  };
};
