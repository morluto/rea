import { z } from "zod";
import {
  androidSparseImageMetadataSchema,
  type AndroidSparseImageMetadata,
} from "../formatMetadata/androidAndSystemMetadata.js";
import { uint32 } from "../formatMetadata/primitives.js";

/**
 * Root metadata for an Android sparse image in an `inspect_artifact` summary
 * view: preserves header facts, virtual sizing, and chunk/block totals while
 * replacing inline chunk and checksum arrays with counts.
 */
export const androidSparseImageSummaryMetadataSchema =
  androidSparseImageMetadataSchema
    .omit({
      kind: true,
      chunks: true,
      chunks_omitted: true,
      crc32_chunk_values: true,
      crc32_chunk_values_omitted: true,
    })
    .extend({
      kind: z.literal("android-sparse-image-summary"),
      chunk_count: uint32,
      crc32_value_count: uint32,
    });
export type AndroidSparseImageSummaryMetadata = z.infer<
  typeof androidSparseImageSummaryMetadataSchema
>;

/** Compact summary metadata for an Android sparse image. */
export const summarizeAndroidSparseImage = (
  metadata: AndroidSparseImageMetadata,
): AndroidSparseImageSummaryMetadata => {
  const {
    kind: _kind,
    chunks: _chunks,
    chunks_omitted: _chunksOmitted,
    crc32_chunk_values: _crc32Values,
    crc32_chunk_values_omitted: _crc32Omitted,
    ...rest
  } = metadata;
  return {
    ...rest,
    kind: "android-sparse-image-summary",
    chunk_count: metadata.total_chunks,
    crc32_value_count: metadata.crc32_chunk_count,
  };
};
