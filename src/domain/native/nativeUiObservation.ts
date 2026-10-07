import { createHash } from "node:crypto";

import { z } from "zod";

import { decodeCanonicalBase64 } from "../webScreenshot.js";

const scope = {
  pid: z.number().int().positive(),
  window_id: z.number().int().positive(),
  screenshot: z.boolean().default(true),
  accessibility: z.boolean().default(true),
  max_nodes: z
    .number()
    .int()
    .positive()
    .safe()
    .default(500)
    .describe(
      "Maximum accessibility nodes per capture; increase for large windows.",
    ),
};
/** Opt-in passive observation binds one already-running process and window. */
export const nativeUiObservationInputSchema = z.strictObject(scope);
/** Active scenarios use explicit actions and leave application state as-is. */
export const nativeUiScenarioInputSchema = z.strictObject({
  ...scope,
  steps: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("click"),
          path: z.array(z.number().int().nonnegative()).max(32),
        }),
        z.strictObject({
          kind: z.literal("scroll"),
          path: z.array(z.number().int().nonnegative()).max(32),
          direction: z.enum(["increment", "decrement"]),
        }),
        z.strictObject({
          kind: z.literal("key-entry"),
          path: z.array(z.number().int().nonnegative()).max(32),
          text: z.string(),
        }),
        z.strictObject({
          kind: z.literal("wait"),
          milliseconds: z
            .number()
            .int()
            .min(0)
            .max(180_000)
            .describe(
              "Wait duration in milliseconds, within the 180-second operation deadline.",
            ),
        }),
      ]),
    )
    .min(1),
});
/** Ordered captures and failures distinguish missing observation from a failed action. */
const nativeUiScreenshotSchema = z
  .strictObject({
    mime_type: z.literal("image/png"),
    base64: z.string().min(4),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .superRefine((screenshot, context) => {
    const bytes = decodeCanonicalBase64(screenshot.base64);
    if (bytes === undefined) {
      context.addIssue({
        code: "custom",
        message: "Invalid canonical PNG base64",
      });
      return;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== screenshot.sha256)
      context.addIssue({
        code: "custom",
        message: "PNG screenshot digest mismatch",
      });
    if (
      bytes.byteLength < 24 ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.subarray(12, 16).toString("ascii") !== "IHDR"
    ) {
      context.addIssue({
        code: "custom",
        message: "Screenshot bytes are not a PNG image",
      });
      return;
    }
    if (
      bytes.readUInt32BE(16) !== screenshot.width ||
      bytes.readUInt32BE(20) !== screenshot.height
    )
      context.addIssue({
        code: "custom",
        message: "PNG screenshot dimensions mismatch",
      });
  });

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const nativeUiSnapshotSchema = z.strictObject({
  window: z.strictObject({
    pid: z.number().int().positive(),
    window_id: z.number().int().positive(),
    executable: z.string(),
    launch_time: z.number(),
    title: z.string(),
  }),
  nodes: z.array(
    z.strictObject({
      path: z.array(z.number().int().nonnegative()),
      role: z.string().nullable(),
      title: z.string().nullable(),
      value: z.string().nullable(),
      actions: z.array(z.string()),
      children_count: z.number().int().nonnegative(),
    }),
  ),
  truncated: z.boolean(),
  screenshot: nativeUiScreenshotSchema.nullable(),
  gaps: z.array(z.string()),
});
export const nativeUiResultSchema = z.strictObject({
  target_sha256: z.string(),
  initial: nativeUiSnapshotSchema,
  steps: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      kind: z.string(),
      before: nativeUiSnapshotSchema,
      after: nativeUiSnapshotSchema.nullable(),
      outcome: z.enum(["completed", "failed", "cancelled"]),
      reason: z.string().nullable(),
    }),
  ),
  restore: z.literal("leave-as-is"),
  limitations: z.array(z.string()),
});
