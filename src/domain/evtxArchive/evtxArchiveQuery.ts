import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import {
  EVTX_ARCHIVE_MAX_FILE_BYTES,
  EVTX_ARCHIVE_MAX_RECORDS,
} from "./evtxArchive.js";

export const inspectEvtxArchiveInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to one local Windows Event Log (.evtx) file",
  ),
  format: z.literal("evtx").default("evtx"),
  max_file_bytes: z
    .int()
    .positive()
    .max(EVTX_ARCHIVE_MAX_FILE_BYTES)
    .default(EVTX_ARCHIVE_MAX_FILE_BYTES)
    .describe("Maximum bytes read from the log file (up to 64 MiB)"),
  max_records: z
    .int()
    .positive()
    .max(EVTX_ARCHIVE_MAX_RECORDS)
    .default(EVTX_ARCHIVE_MAX_RECORDS)
    .describe(
      "Maximum event records decoded (up to 20000); a larger log reports the limit instead of listing every event",
    ),
});
export type InspectEvtxArchiveInput = z.output<
  typeof inspectEvtxArchiveInputSchema
>;

/** CLI-facing aliases so one owner states each bound once. */
export const evtxArchiveFileBytesSchema =
  inspectEvtxArchiveInputSchema.shape.max_file_bytes;
export const evtxArchiveRecordsSchema =
  inspectEvtxArchiveInputSchema.shape.max_records;
