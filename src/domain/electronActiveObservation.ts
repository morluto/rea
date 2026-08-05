import { isAbsolute } from "node:path";

import { z } from "zod";

const absolutePathSchema = z
  .string()
  .min(1)
  .max(16_384)
  .refine(isAbsolute, "path must be absolute");

const windowIndexSchema = z.number().int().min(0).max(99);

const deepLinkUrlSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => {
    try {
      return new URL(value).protocol.length > 0;
    } catch {
      return false;
    }
  }, "deep-link url must be an absolute URL");

const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    step_id: z.string().min(1).max(128),
    kind: z.literal("click"),
    selector: z.string().min(1).max(512),
    window_index: windowIndexSchema.default(0),
  }),
  z.strictObject({
    step_id: z.string().min(1).max(128),
    kind: z.literal("wait"),
    duration_ms: z.number().int().min(0).max(10_000),
    window_index: windowIndexSchema.optional(),
  }),
  z.strictObject({
    step_id: z.string().min(1).max(128),
    kind: z.literal("renderer-reload"),
    window_index: windowIndexSchema.default(0),
  }),
  z.strictObject({
    step_id: z.string().min(1).max(128),
    kind: z.literal("renderer-crash"),
    window_index: windowIndexSchema.default(0),
  }),
  z.strictObject({
    step_id: z.string().min(1).max(128),
    kind: z.literal("deep-link"),
    delivery: z.enum(["open-url", "second-instance"]),
    url: deepLinkUrlSchema,
  }),
]);

const limitsSchema = z.strictObject({
  max_duration_ms: z.number().int().min(1).max(120_000).default(60_000),
  action_timeout_ms: z.number().int().min(1).max(30_000).default(5_000),
  max_actions: z.number().int().min(1).max(100).default(20),
  max_ipc_events: z.number().int().min(1).max(10_000).default(2_000),
  max_runtime_events: z.number().int().min(1).max(20_000).default(5_000),
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
      max_runtime_events: 5_000,
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
  correlation_id: z.string().max(256).nullable().default(null),
  kind: z.enum([
    "main-handler-invocation",
    "main-event-invocation",
    "utility-process-fork",
    "utility-process-message",
    "ipc-main-to-renderer",
    "ipc-utility-to-main",
    "ipc-renderer-send",
    "ipc-renderer-invoke",
    "ipc-renderer-post-message",
  ]),
  event: z.string().max(128).nullable().optional(),
  phase: z
    .enum(["attempted", "completed", "blocked", "failed", "observed"])
    .nullable()
    .optional(),
  channel: z.string().max(1_024).nullable(),
  channel_truncated: z.boolean().default(false),
  direction: z
    .enum([
      "renderer-to-main",
      "main-to-renderer",
      "main-to-utility",
      "utility-to-main",
    ])
    .nullable()
    .optional(),
  sender: z.string().max(256).nullable().optional(),
  receiver: z.string().max(256).nullable().optional(),
  frame: z.string().max(256).nullable().default(null),
  target: z.string().max(256).nullable().optional(),
  argument_shapes: z.array(z.string().max(64)).max(32),
  argument_shapes_truncated: z.boolean().default(false),
  result_shape: z.string().max(64).nullable(),
  process_type: z.string().max(128).nullable(),
  source: z.string().max(64).default("electron-active-hook"),
  capture_method: z
    .enum(["api-wrapper", "event-emitter", "process-hook"])
    .default("api-wrapper"),
  artifact_path: z.string().max(16_384).nullable().default(null),
  artifact_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable()
    .default(null),
  error: z.boolean(),
});

const timelineEventSchema = z.strictObject({
  sequence: z.number().int().min(1),
  correlation_id: z.string().max(256).nullable().default(null),
  kind: z.enum([
    "main-handler-invocation",
    "main-event-invocation",
    "utility-process-fork",
    "utility-process-message",
    "ipc-main-to-renderer",
    "ipc-utility-to-main",
    "ipc-renderer-send",
    "ipc-renderer-invoke",
    "ipc-renderer-post-message",
    "app-lifecycle",
    "window-lifecycle",
    "web-contents-lifecycle",
    "navigation",
    "shell-attempt",
    "process-lifecycle",
    "permission",
    "popup-attempt",
    "download",
    "protocol",
    "preload",
    "native-addon",
    "updater",
    "error",
  ]),
  event: z.string().max(128).nullable(),
  phase: z.enum(["attempted", "completed", "blocked", "failed", "observed"]),
  channel: z.string().max(1_024).nullable(),
  channel_truncated: z.boolean(),
  direction: z
    .enum([
      "renderer-to-main",
      "main-to-renderer",
      "main-to-utility",
      "utility-to-main",
    ])
    .nullable(),
  sender: z.string().max(256).nullable(),
  receiver: z.string().max(256).nullable(),
  frame: z.string().max(256).nullable(),
  target: z.string().max(256).nullable(),
  argument_shapes: z.array(z.string().max(64)).max(32),
  argument_shapes_truncated: z.boolean(),
  result_shape: z.string().max(64).nullable(),
  process_type: z.string().max(128).nullable(),
  source: z.string().max(64),
  capture_method: z.enum(["api-wrapper", "event-emitter", "process-hook"]),
  artifact_path: z.string().max(16_384).nullable(),
  artifact_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  error: z.boolean(),
});

const processMetricSchema = z.strictObject({
  pid: z.number().int().min(1),
  type: z.string().min(1).max(128),
  name: z.string().max(256).nullable(),
  service_name: z.string().max(256).nullable(),
});

const windowResultSchema = z.strictObject({
  window_id: z.string().max(256),
  web_contents_id: z.string().max(256),
  url: z.string().max(65_536),
  title: z.string().max(16_384),
  visible: z.boolean().nullable(),
  destroyed: z.boolean(),
});

const coverageSchema = z.strictObject({
  status: z.enum([
    "complete",
    "partial_attach",
    "capture_truncated",
    "hook_conflict",
    "target_exited",
    "cleanup_failed",
  ]),
  observed_event_families: z.array(z.string().max(128)).max(32),
  unavailable_event_families: z.array(z.string().max(128)).max(32),
  observed_roles: z.array(z.string().max(128)).max(16),
  pre_capture_activity: z.literal("unavailable"),
});

const actionResultSchema = z.strictObject({
  step_id: z.string().min(1).max(128),
  kind: z.enum([
    "click",
    "wait",
    "renderer-reload",
    "renderer-crash",
    "deep-link",
  ]),
  window_index: windowIndexSchema.nullable(),
  target: z.string().max(256).nullable(),
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
  windows: z.array(windowResultSchema).max(100),
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
  timeline: z
    .strictObject({
      events: z.array(timelineEventSchema).max(20_000),
      observed: z.number().int().min(0),
      retained: z.number().int().min(0),
      truncated: z.boolean(),
    })
    .default({ events: [], observed: 0, retained: 0, truncated: false }),
  coverage: coverageSchema.default({
    status: "partial_attach",
    observed_event_families: [],
    unavailable_event_families: [],
    observed_roles: [],
    pre_capture_activity: "unavailable",
  }),
  limitations: z.array(z.string().max(4_096)).max(100),
});
export type ElectronActiveObservationResult = z.infer<
  typeof electronActiveObservationResultSchema
>;
