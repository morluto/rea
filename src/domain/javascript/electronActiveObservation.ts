import { z } from "zod";

import { isAbsoluteLocalPath } from "../localPath.js";

const pathInputSchema = z.string().trim().min(1).refine(isAbsoluteLocalPath, {
  message:
    "Electron executable, application, and root paths must be absolute local filesystem paths (for example /Applications/Electron.app/Contents/MacOS/Electron)",
});
const absolutePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith("/") ||
      /^[A-Za-z]:[\\/]/u.test(value) ||
      value.startsWith("\\\\"),
    "provider path must be absolute",
  );

const windowIndexSchema = z.number().int().min(0);

const deepLinkUrlSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      return new URL(value).protocol.length > 0;
    } catch (cause: unknown) {
      // Invalid input fails the refinement.
      void cause;
      return false;
    }
  }, "deep-link url must be an absolute URL");

const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    step_id: z.string().min(1),
    kind: z.literal("click"),
    selector: z.string().min(1),
    window_index: windowIndexSchema.default(0),
  }),
  z.strictObject({
    step_id: z.string().min(1),
    kind: z.literal("wait"),
    duration_ms: z.number().int().min(0),
    window_index: windowIndexSchema.optional(),
  }),
  z.strictObject({
    step_id: z.string().min(1),
    kind: z.literal("renderer-reload"),
    window_index: windowIndexSchema.default(0),
  }),
  z.strictObject({
    step_id: z.string().min(1),
    kind: z.literal("renderer-crash"),
    window_index: windowIndexSchema.default(0),
  }),
  z.strictObject({
    step_id: z.string().min(1),
    kind: z.literal("deep-link"),
    delivery: z.enum(["open-url", "second-instance"]),
    url: deepLinkUrlSchema,
  }),
]);

/** Input for one explicit, provider-owned Electron runtime experiment. */
export const electronActiveObservationInputSchema = z.strictObject({
  executable_path: pathInputSchema.describe(
    "Absolute local filesystem path for the Electron executable; relative paths are rejected.",
  ),
  application_path: pathInputSchema.describe(
    "Absolute local filesystem path for the Electron application; relative paths are rejected.",
  ),
  application_root: pathInputSchema
    .optional()
    .describe(
      "Absolute local filesystem root for application-relative paths; omit to derive it from the application path. Relative paths are rejected.",
    ),
  args: z.array(z.string()).default([]),
  actions: z.array(actionSchema).default([]),
});
export type ElectronActiveObservationInput = z.infer<
  typeof electronActiveObservationInputSchema
>;

const ipcEventSchema = z.strictObject({
  sequence: z.number().int().min(1),
  correlation_id: z.string().nullable().default(null),
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
  event: z.string().nullable().optional(),
  phase: z
    .enum(["attempted", "completed", "blocked", "failed", "observed"])
    .nullable()
    .optional(),
  channel: z.string().nullable(),
  direction: z
    .enum([
      "renderer-to-main",
      "main-to-renderer",
      "main-to-utility",
      "utility-to-main",
    ])
    .nullable()
    .optional(),
  sender: z.string().nullable().optional(),
  receiver: z.string().nullable().optional(),
  frame: z.string().nullable().default(null),
  target: z.string().nullable().optional(),
  argument_shapes: z.array(z.string()),
  result_shape: z.string().nullable(),
  process_type: z.string().nullable(),
  source: z.string().default("electron-active-hook"),
  capture_method: z
    .enum(["api-wrapper", "event-emitter", "process-hook"])
    .default("api-wrapper"),
  artifact_path: z.string().nullable().default(null),
  artifact_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable()
    .default(null),
  error: z.boolean(),
});

