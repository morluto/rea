import { z } from "zod";

import { browserCompletenessSchema } from "./browserCompleteness.js";
import {
  browserAllowedOriginsSchema,
  browserEndpointSchema,
} from "./browserObservation.js";
import { jsonShapeSchema } from "./jsonShape.js";

/** Input for passive discovery of page-registered WebMCP tools. */
export const discoverWebMcpToolsInputSchema = z.object({
  cdp_endpoint: browserEndpointSchema,
  allowed_origins: browserAllowedOriginsSchema,
  target_id: z.string().trim().min(1).max(256),
  approved: z.literal(true),
  observation_ms: z.number().int().min(0).max(10_000).default(100),
  max_tools: z.number().int().min(1).max(5_000).default(500),
  max_schema_bytes: z
    .number()
    .int()
    .min(1)
    .max(1_024 * 1_024)
    .default(256 * 1_024),
  max_schema_nodes: z.number().int().min(1).max(100_000).default(5_000),
  max_schema_depth: z.number().int().min(1).max(100).default(20),
});
export type DiscoverWebMcpToolsInput = z.infer<
  typeof discoverWebMcpToolsInputSchema
>;

const browserVersionSchema = z.object({
  product: z.string(),
  protocol_version: z.string(),
  revision: z.string(),
  user_agent: z.string(),
  js_version: z.string(),
});

const webMcpToolSchema = z.object({
  tool_key: z.string().regex(/^webmcp_[a-f0-9]{64}$/u),
  name: z.string(),
  description: z.string(),
  frame_id: z.string(),
  frame_url: z.string(),
  owner_origin: z.string(),
  declaration_kind: z.enum(["declarative", "imperative"]),
  input_schema_shape: jsonShapeSchema.nullable(),
  annotations: z.object({
    read_only: z.boolean().nullable(),
    untrusted_content: z.boolean().nullable(),
    autosubmit: z.boolean().nullable(),
  }),
  registration_source: z
    .object({
      url: z.string(),
      line: z.number().int().min(0).nullable(),
      column: z.number().int().min(0).nullable(),
    })
    .nullable(),
  trust: z.literal("page-declared-untrusted"),
});

/** Passive WebMCP inventory; it intentionally has no invocation surface. */
export const webMcpDiscoverySchema = z.object({
  schema_version: z.literal(1),
  browser: browserVersionSchema,
  target: z.object({
    target_id: z.string(),
    url: z.string(),
    origin: z.string(),
  }),
  status: z.enum(["available", "unavailable"]),
  tools: z.object({
    total: z.number().int().min(0),
    items: z.array(webMcpToolSchema),
  }),
  completeness: browserCompletenessSchema,
  limitations: z.array(z.string()),
});
export type WebMcpDiscovery = z.infer<typeof webMcpDiscoverySchema>;
