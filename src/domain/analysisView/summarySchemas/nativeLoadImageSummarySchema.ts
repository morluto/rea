import { z } from "zod";
import { artifactSchema, summaryViewResultBase } from "../analysisViewBase.js";
import { nativeLoadImageSummarySchema } from "../nativeLoadImageView.js";
import { nativeViewSourceContext } from "../nativeViewContext.js";

/** Compact provider load observations retain the independent verification state. */
export const nativeLoadImageSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  ...nativeViewSourceContext,
  artifact: artifactSchema.nullable(),
  parent_operation: z.literal("inspect_native_load_image"),
  summary: nativeLoadImageSummarySchema,
});
