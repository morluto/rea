import { z } from "zod";

import {
  ubiImageMetadataSchema,
  uint32,
  type UbiImageMetadata,
} from "../artifactFormatMetadata.js";

/**
 * A UBI image's root facts in the summary view, under their own kind: header
 * layout and eraseblock counts with volume counts in place of the volume
 * array. Each volume stays an occurrence, and the complete Evidence keeps
 * the array.
 */
export const ubiImageSummaryMetadataSchema = ubiImageMetadataSchema
  .omit({ volumes: true })
  .extend({
    kind: z.literal("ubi-image-summary"),
    volume_count: uint32,
    extractable_volume_count: uint32,
  });

/** Compact root facts for a UBI image's summary view. */
export const summarizeUbiImage = (
  metadata: UbiImageMetadata,
): z.infer<typeof ubiImageSummaryMetadataSchema> => {
  const { volumes, ...rest } = metadata;
  return {
    ...rest,
    kind: "ubi-image-summary",
    volume_count: volumes.length,
    extractable_volume_count: volumes.filter(({ extractable }) => extractable)
      .length,
  };
};