const timelineEventSchema = z.strictObject({
  sequence: z.number().int().min(1),
  correlation_id: z.string().nullable().default(null),
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
  event: z.string().nullable(),
  phase: z.enum(["attempted", "completed", "blocked", "failed", "observed"]),
  channel: z.string().nullable(),
  direction: z
    .enum([
      "renderer-to-main",
      "main-to-renderer",
      "main-to-utility",
      "utility-to-main",
    ])
    .nullable(),
  sender: z.string().nullable(),
  receiver: z.string().nullable(),
  frame: z.string().nullable(),
  target: z.string().nullable(),
  argument_shapes: z.array(z.string()),
  result_shape: z.string().nullable(),
  process_type: z.string().nullable(),
  source: z.string(),
  capture_method: z.enum(["api-wrapper", "event-emitter", "process-hook"]),
  artifact_path: z.string().nullable(),
  artifact_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  error: z.boolean(),
});

const processMetricSchema = z.strictObject({
  pid: z.number().int().min(1),
  type: z.string().min(1),
  name: z.string().nullable(),
  service_name: z.string().nullable(),
});

const windowResultSchema = z.strictObject({
  window_id: z.string(),
  web_contents_id: z.string(),
  url: z.string(),
  title: z.string(),
  visible: z.boolean().nullable(),
  destroyed: z.boolean(),
});

const coverageSchema = z.strictObject({
  status: z.enum([
    "complete",
    "partial_attach",
    "hook_conflict",
    "target_exited",
    "cleanup_failed",
  ]),
  observed_event_families: z.array(z.string()),
  unavailable_event_families: z.array(z.string()),
  observed_roles: z.array(z.string()),
  pre_capture_activity: z.literal("unavailable"),
});

const actionResultContextShape = {
  step_id: z.string().min(1),
  kind: z.enum([
    "click",
    "wait",
    "renderer-reload",
    "renderer-crash",
    "deep-link",
  ]),
  window_index: windowIndexSchema.nullable(),
  target: z.string().nullable(),
  elapsed_ms: z.number().int().min(0),
};

const actionResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...actionResultContextShape,
    status: z.literal("completed"),
    error: z.null(),
  }),
  z.strictObject({
    ...actionResultContextShape,
    status: z.enum(["failed", "cancelled"]),
    error: z.string(),
  }),
]);

/** Result of a provider-owned Electron runtime experiment. */
export const electronActiveObservationResultSchema = z.strictObject({
  application: z.strictObject({
    executable_path: absolutePathSchema,
    application_path: absolutePathSchema,
    electron_version: z.string().min(1),
    process_ownership: z.literal("provider-owned"),
    cleanup: z.literal("terminated-owned-process"),
  }),
  actions: z.array(actionResultSchema),
  windows: z.array(windowResultSchema),
  processes: z.strictObject({
    items: z.array(processMetricSchema),
  }),
  ipc: z.strictObject({
    events: z.array(ipcEventSchema),
    observed: z.number().int().min(0),
    dropped: z.number().int().min(0).nullable().default(null),
  }),
  timeline: z
    .strictObject({
      events: z.array(timelineEventSchema),
      observed: z.number().int().min(0),
      dropped: z.number().int().min(0).nullable().default(null),
    })
    .default({ events: [], observed: 0, dropped: null }),
  retention: z
    .strictObject({
      budget_bytes: z.number().int().min(0),
      estimated_retained_bytes: z.number().int().min(0),
      event_serialized_byte_upper_bound: z.number().int().min(0),
      retained: z.number().int().min(0),
      dropped: z.number().int().min(0),
      dropped_event_families: z.array(
        z.strictObject({
          family: z.string().min(1),
          count: z.number().int().min(1),
        }),
      ),
      dropped_event_roles: z.array(
        z.strictObject({
          role: z.string().min(1),
          count: z.number().int().min(1),
        }),
      ),
      observed_ipc: z.number().int().min(0),
      dropped_ipc: z.number().int().min(0),
      observed_runtime: z.number().int().min(0),
      dropped_runtime: z.number().int().min(0),
    })
    .nullable()
    .default(null),
  coverage: coverageSchema.default({
    status: "partial_attach",
    observed_event_families: [],
    unavailable_event_families: [],
    observed_roles: [],
    pre_capture_activity: "unavailable",
  }),
  limitations: z.array(z.string()),
});
export type ElectronActiveObservationResult = z.infer<
  typeof electronActiveObservationResultSchema
>;
