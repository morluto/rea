import { z } from "zod";
import { digestSchema } from "./digests.js";
import { absoluteLocalPathStringSchema } from "./localPath.js";

/** Compact source facts supplied by the provider for one observation. */
export const analysisSourceDescriptorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("file-range"),
    path: absoluteLocalPathStringSchema,
    sha256: digestSchema,
    byte_offset: z.int().nonnegative(),
    byte_length: z.int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal("single-function-decompile") }),
]);

export type AnalysisSourceDescriptor = z.infer<
  typeof analysisSourceDescriptorSchema
>;
