import { z } from "zod";

import { browserCompletenessSchema } from "./browserCompleteness.js";
import {
  browserAllowedOriginsSchema,
  browserEndpointSchema,
} from "./browserObservation.js";
import { browserVersionSchema } from "./browserObservationSchemas.js";
import { jsonValueSchema } from "./jsonValue.js";
import { digestSchema, prefixedDigestSchema } from "./../domain/digests.js";

/** Input for passive discovery of page-registered WebMCP tools. */
export const discoverWebMcpToolsInputSchema = z.strictObject({
  cdp_endpoint: browserEndpointSchema,
  allowed_origins: browserAllowedOriginsSchema,
  target_id: z.string().trim().min(1),
  observation_ms: z.number().int().min(0).default(100),
});
export type DiscoverWebMcpToolsInput = z.infer<
  typeof discoverWebMcpToolsInputSchema
>;

const webMcpToolSchema = z.object({
  tool_key: prefixedDigestSchema("webmcp"),
  name: z.string(),
  description: z.string(),
  frame_id: z.string(),
  frame_url: z.string(),
  owner_origin: z.string(),
  declaration_kind: z.enum(["declarative", "imperative"]),
  input_schema: jsonValueSchema.nullable(),
  input_schema_sha256: digestSchema.nullable(),
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
