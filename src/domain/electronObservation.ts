import { isAbsolute } from "node:path";

import { z } from "zod";

import { browserCompletenessSchema } from "./browserCompleteness.js";
import { browserEndpointSchema } from "./browserObservation.js";
import { webTextArtifactSchema } from "./webContentArtifact.js";

/** Absolute operator-approved filesystem roots for Electron file pages. */
export const electronFileRootsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(16_384)
      .refine(isAbsolute, "Electron file roots must be absolute paths"),
  )
  .min(1)
  .max(32)
  .transform((roots) => [...new Set(roots)].sort());

const approvedElectronInput = {
  cdp_endpoint: browserEndpointSchema,
  allowed_file_roots: electronFileRootsSchema,
  approved: z.literal(true),
};

/** Input for listing root-confined file:// page targets from Electron CDP. */
export const listElectronTargetsInputSchema = z.object({
  ...approvedElectronInput,
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(100),
});
export type ListElectronTargetsInput = z.infer<
  typeof listElectronTargetsInputSchema
>;

/** Input for passive structural inspection of one Electron file page. */
export const inspectElectronPageInputSchema = z
  .object({
    ...approvedElectronInput,
    target_id: z.string().trim().min(1).max(256),
    observation_ms: z.number().int().min(0).max(10_000).default(100),
    include_script_sources: z.boolean().default(false),
    source_capture_approved: z.boolean().default(false),
    limits: z
      .object({
        max_frames: z.number().int().min(1).max(1_000).default(200),
        max_dom_nodes: z.number().int().min(1).max(10_000).default(2_000),
        max_scripts: z.number().int().min(1).max(2_000).default(500),
        max_resources: z.number().int().min(1).max(10_000).default(2_000),
        max_workers: z.number().int().min(1).max(5_000).default(500),
        max_script_source_bytes: z
          .number()
          .int()
          .min(1)
          .max(4 * 1_024 * 1_024)
          .default(1_024 * 1_024),
        max_total_script_source_bytes: z
          .number()
          .int()
          .min(1)
          .max(16 * 1_024 * 1_024)
          .default(4 * 1_024 * 1_024),
      })
      .default({
        max_frames: 200,
        max_dom_nodes: 2_000,
        max_scripts: 500,
        max_resources: 2_000,
        max_workers: 500,
        max_script_source_bytes: 1_024 * 1_024,
        max_total_script_source_bytes: 4 * 1_024 * 1_024,
      }),
  })
  .superRefine((input, context) => {
    if (input.include_script_sources && !input.source_capture_approved)
      context.addIssue({
        code: "custom",
        path: ["source_capture_approved"],
        message: "Electron script source capture requires separate approval",
      });
    if (
      input.limits.max_script_source_bytes >
      input.limits.max_total_script_source_bytes
    )
      context.addIssue({
        code: "custom",
        path: ["limits", "max_script_source_bytes"],
        message: "Per-script source limit cannot exceed the total source limit",
      });
  });
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

/** Root-filtered Electron file target inventory. */
export const electronTargetListSchema = z.object({
  schema_version: z.literal(1),
  browser: browserVersionSchema,
  targets: z.object({
    items: z.array(electronTargetSchema),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1),
    total: z.number().int().min(0),
    next_offset: z.number().int().min(0).nullable(),
    has_more: z.boolean(),
  }),
  excluded: z.object({
    outside_root: z.number().int().min(0),
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
  schema_version: z.literal(1),
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
        target_id: z.string().min(1).max(256),
        type: z.string().min(1).max(100),
        file_path: z.string(),
        attached: z.boolean(),
        opener_target_id: z.string().min(1).max(256).nullable(),
        parent_frame_id: z.string().min(1).max(256).nullable(),
      }),
    )
    .default([]),
  limitations: z.array(z.string()),
});
export type ElectronPageInspection = z.infer<
  typeof electronPageInspectionSchema
>;
