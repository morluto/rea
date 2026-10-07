import { z } from "zod";
import { jsonObjectSchema } from "./jsonValue.js";
import {
  webRuntimeBrowserSchema,
  webRuntimeLocationSchema,
  webRuntimeScopeSchema,
  webRuntimeSourceSchema,
  webRuntimeTargetSchema,
} from "./webRuntime.js";

/** Explicit instrumentation request for one finite, externally driven execution window. */
export const observeWebExecutionInputSchema = webRuntimeScopeSchema.extend({
  observation_ms: z.number().int().min(1).max(2_147_483_647).default(10_000),
});
export type ObserveWebExecutionInput = z.infer<
  typeof observeWebExecutionInputSchema
>;

const rangeSchema = z.object({
  start_offset: z.number().int().min(0),
  end_offset: z.number().int().min(0),
  count: z.number().int().min(0),
  source_bounds: z.enum(["verified", "unknown"]),
});
const functionSchema = z.object({
  name: z.string(),
  is_block_coverage: z.boolean(),
  ranges: z.array(rangeSchema),
});

/** Precise V8 ranges retain their nested structure and counts without summing them. */
export const webExecutionSchema = z.object({
  browser: webRuntimeBrowserSchema,
  target: webRuntimeTargetSchema,
  window: z.object({
    armed_at: z.iso.datetime(),
    ended_at: z.iso.datetime(),
    requested_ms: z.number().int().min(1),
    end_reason: z.enum([
      "window_elapsed",
      "document_changed",
      "target_terminated",
    ]),
    producer_started_seconds: z.number().min(0),
    producer_sampled_seconds: z.number().min(0).nullable(),
  }),
  coverage: z.object({
    state: z.enum(["captured", "unavailable"]),
    reason: z.string().nullable(),
    offset_units: z.literal("utf16-code-units"),
    end_offset: z.literal("exclusive"),
    scripts: z.array(
      z.object({
        script_id: z.string().min(1),
        reported_url: z.string(),
        functions: z.array(functionSchema),
      }),
    ),
    excluded_scripts: z.number().int().min(0),
  }),
  requests: z.array(
    z.object({
      request_id: z.string().min(1),
      url: z.string(),
      method: z.string(),
      timestamp_seconds: z.number().min(0),
      initiator_type: z.string(),
      reported_initiator: jsonObjectSchema,
      callsites: z.array(webRuntimeLocationSchema),
      async_parent_ids: z.array(
        z.object({ id: z.string(), debugger_id: z.string().nullable() }),
      ),
      causal_attribution: z.literal("unknown"),
    }),
  ),
  excluded_requests: z.number().int().min(0),
  script_inventory: z.object({
    main_document_scripts: z.number().int().min(0),
    not_reported_script_ids: z.array(z.string().min(1)),
    coverage_absence: z.literal("unknown"),
  }),
  sources: z.array(webRuntimeSourceSchema),
  instrumentation: z.object({
    resets_execution_counters: z.literal(true),
    disables_optimized_execution: z.literal(true),
    takes_one_resetting_sample: z.boolean(),
    executes_selected_code: z.literal(false),
    cleanup: z.literal("confirmed"),
    page_ownership: z.literal("external"),
  }),
  limitations: z.array(z.string()),
});
export type WebExecution = z.infer<typeof webExecutionSchema>;
