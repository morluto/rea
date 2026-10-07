import { z } from "zod";
import {
  webRuntimeBrowserSchema,
  webRuntimeLocationSchema,
  webRuntimeScopeSchema,
  webRuntimeSourceSchema,
  webRuntimeTargetSchema,
} from "./webRuntime.js";

/** Inspect listeners registered directly on the first main-document CSS match. */
export const inspectWebEventListenersInputSchema = webRuntimeScopeSchema.extend(
  {
    selector: z.string().min(1),
  },
);
export type InspectWebEventListenersInput = z.infer<
  typeof inspectWebEventListenersInputSchema
>;

/** A listener declaration and its source location do not establish that it ran. */
export const webEventListenersSchema = z.object({
  browser: webRuntimeBrowserSchema,
  target: webRuntimeTargetSchema,
  inspected_at: z.iso.datetime(),
  selected_node: z.object({
    selector: z.string(),
    match: z.enum(["found", "not_found"]),
    backend_node_id: z.number().int().min(1).nullable(),
  }),
  listeners: z.array(
    z.object({
      type: z.string(),
      use_capture: z.boolean(),
      passive: z.boolean(),
      once: z.boolean(),
      location: webRuntimeLocationSchema,
      execution: z.literal("unknown"),
    }),
  ),
  sources: z.array(webRuntimeSourceSchema),
  cleanup: z.literal("confirmed"),
  limitations: z.array(z.string()),
});
export type WebEventListeners = z.infer<typeof webEventListenersSchema>;
