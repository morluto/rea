import { z } from "zod";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  PERF_DATA_DEFAULT_MAX_IDENTIFIERS,
  PERF_DATA_MAX_EVENTS,
  PERF_DATA_MAX_FILE_BYTES,
  PERF_DATA_MAX_IDENTIFIERS,
} from "./perfData.js";

export const inspectPerfDataInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
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
  max_identifiers: z
    .int()
    .positive()
    .max(PERF_DATA_MAX_IDENTIFIERS)
    .default(PERF_DATA_DEFAULT_MAX_IDENTIFIERS)
    .describe(
      "Maximum identifiers retained across all events (default 200000, up to 400000)",
    ),
});
export type InspectPerfDataInput = z.output<typeof inspectPerfDataInputSchema>;
