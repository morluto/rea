import { z } from "zod";

import {
  browserAllowedOriginsSchema,
  browserEndpointSchema,
} from "./browserObservation.js";
import { browserCompletenessSchema } from "./browserCompleteness.js";

/** Input for a bounded, navigation-aware browser observation window. */
export const observeWebSessionInputSchema = z.object({
  cdp_endpoint: browserEndpointSchema,
  allowed_origins: browserAllowedOriginsSchema,
  target_id: z.string().trim().min(1).max(256),
  approved: z.literal(true),
  observation_ms: z.number().int().min(1).max(60_000).default(10_000),
  max_timeline_events: z.number().int().min(1).max(20_000).default(2_000),
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
  schema_version: z.literal(1),
  browser: z.object({
    product: z.string(),
    protocol_version: z.string(),
    revision: z.string(),
    user_agent: z.string(),
    js_version: z.string(),
  }),
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
