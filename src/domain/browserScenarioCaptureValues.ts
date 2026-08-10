import { createHash } from "node:crypto";

import { z } from "zod";

import { sanitizedBrowserUrlSchema } from "./browserObservation.js";
import { webScreenshotArtifactSchema } from "./webScreenshot.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedTextSchema = z.string().max(1_048_576);

const textArtifactSchema = z
  .strictObject({
    sha256: digestSchema,
    bytes: z
      .number()
      .int()
      .min(0)
      .max(16 * 1_024 * 1_024),
    text: boundedTextSchema,
  })
  .superRefine((artifact, context) => {
    const bytes = Buffer.from(artifact.text);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== artifact.bytes || sha256 !== artifact.sha256)
      context.addIssue({
        code: "custom",
        message: "Text artifact digest or size mismatch",
      });
  });

export const captureStateSchema = <Schema extends z.ZodType>(value: Schema) =>
  z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("captured"), value }),
    z.strictObject({
      state: z.literal("not_requested"),
    }),
    z.strictObject({
      state: z.literal("missing"),
      reason: z.string().min(1).max(1_024),
    }),
    z.strictObject({
      state: z.literal("truncated"),
      observed: z.number().int().min(0),
      retained: z.number().int().min(0),
      reason: z.string().min(1).max(1_024),
    }),
  ]);

const historySchema = z.strictObject({
  length: z.number().int().min(0),
  current_url: sanitizedBrowserUrlSchema,
  navigation_entries: z
    .array(
      z.strictObject({
        type: z.enum([
          "navigate",
          "reload",
          "back_forward",
          "prerender",
          "unknown",
        ]),
        name: sanitizedBrowserUrlSchema,
      }),
    )
    .max(256),
});

const hashedStorageValueShape = {
  value_state: z.literal("hashed"),
  value_sha256: digestSchema,
};
const redactedStorageValueShape = {
  value_state: z.literal("redacted-secret"),
  value_sha256: z.null(),
};
const storageValueFingerprintSchema = z.discriminatedUnion("value_state", [
  z.strictObject(hashedStorageValueShape),
  z.strictObject(redactedStorageValueShape),
]);
export type BrowserStorageValueFingerprint = z.infer<
  typeof storageValueFingerprintSchema
>;

const storageValueSchema = z.discriminatedUnion("value_state", [
  z.strictObject({
    name: z.string().max(1_024),
    ...hashedStorageValueShape,
  }),
  z.strictObject({
    name: z.string().max(1_024),
    ...redactedStorageValueShape,
  }),
]);

const cookieShape = {
  name: z.string().max(1_024),
  domain: z.string().max(2_048),
  path: z.string().max(4_096),
  secure: z.boolean(),
  http_only: z.boolean(),
  same_site: z.enum(["Strict", "Lax", "None"]),
};

const storageSnapshotSchema = z.strictObject({
  cookies: z
    .array(
      z.discriminatedUnion("value_state", [
        z.strictObject({ ...cookieShape, ...hashedStorageValueShape }),
        z.strictObject({ ...cookieShape, ...redactedStorageValueShape }),
      ]),
    )
    .max(512),
  local_storage: z.array(storageValueSchema).max(512),
  session_storage: z.array(storageValueSchema).max(512),
});

export const browserStepArtifactsSchema = z.strictObject({
  screenshot: captureStateSchema(webScreenshotArtifactSchema),
  dom: captureStateSchema(textArtifactSchema),
  accessibility: captureStateSchema(textArtifactSchema),
  url: captureStateSchema(sanitizedBrowserUrlSchema),
  history: captureStateSchema(historySchema),
  storage: captureStateSchema(storageSnapshotSchema),
});
export type BrowserStepArtifacts = z.infer<typeof browserStepArtifactsSchema>;

const eventBase = {
  sequence: z.number().int().min(1),
  step_index: z.number().int().min(0),
};

const eventUrl = sanitizedBrowserUrlSchema.nullable();
const networkEventShape = {
  ...eventBase,
  method: z.string().min(1).max(32),
  url: sanitizedBrowserUrlSchema,
  resource_type: z.string().min(1).max(64),
  header_names: z.array(z.string().max(256)).max(256),
};
const webSocketFrameShape = {
  ...eventBase,
  kind: z.enum(["websocket-frame-sent", "websocket-frame-received"]),
  url: sanitizedBrowserUrlSchema,
  payload_bytes: z.number().int().min(0),
  truncated: z.boolean(),
};

