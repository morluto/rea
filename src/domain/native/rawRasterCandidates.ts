import { z } from "zod";
import { absoluteLocalPathStringSchema } from "../localPath.js";
const nonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const dimensions = z.array(z.number().int().min(8).max(4096)).min(1).max(32);
const format = z.enum(["gray8", "rgb888", "rgba8888"]);
/** Explicit search grid and resource budgets, never a claim of exhaustive image detection. */
export const inspectRawRasterCandidatesInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema,
  offset: nonnegative.default(0),
  length: z
    .number()
    .int()
    .min(1)
    .max(16 * 1024 * 1024)
    .optional(),
  widths: dimensions.default([
    16, 24, 32, 48, 64, 96, 128, 160, 240, 256, 320, 480, 640,
  ]),
  heights: dimensions.default([16, 32, 64]),
  formats: z
    .array(format)
    .min(1)
    .max(3)
    .default(["gray8", "rgb888", "rgba8888"]),
  offset_step: z
    .number()
    .int()
    .min(1)
    .max(16 * 1024 * 1024)
    .optional(),
  min_score: z.number().min(0).max(1).default(0.5),
  max_hypotheses: z.number().int().min(1).max(100000).default(20000),
  max_candidates: z.number().int().min(1).max(100).default(20),
});
const metric = z.number().finite().nonnegative();
export const rawRasterDiscoverySchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string(),
    bytes: nonnegative,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  window: z.strictObject({ offset: nonnegative, length: nonnegative }),
  candidates: z
    .array(
      z.strictObject({
        status: z.literal("hypothesis"),
        score: z.number().min(0).max(1),
        layout: z.strictObject({
          offset: nonnegative,
          length: nonnegative,
          width: nonnegative,
          height: nonnegative,
          stride: nonnegative,
          rowOrder: z.literal("top-down"),
          format,
        }),
        metrics: z.strictObject({
          horizontalDifference: metric,
          verticalDifference: metric,
          distantDifference: metric,
          valueSpread: metric,
          samples: nonnegative,
        }),
      }),
    )
    .max(100),
  coverage: z.strictObject({
    nextOffset: nonnegative.nullable(),
    minScore: z.number().min(0).max(1),
    tested: nonnegative,
    complete: z.boolean(),
    retained: nonnegative,
    accepted: nonnegative,
    offsetStep: nonnegative,
    widths: dimensions,
    heights: dimensions,
    formats: z.array(z.string()),
    maxHypotheses: nonnegative,
  }),
  limitations: z.array(z.string()),
});
export type RawRasterDiscovery = z.infer<typeof rawRasterDiscoverySchema>;
