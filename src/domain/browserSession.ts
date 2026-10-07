import { z } from "zod";

import {
  browserAllowedOriginsSchema,
  browserEndpointSchema,
} from "./browserObservation.js";
import { browserCompletenessSchema } from "./browserCompleteness.js";
import { browserVersionSchema } from "./browserObservationSchemas.js";

/** Input for a navigation-aware browser observation window. */
export const observeWebSessionInputSchema = z.strictObject({
  cdp_endpoint: browserEndpointSchema,
  allowed_origins: browserAllowedOriginsSchema,
  target_id: z.string().trim().min(1),
  observation_ms: z.number().int().min(1).default(10_000),
});
export type ObserveWebSessionInput = z.infer<
  typeof observeWebSessionInputSchema
>;

const timelineEventSchema = z.object({
  sequence: z.number().int().min(1),
  type: z.enum([
    "navigation_requested",
    "navigation_committed",
    "same_origin_reload",
    "same_document_navigation",
    "redirect",
    "load_failed",
    "lifecycle",
    "target_terminated",
  ]),
  timestamp: z.number().min(0),
  frame_id: z.string().nullable(),
  loader_id: z.string().nullable(),
  request_id: z.string().nullable(),
  url: z.string().nullable(),
  destination_scope: z
    .enum(["approved", "outside_policy", "unsupported"])
    .nullable(),
  detail: z.string().nullable(),
});

/** Navigation-aware session result for external user actions. */
export const webObservationSessionSchema = z.object({
  browser: browserVersionSchema,
  target: z.object({
    target_id: z.string(),
    initial_url: z.string(),
    final_url: z.string().nullable(),
  }),
  window: z.object({
    armed_at: z.iso.datetime(),
    ended_at: z.iso.datetime(),
    requested_ms: z.number().int().min(1),
    end_reason: z.enum([
      "window_elapsed",
      "target_left_scope",
      "target_terminated",
    ]),
  }),
  timeline: z.array(timelineEventSchema),
  completeness: browserCompletenessSchema,
  limitations: z.array(z.string()),
});
export type WebObservationSession = z.infer<typeof webObservationSessionSchema>;
