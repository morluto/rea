import { z } from "zod";

export const DEFAULT_RASTER_FILE_BYTES = 128 * 1024 * 1024;
export const rasterFileBytesSchema = z
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER)
  .describe(
    "Maximum whole-file bytes to read for SHA-256, independent of the selected range.",
  );
