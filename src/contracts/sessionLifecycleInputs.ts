import { isAbsolute } from "node:path";
import { executableFormatHintSchema } from "../domain/dosCom.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { z } from "zod";
import { analysisProviderSelectorSchema } from "./providerSelection.js";

/** Caller-supplied analysis snapshot path; must name its destination absolutely. */
const snapshotPathSchema = localPathStringSchema
  .refine(isAbsolute, {
    message:
      "snapshot_path must be an absolute local filesystem path (for example /tmp/rea/analysis.json or C:\\rea\\analysis.json)",
  })
  .describe(
    "Absolute local filesystem path for the analysis snapshot; relative paths are rejected.",
  );

/** Caller-supplied analysis target path; must name the target absolutely. */
const binaryTargetPathSchema = localPathStringSchema
  .refine(isAbsolute, {
    message:
      "path must be an absolute local filesystem path (for example /tmp/fixture.bin or C:\\analysis\\fixture.bin)",
  })
  .describe(
    "Absolute local filesystem path for the analysis target; relative paths are rejected.",
  );

/** Input contract for opening a target with an optional staged snapshot. */
export const openBinaryInputSchema = z.strictObject({
  path: binaryTargetPathSchema,
  format: executableFormatHintSchema
    .optional()
    .describe(
      "Explicit headerless DOS COM interpretation; omission preserves header-based detection",
    ),
  provider_id: analysisProviderSelectorSchema.optional(),
  snapshot_path: snapshotPathSchema.optional(),
});

/** Input contract for closing a target after an optional atomic snapshot. */
export const closeBinaryInputSchema = z.strictObject({
  snapshot_path: snapshotPathSchema.optional(),
  overwrite: z.boolean().default(false),
});
