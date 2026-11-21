import { z } from "zod";

import {
  androidVbmetaMetadataSchema,
  uint32,
  type AndroidVbmetaMetadata,
} from "../artifactFormatMetadata.js";

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

const countNamed = (
  descriptors: AndroidVbmetaMetadata["descriptors"],
  tagName: AndroidVbmetaMetadata["descriptors"][number]["tag_name"],
): number =>
  descriptors.filter((descriptor) => descriptor.tag_name === tagName).length;

/** Compact root facts for a vbmeta image's summary view. */
export const summarizeAndroidVbmeta = (
  metadata: AndroidVbmetaMetadata,
): z.infer<typeof androidVbmetaSummaryMetadataSchema> => {
  const { descriptors, ...rest } = metadata;
  return {
    ...rest,
    kind: "android-vbmeta-summary",
    descriptor_count: descriptors.length,
    property_count: countNamed(descriptors, "PROPERTY"),
    hashtree_count: countNamed(descriptors, "HASHTREE"),
    hash_count: countNamed(descriptors, "HASH"),
    kernel_cmdline_count: countNamed(descriptors, "KERNEL_CMDLINE"),
    chain_partition_count: countNamed(descriptors, "CHAIN_PARTITION"),
    unknown_count: countNamed(descriptors, "UNKNOWN"),
  };
};
