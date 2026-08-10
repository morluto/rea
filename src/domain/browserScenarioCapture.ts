import { z } from "zod";

import {
  browserScenarioCompletenessSchema,
  browserScenarioEventSchema,
  browserScenarioStepSchema,
} from "./browserScenarioCaptureValues.js";

export {
  classifyBrowserScenarioCompleteness,
  browserScenarioCompletenessSchema,
  browserScenarioEventSchema,
  browserScenarioStepSchema,
  browserStepArtifactsSchema,
  captureStateSchema,
  type BrowserScenarioCompleteness,
  type BrowserScenarioCompletenessSection,
  type BrowserScenarioEvent,
  type BrowserScenarioStep,
  type BrowserScenarioStepOutcome,
  type BrowserStepArtifacts,
} from "./browserScenarioCaptureValues.js";

/** Step-indexed, explicitly bounded browser scenario observation. */
export const browserScenarioCaptureSchema = z
  .strictObject({
    schema_version: z.literal(1),
    browser: z.strictObject({
      mode: z.enum(["launch", "connect"]),
      process_ownership: z.enum(["provider-owned", "external"]),
      cleanup: z.enum(["terminated-owned-process", "disconnected-external"]),
      product: z.string().min(1).max(1_024),
      version: z.string().min(1).max(256),
    }),
    scenario: z.strictObject({
      start_origin: z.string().min(1).max(2_048),
      allowed_origins: z.array(z.string().min(1).max(2_048)).min(1).max(32),
      action_count: z.number().int().min(1).max(128),
      secret_references: z.array(z.string().min(1).max(64)).max(64),
    }),
    duration_ms: z.number().int().min(0),
    steps: z.array(browserScenarioStepSchema).min(1).max(129),
    events: z.strictObject({
      retained: z.number().int().min(0),
      dropped: z.number().int().min(0),
      items: z.array(browserScenarioEventSchema).max(100_000),
    }),
    completeness: browserScenarioCompletenessSchema,
    limitations: z.array(z.string().min(1).max(2_048)).max(64),
  })
  .superRefine((capture, context) => {
    if (capture.events.retained !== capture.events.items.length)
      context.addIssue({
        code: "custom",
        path: ["events", "retained"],
        message: "Retained event count must equal items length",
      });
    if (capture.steps.length !== capture.scenario.action_count + 1)
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Capture must include initial state and one entry per action",
      });
    const expectedIndices = capture.steps.map((_, index) => index);
    if (
      capture.steps.some(
        ({ step_index: index }, offset) => index !== expectedIndices[offset],
      )
    )
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Step indices must be contiguous from zero",
      });
    if (
      capture.events.items.some(
        ({ step_index: index }) => index >= capture.steps.length,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["events", "items"],
        message: "Event references an unknown step index",
      });
  });
export type BrowserScenarioCapture = z.infer<
  typeof browserScenarioCaptureSchema
>;