export const browserScenarioEventSchema = z.union([
  z.strictObject({
    ...eventBase,
    kind: z.literal("console"),
    level: z.string().min(1).max(64),
    text: z.string().max(65_536),
    url: eventUrl,
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("page-error"),
    message: z.string().max(65_536),
    stack: z.string().max(262_144).nullable(),
  }),
  z.strictObject({
    ...networkEventShape,
    kind: z.literal("request"),
    status: z.null(),
    failure: z.null(),
  }),
  z.strictObject({
    ...networkEventShape,
    kind: z.literal("response"),
    status: z.number().int().min(100).max(599),
    failure: z.null(),
  }),
  z.strictObject({
    ...networkEventShape,
    kind: z.literal("request-failed"),
    status: z.null(),
    failure: z.string().min(1).max(1_024),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.enum(["websocket-opened", "websocket-closed"]),
    url: sanitizedBrowserUrlSchema,
  }),
  z.strictObject({
    ...webSocketFrameShape,
    payload_type: z.literal("text"),
    payload_text: z.string().max(65_536),
  }),
  z.strictObject({
    ...webSocketFrameShape,
    payload_type: z.literal("binary"),
    payload_text: z.null(),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.enum([
      "frame-attached",
      "frame-detached",
      "frame-navigated",
      "worker-created",
      "worker-closed",
      "popup-opened",
      "popup-closed",
    ]),
    url: eventUrl,
    name: z.string().max(1_024).nullable(),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("download-cancelled"),
    suggested_filename: z.string().max(1_024),
    url: sanitizedBrowserUrlSchema,
  }),
]);
export type BrowserScenarioEvent = z.infer<typeof browserScenarioEventSchema>;

const completenessSectionSchema = z.enum([
  "action",
  "screenshot",
  "dom",
  "accessibility",
  "url",
  "history",
  "storage",
  "events",
  "frames",
  "workers",
  "popups",
  "websockets",
]);
export type BrowserScenarioCompletenessSection = z.infer<
  typeof completenessSectionSchema
>;

export const browserScenarioCompletenessSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("complete"),
      equality_eligible: z.literal(true),
      missing_sections: z.tuple([]),
      truncated_sections: z.tuple([]),
    }),
    z.strictObject({
      status: z.literal("incomplete"),
      equality_eligible: z.literal(false),
      missing_sections: z.array(completenessSectionSchema).min(1),
      truncated_sections: z.tuple([]),
    }),
    z.strictObject({
      status: z.literal("truncated"),
      equality_eligible: z.literal(false),
      missing_sections: z.array(completenessSectionSchema),
      truncated_sections: z.array(completenessSectionSchema).min(1),
    }),
  ],
);
export type BrowserScenarioCompleteness = z.infer<
  typeof browserScenarioCompletenessSchema
>;

/** Classify canonical browser-scenario completeness from section accounting. */
export const classifyBrowserScenarioCompleteness = (
  missing: Iterable<BrowserScenarioCompletenessSection>,
  truncated: Iterable<BrowserScenarioCompletenessSection>,
): BrowserScenarioCompleteness => {
  const missingSections = [...new Set(missing)].sort();
  const truncatedSections = [...new Set(truncated)].sort();
  if (truncatedSections.length > 0)
    return browserScenarioCompletenessSchema.parse({
      status: "truncated",
      equality_eligible: false,
      missing_sections: missingSections,
      truncated_sections: truncatedSections,
    });
  if (missingSections.length > 0)
    return browserScenarioCompletenessSchema.parse({
      status: "incomplete",
      equality_eligible: false,
      missing_sections: missingSections,
      truncated_sections: [],
    });
  return {
    status: "complete",
    equality_eligible: true,
    missing_sections: [],
    truncated_sections: [],
  };
};

const browserScenarioStepShape = {
  step_index: z.number().int().min(0),
  step_id: z.string().min(1).max(64),
  action: z.string().min(1).max(64),
  elapsed_ms: z.number().int().min(0),
  before_url: sanitizedBrowserUrlSchema,
  after_url: sanitizedBrowserUrlSchema,
  event_sequence_start: z.number().int().min(1),
  event_sequence_end: z.number().int().min(0),
  artifacts: browserStepArtifactsSchema,
  completeness: browserScenarioCompletenessSchema,
};
export const browserScenarioStepSchema = z.union([
  z.strictObject({
    ...browserScenarioStepShape,
    status: z.literal("completed"),
    error: z.null(),
  }),
  z.strictObject({
    ...browserScenarioStepShape,
    status: z.enum(["failed", "cancelled"]),
    error: z.string().max(4_096),
  }),
]);
export type BrowserScenarioStep = z.infer<typeof browserScenarioStepSchema>;
type StepOutcome<Step> = Step extends BrowserScenarioStep
  ? Pick<Step, "status" | "error">
  : never;
export type BrowserScenarioStepOutcome = StepOutcome<BrowserScenarioStep>;
