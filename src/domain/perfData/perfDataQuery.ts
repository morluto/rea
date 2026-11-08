import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import { PERF_DATA_MAX_EVENTS, PERF_DATA_MAX_FILE_BYTES } from "./perfData.js";

export const inspectPerfDataInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to one local Linux perf recording (perf.data)",
  ),
  max_file_bytes: z
    .int()
    .positive()
    .max(PERF_DATA_MAX_FILE_BYTES)
    .default(PERF_DATA_MAX_FILE_BYTES)
    .describe("Maximum bytes read from the recording (up to 64 MiB)"),
  max_events: z
    .int()
    .positive()
    .max(PERF_DATA_MAX_EVENTS)
    .default(PERF_DATA_MAX_EVENTS)
    .describe(
      "Maximum event attribute groups decoded (up to 20000); a larger recording reports the limit instead of listing every event",
    ),
});
export type InspectPerfDataInput = z.output<typeof inspectPerfDataInputSchema>;

/** CLI-facing aliases so one owner states each bound once. */
export const perfDataFileBytesSchema =
  inspectPerfDataInputSchema.shape.max_file_bytes;
export const perfDataEventsSchema = inspectPerfDataInputSchema.shape.max_events;
