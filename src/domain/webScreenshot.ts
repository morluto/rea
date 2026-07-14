import { createHash } from "node:crypto";

import { z } from "zod";

import { browserCompletenessSchema } from "./browserCompleteness.js";
import {
  browserAllowedOriginsSchema,
  browserEndpointSchema,
} from "./browserObservation.js";

const MAX_SCREENSHOT_BYTES = 8 * 1_024 * 1_024;

/** Self-verifying inline PNG artifact for CLI/MCP parity. */
const webScreenshotArtifactSchema = z
  .object({
    uri: z.string().regex(/^rea:\/\/web-screenshot\/sha256\/[a-f0-9]{64}$/u),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().min(1).max(MAX_SCREENSHOT_BYTES),
    media_type: z.literal("image/png"),
    data_base64: z.string().max(Math.ceil((MAX_SCREENSHOT_BYTES * 4) / 3) + 4),
  })
  .superRefine((artifact, context) => {
    const bytes = decodeCanonicalBase64(artifact.data_base64);
    if (bytes === undefined) {
      context.addIssue({ code: "custom", message: "Invalid canonical base64" });
      return;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      bytes.byteLength !== artifact.bytes ||
      sha256 !== artifact.sha256 ||
      artifact.uri !== `rea://web-screenshot/sha256/${sha256}`
    )
      context.addIssue({
        code: "custom",
        message: "Screenshot artifact digest or size mismatch",
      });
  });
export type WebScreenshotArtifact = z.infer<typeof webScreenshotArtifactSchema>;

/** Input for one read-only visible-viewport screenshot. */
export const captureWebScreenshotInputSchema = z.object({
  cdp_endpoint: browserEndpointSchema,
  allowed_origins: browserAllowedOriginsSchema,
  target_id: z.string().trim().min(1).max(256),
  approved: z.literal(true),
  screenshot_approved: z.literal(true),
  maximum_image_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_SCREENSHOT_BYTES)
    .default(4 * 1_024 * 1_024),
});
export type CaptureWebScreenshotInput = z.infer<
  typeof captureWebScreenshotInputSchema
>;

const browserVersionSchema = z.object({
  product: z.string(),
  protocol_version: z.string(),
  revision: z.string(),
  user_agent: z.string(),
  js_version: z.string(),
});

/** Bounded screenshot observation with embedded immutable artifact bytes. */
export const webScreenshotSchema = z.object({
  schema_version: z.literal(1),
  browser: browserVersionSchema,
  target: z.object({
    target_id: z.string(),
    url: z.string(),
    origin: z.string(),
  }),
  captured_at: z.iso.datetime(),
  viewport: z.object({
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  }),
  artifact: webScreenshotArtifactSchema,
  completeness: browserCompletenessSchema,
  limitations: z.array(z.string()),
});
export type WebScreenshot = z.infer<typeof webScreenshotSchema>;

/** Input for bounded local pixel comparison of two screenshot artifacts. */
export const compareWebScreenshotsInputSchema = z.object({
  before: webScreenshotArtifactSchema,
  after: webScreenshotArtifactSchema,
  channel_threshold: z.number().int().min(0).max(255).default(0),
  maximum_pixels: z.number().int().min(1).max(32_000_000).default(16_000_000),
});
export type CompareWebScreenshotsInput = z.infer<
  typeof compareWebScreenshotsInputSchema
>;

/** Value-only visual difference metrics; no OCR or image mutation. */
export const webScreenshotDiffSchema = z.object({
  schema_version: z.literal(1),
  status: z.enum(["identical", "different", "dimension_mismatch"]),
  before: z.object({
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  }),
  after: z.object({
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  }),
  channel_threshold: z.number().int().min(0).max(255),
  compared_pixels: z.number().int().min(0),
  changed_pixels: z.number().int().min(0).nullable(),
  changed_ratio: z.number().min(0).max(1).nullable(),
  maximum_channel_delta: z.number().int().min(0).max(255).nullable(),
  mean_absolute_channel_delta: z.number().min(0).max(255).nullable(),
  limitations: z.array(z.string()),
});
export type WebScreenshotDiff = z.infer<typeof webScreenshotDiffSchema>;

/** Create a content-addressed PNG artifact from already bounded bytes. */
export const createWebScreenshotArtifact = (
  bytes: Buffer,
): WebScreenshotArtifact => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return webScreenshotArtifactSchema.parse({
    uri: `rea://web-screenshot/sha256/${sha256}`,
    sha256,
    bytes: bytes.byteLength,
    media_type: "image/png",
    data_base64: bytes.toString("base64"),
  });
};

/** Strict canonical base64 decoder used before digest validation. */
export const decodeCanonicalBase64 = (value: string): Buffer | undefined => {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64.test(value))
    return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
};

const BASE64 = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u;
