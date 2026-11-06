import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import {
  WARC_ARCHIVE_MAX_DECODED_BYTES,
  WARC_ARCHIVE_MAX_FILE_BYTES,
  WARC_ARCHIVE_MAX_RECORDS,
} from "./warcArchive.js";

export const inspectWarcArchiveInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to one local WARC or WARC.gz file",
  ),
  format: z.literal("warc").default("warc"),
  max_file_bytes: z
    .int()
    .positive()
    .max(WARC_ARCHIVE_MAX_FILE_BYTES)
    .default(WARC_ARCHIVE_MAX_FILE_BYTES)
    .describe(
      "Maximum bytes read from the archive file (up to 64 MiB); compressed input is bounded separately by max_decoded_bytes",
    ),
  max_decoded_bytes: z
    .int()
    .positive()
    .max(WARC_ARCHIVE_MAX_DECODED_BYTES)
    .default(WARC_ARCHIVE_MAX_DECODED_BYTES)
    .describe(
      "Maximum decompressed stream bytes (up to 256 MiB); decompression stops at this bound",
    ),
  max_records: z
    .int()
    .positive()
    .max(WARC_ARCHIVE_MAX_RECORDS)
    .default(WARC_ARCHIVE_MAX_RECORDS)
    .describe(
      "Maximum records inventoried (up to 20000); a larger archive reports the limit instead of listing every record",
    ),
});
export type InspectWarcArchiveInput = z.output<
  typeof inspectWarcArchiveInputSchema
>;

/** CLI-facing aliases so one owner states each bound once. */
export const warcArchiveFileBytesSchema =
  inspectWarcArchiveInputSchema.shape.max_file_bytes;
export const warcArchiveDecodedBytesSchema =
  inspectWarcArchiveInputSchema.shape.max_decoded_bytes;
export const warcArchiveRecordsSchema =
  inspectWarcArchiveInputSchema.shape.max_records;
