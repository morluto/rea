import { isAbsolute } from "node:path";

import { z } from "zod";

const absolutePathSchema = z
  .string()
  .min(1)
  .max(16_384)
  .refine(isAbsolute, "path must be absolute");

const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    step_id: z.string().min(1).max(128),
    kind: z.literal("click"),
    selector: z.string().min(1).max(512),
  }),
  z.strictObject({
    step_id: z.string().min(1).max(128),
    kind: z.literal("wait"),
    duration_ms: z.number().int().min(0).max(10_000),
  }),
]);

const limitsSchema = z.strictObject({
  max_duration_ms: z.number().int().min(1).max(120_000).default(60_000),
  action_timeout_ms: z.number().int().min(1).max(30_000).default(5_000),
  max_actions: z.number().int().min(1).max(100).default(20),
  max_ipc_events: z.number().int().min(1).max(10_000).default(2_000),
  max_processes: z.number().int().min(1).max(100).default(32),
  max_windows: z.number().int().min(1).max(100).default(32),
});

/** Input for one explicit, provider-owned Electron runtime experiment. */
export const electronActiveObservationInputSchema = z
  .strictObject({
    schema_version: z.literal(1),
    executable_path: absolutePathSchema,
    application_path: absolutePathSchema,
    application_root: absolutePathSchema,
    args: z.array(z.string().max(4_096)).max(32).default([]),
    actions: z.array(actionSchema).max(100).default([]),
    limits: limitsSchema.default({
      max_duration_ms: 60_000,
      action_timeout_ms: 5_000,
      max_actions: 20,
      max_ipc_events: 2_000,
      max_processes: 32,
      max_windows: 32,
    }),
    approved: z.literal(true),
  })
  .superRefine((input, context) => {
    if (input.actions.length > input.limits.max_actions)
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "actions exceed the configured max_actions limit",
      });
  });
export type ElectronActiveObservationInput = z.infer<
  typeof electronActiveObservationInputSchema
>;

const ipcEventSchema = z.strictObject({
  sequence: z.number().int().min(1),
  kind: z.enum([
    "main-handler-invocation",
    "main-event-invocation",
    "utility-process-fork",
    "utility-process-message",
  ]),
  channel: z.string().max(1_024).nullable(),
  argument_shapes: z.array(z.string().max(64)).max(32),
  result_shape: z.string().max(64).nullable(),
  process_type: z.string().max(128).nullable(),
  error: z.boolean(),
});

const processMetricSchema = z.strictObject({
  pid: z.number().int().min(1),
  type: z.string().min(1).max(128),
});

const actionResultSchema = z.strictObject({
  step_id: z.string().min(1).max(128),
  kind: z.enum(["click", "wait"]),
  status: z.enum(["completed", "failed", "cancelled"]),
  elapsed_ms: z.number().int().min(0),
  error: z.string().nullable(),
});

/** Bounded result of a provider-owned Electron runtime experiment. */
export const electronActiveObservationResultSchema = z.strictObject({
  schema_version: z.literal(1),
  application: z.strictObject({
    executable_path: absolutePathSchema,
    application_path: absolutePathSchema,
    electron_version: z.string().min(1).max(256),
    process_ownership: z.literal("provider-owned"),
    cleanup: z.literal("terminated-owned-process"),
  }),
  actions: z.array(actionResultSchema).max(100),
  windows: z.array(
    z.strictObject({
      url: z.string().max(65_536),
      title: z.string().max(16_384),
    }),
  ),
  windows_truncated: z.boolean(),
  processes: z.strictObject({
    items: z.array(processMetricSchema).max(100),
    truncated: z.boolean(),
  }),
  ipc: z.strictObject({
    events: z.array(ipcEventSchema).max(10_000),
    observed: z.number().int().min(0),
    retained: z.number().int().min(0),
    truncated: z.boolean(),
  }),
  limitations: z.array(z.string().max(4_096)).max(100),
});
export type ElectronActiveObservationResult = z.infer<
  typeof electronActiveObservationResultSchema
>;
