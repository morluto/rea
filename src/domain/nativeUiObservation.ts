import { z } from "zod";

const scope = {
  pid: z.number().int().positive(),
  window_id: z.number().int().positive(),
  observation_approved: z.literal(true),
  screenshot: z.boolean().default(true),
  accessibility: z.boolean().default(true),
  max_nodes: z.number().int().min(1).max(2_000).default(500),
};
/** Opt-in passive observation binds one already-running process and window. */
export const nativeUiObservationInputSchema = z.strictObject(scope);
/** Active scenarios require independent action approval and an explicit restore choice. */
export const nativeUiScenarioInputSchema = z.strictObject({
  ...scope,
  actions_approved: z.literal(true),
  restore: z.literal("leave-as-is"),
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
          text: z.string().max(4_096),
        }),
        z.strictObject({
          kind: z.literal("wait"),
          milliseconds: z.number().int().min(0).max(10_000),
        }),
      ]),
    )
    .min(1)
    .max(16),
});
/** Ordered captures and failures distinguish missing observation from a failed action. */
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
  screenshot: z
    .strictObject({
      mime_type: z.literal("image/png"),
      base64: z.string(),
      sha256: z.string(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .nullable(),
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
