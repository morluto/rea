import { z } from "zod";

import { PROCESS_REACTIVE_LIMITS } from "./processReactiveScenario.js";

const processReactiveOutcomeSchema = z.enum([
  "passed",
  "predicate_timeout",
  "scenario_deadline",
  "ambiguous_match",
  "action_rejected",
  "target_lost",
  "capture_incomplete",
  "cancelled",
  "cleanup_failed",
]);

const processReactiveTransitionShape = {
  sequence: z.number().int().nonnegative(),
  transition_id: z.string().min(1).max(64),
  state_before: z.string().min(1).max(64),
  trigger_event_ids: z
    .array(z.string().min(1))
    .max(PROCESS_REACTIVE_LIMITS.predicates),
  action_event_ids: z
    .array(z.string().min(1))
    .max(PROCESS_REACTIVE_LIMITS.actionsPerTransition),
  action_types: z
    .array(
      z.enum([
        "send_input",
        "resize",
        "close_stdin",
        "send_signal",
        "checkpoint",
      ]),
    )
    .max(PROCESS_REACTIVE_LIMITS.actionsPerTransition),
};

const processReactiveTransitionSchema = z.union([
  z.object({
    ...processReactiveTransitionShape,
    state_after: z.string().min(1).max(64),
    outcome: z.null(),
  }),
  z.object({
    ...processReactiveTransitionShape,
    state_after: z.null(),
    outcome: z.literal("passed"),
  }),
]);

const processReactiveRunShape = {
  active_state: z.string().min(1).max(64),
  controls: z
    .array(
      z.object({
        sequence: z.number().int().nonnegative(),
        kind: z.enum([
          "state_deadline",
          "scenario_deadline",
          "target_lost",
          "cancelled",
          "cleanup_failed",
        ]),
        after_capture_order: z.number().int().min(-1),
      }),
    )
    .default([]),
  transitions: z
    .array(processReactiveTransitionSchema)
    .max(PROCESS_REACTIVE_LIMITS.transitions),
};

/** Serialized reactive reducer state admitted by Process Capture v4. */
export const processReactiveRunSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("running"),
    outcome: z.null(),
    ...processReactiveRunShape,
  }),
  z.object({
    status: z.literal("finished"),
    outcome: processReactiveOutcomeSchema,
    ...processReactiveRunShape,
  }),
]);
