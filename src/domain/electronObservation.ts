import { z } from "zod";

import { browserCompletenessSchema } from "./browserCompleteness.js";
import { browserEndpointSchema } from "./browserObservation.js";
import { webTextArtifactSchema } from "./webContentArtifact.js";

const approvedElectronInput = {
  cdp_endpoint: browserEndpointSchema,
};

/** Input for listing local file:// page targets from an explicit Electron CDP endpoint. */
export const listElectronTargetsInputSchema = z.strictObject({
  ...approvedElectronInput,
});
export type ListElectronTargetsInput = z.infer<
  typeof listElectronTargetsInputSchema
>;

/** Input for passive structural inspection of one Electron file page. */
const inspectElectronPageFacts = {
  ...approvedElectronInput,
  target_id: z.string().trim().min(1),
  observation_ms: z.number().int().min(0).default(100),
} as const;
export const inspectElectronPageInputSchema = z.union([
  z.strictObject({
    ...inspectElectronPageFacts,
    include_script_sources: z.literal(false).default(false),
  }),
  z.strictObject({
    ...inspectElectronPageFacts,
    include_script_sources: z.literal(true),
  }),
]);
export type InspectElectronPageInput = z.infer<
  typeof inspectElectronPageInputSchema
>;

const browserVersionSchema = z.object({
  product: z.string(),
  protocol_version: z.string(),
  revision: z.string(),
  user_agent: z.string(),
  js_version: z.string(),
});
const electronTargetSchema = z.object({
  target_id: z.string(),
  type: z.string(),
  title: z.string(),
  file_path: z.string(),
  attached: z.boolean(),
});

/** Complete local file target inventory from one Electron CDP endpoint. */
export const electronTargetListSchema = z.object({
  browser: browserVersionSchema,
  targets: z.array(electronTargetSchema),
  excluded: z.object({
    unsupported_url: z.number().int().min(0),
    non_page: z.number().int().min(0),
  }),
  limitations: z.array(z.string()),
});
export type ElectronTargetList = z.infer<typeof electronTargetListSchema>;

const electronSourceSchema = z.discriminatedUnion("included", [
  z.object({ included: z.literal(false), reason: z.string() }),
  z.object({ included: z.literal(true), artifact: webTextArtifactSchema }),
]);

/** Provider-neutral passive Electron file-page structure and script inventory. */
export const electronPageInspectionSchema = z.object({
  browser: browserVersionSchema,
  target: electronTargetSchema,
  capture_window: z.object({
    started_at: z.iso.datetime(),
    ended_at: z.iso.datetime(),
    observation_ms: z.number().int().min(0),
  }),
  completeness: browserCompletenessSchema,
  frames: z.array(
    z.object({
      frame_id: z.string(),
      parent_frame_id: z.string().nullable(),
      file_path: z.string(),
    }),
  ),
  dom: z.object({
    total_nodes: z.number().int().min(0),
    nodes: z.array(
      z.object({
        index: z.number().int().min(0),
        parent_index: z.number().int().min(-1),
        node_type: z.number().int().min(0),
        node_name: z.string(),
        node_value_length: z.number().int().min(0),
        attribute_names: z.array(z.string()),
      }),
    ),
  }),
  scripts: z.object({
    total: z.number().int().min(0),
    items: z.array(
      z.object({
        script_key: z.string().regex(/^electron_script_[a-f0-9]{64}$/u),
        frame_id: z.string().nullable().default(null),
        file_path: z.string(),
        cdp_hash: z.string(),
        length: z.number().int().min(0),
        is_module: z.boolean(),
        language: z.string().nullable(),
        source: electronSourceSchema,
      }),
    ),
  }),
  resources: z.array(
    z.object({
      resource_key: z.string().regex(/^electron_resource_[a-f0-9]{64}$/u),
      file_path: z.string(),
      type: z.string(),
      mime_type: z.string(),
      content_size: z.number().min(0).nullable(),
    }),
  ),
  workers: z
    .array(
      z.object({
        target_id: z.string().min(1),
        type: z.string().min(1),
        file_path: z.string(),
        attached: z.boolean(),
        opener_target_id: z.string().min(1).nullable(),
        parent_frame_id: z.string().min(1).nullable(),
      }),
    )
    .default([]),
  limitations: z.array(z.string()),
});
export type ElectronPageInspection = z.infer<
  typeof electronPageInspectionSchema
>;
