import { z } from "zod";

import { browserCompletenessSchema } from "./browserCompleteness.js";
import { webTextArtifactSchema } from "./webContentArtifact.js";
import { jsonShapeSchema } from "./jsonShape.js";

const browserVersionSchema = z.object({
  product: z.string(),
  protocol_version: z.string(),
  revision: z.string(),
  user_agent: z.string(),
  js_version: z.string(),
});

const browserTargetSchema = z.object({
  target_id: z.string(),
  type: z.string(),
  title: z.string(),
  url: z.string(),
  origin: z.string(),
  attached: z.boolean(),
});

/** Bounded and policy-filtered browser target discovery result. */
export const browserTargetListSchema = z.object({
  schema_version: z.literal(1),
  browser: browserVersionSchema,
  targets: z.object({
    items: z.array(browserTargetSchema),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1),
    total: z.number().int().min(0),
    next_offset: z.number().int().min(0).nullable(),
    has_more: z.boolean(),
  }),
  excluded: z.object({
    disallowed_origin: z.number().int().min(0),
    unsupported_url: z.number().int().min(0),
    non_page: z.number().int().min(0),
  }),
  limitations: z.array(z.string()),
});
export type BrowserTargetList = z.infer<typeof browserTargetListSchema>;

const browserFrameSchema = z.object({
  frame_id: z.string(),
  parent_frame_id: z.string().nullable(),
  url: z.string(),
  origin: z.string().nullable(),
});
const browserDomNodeSchema = z.object({
  index: z.number().int().min(0),
  parent_index: z.number().int().min(-1),
  node_type: z.number().int().min(0),
  node_name: z.string(),
  node_value_length: z.number().int().min(0),
  attribute_names: z.array(z.string()),
});
const browserAxNodeSchema = z.object({
  node_id: z.string(),
  parent_id: z.string().nullable(),
  role: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  ignored: z.boolean(),
});
const browserScriptSourceSchema = z.discriminatedUnion("included", [
  z.object({ included: z.literal(false), reason: z.string() }),
  z.object({
    included: z.literal(true),
    artifact: webTextArtifactSchema,
  }),
]);
const browserResourceReconciliationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("exact"), resource_key: z.string() }),
  z.object({
    status: z.literal("ambiguous"),
    candidate_resource_keys: z.array(z.string()),
  }),
  z.object({
    status: z.literal("unmatched"),
    reason: z.literal("no_exact_sanitized_url"),
  }),
]);
const browserScriptSchema = z.object({
  script_key: z.string().regex(/^scr_[a-f0-9]{64}(?:_[0-9]+)?$/u),
  frame_id: z.string().nullable().default(null),
  url: z.string(),
  origin: z.string().nullable(),
  cdp_hash: z.string(),
  length: z.number().int().min(0),
  is_module: z.boolean(),
  language: z.string().nullable(),
  source_map_url: z.string().nullable(),
  resource_reconciliation: browserResourceReconciliationSchema,
  source: browserScriptSourceSchema,
});
const browserResourceSchema = z.object({
  resource_key: z.string().regex(/^res_[a-f0-9]{64}$/u),
  url: z.string(),
  origin: z.string().nullable(),
  type: z.string(),
  mime_type: z.string(),
  content_size: z.number().min(0).nullable(),
});
const browserNetworkRequestSchema = z.object({
  request_id: z.string(),
  url: z.string(),
  origin: z.string().nullable(),
  method: z.string(),
  resource_type: z.string().nullable(),
  status: z.number().nullable(),
  mime_type: z.string().nullable(),
  encoded_data_length: z.number().min(0).nullable(),
  initiator: z.object({
    type: z.string(),
    url: z.string().nullable(),
    line: z.number().int().min(0).nullable(),
    column: z.number().int().min(0).nullable(),
  }),
  body_shapes: z.object({
    status: z.enum([
      "not_approved",
      "included",
      "partial",
      "unavailable",
      "truncated",
    ]),
    request: jsonShapeSchema.nullable(),
    response: jsonShapeSchema.nullable(),
  }),
});
const browserConsoleEventSchema = z.object({
  type: z.string(),
  timestamp: z.number(),
  argument_types: z.array(z.string()),
  url: z.string().nullable(),
  line: z.number().int().min(0).nullable(),
  column: z.number().int().min(0).nullable(),
  text_capture: z.object({
    status: z.enum(["not_approved", "included", "truncated"]),
    values: z.array(
      z.object({
        argument_index: z.number().int().min(0),
        type: z.string(),
        text: z.string(),
      }),
    ),
    retained_bytes: z.number().int().min(0),
    truncated_values: z.number().int().min(0),
  }),
});
const browserWebSocketEventSchema = z.object({
  request_id: z.string(),
  direction: z.enum(["sent", "received"]),
  opcode: z.number().int().min(0),
  payload_bytes: z.number().int().min(0),
  payload_shape: z
    .object({
      format: z.enum(["json", "text", "binary"]),
      json_shape: jsonShapeSchema.nullable(),
      truncated: z.boolean(),
    })
    .nullable(),
});
const browserWorkerSchema = z.object({
  target_id: z.string(),
  type: z.string(),
  url: z.string(),
  origin: z.string().nullable(),
  attached: z.boolean(),
  opener_target_id: z.string().nullable().default(null),
  parent_frame_id: z.string().nullable().default(null),
});
const browserCspSourceSchema = z.object({
  kind: z.enum([
    "keyword",
    "scheme",
    "approved_origin",
    "external_origin",
    "other",
  ]),
  value: z.string().nullable(),
});
const browserLinkMetadataSchema = z.object({
  href: z.string().nullable(),
  destination_scope: z.enum(["approved", "outside_policy", "unsupported"]),
  rel: z.array(z.string()),
  as: z.string().nullable(),
  type: z.string().nullable(),
  crossorigin: z.string().nullable(),
});
const browserAgentHintSchema = z.object({
  mechanism: z.enum([
    "link_rel",
    "dom_link_rel",
    "well_known_resource",
    "response_header",
  ]),
  declaration: z.string(),
  url: z.string().nullable(),
  trust: z.literal("page-declared-untrusted"),
});
const browserSafeMetadataSchema = z.object({
  responses: z.array(
    z.object({
      request_id: z.string(),
      url: z.string(),
      mime_type: z.string().nullable(),
      content_length: z.number().int().min(0).nullable(),
      content_encoding: z.string().nullable(),
      csp: z.object({
        directives: z.array(
          z.object({
            name: z.string(),
            sources: z.array(browserCspSourceSchema),
          }),
        ),
        nonce_count: z.number().int().min(0),
        hash_count: z.number().int().min(0),
      }),
      links: z.array(browserLinkMetadataSchema),
      policies: z.object({
        coop: z.string().nullable(),
        coep: z.string().nullable(),
        corp: z.string().nullable(),
        referrer_policy: z.string().nullable(),
        x_content_type_options: z.string().nullable(),
        permissions_policy_features: z.array(z.string()),
      }),
    }),
  ),
  dom_urls: z.array(
    z.object({
      node_index: z.number().int().min(0),
      attribute: z.enum(["href", "src", "action", "formaction", "poster"]),
      url: z.string().nullable(),
      destination_scope: z.enum(["approved", "outside_policy", "unsupported"]),
    }),
  ),
  agent_hints: z.array(browserAgentHintSchema),
  excluded_dom_urls: z.number().int().min(0),
  headers_allowlisted: z.literal(true),
});

/** Provider-neutral normalized result for one passive web-page observation. */
export const webPageInspectionSchema = z.object({
  schema_version: z.literal(2),
  browser: browserVersionSchema,
  target: browserTargetSchema,
  capture_window: z.object({
    started_at: z.iso.datetime(),
    ended_at: z.iso.datetime(),
    observation_ms: z.number().int().min(0),
  }),
  completeness: browserCompletenessSchema,
  frames: z.array(browserFrameSchema),
  dom: z.object({
    total_nodes: z.number().int().min(0),
    nodes: z.array(browserDomNodeSchema),
  }),
  accessibility: z.object({
    total_nodes: z.number().int().min(0),
    text_capture: z.object({
      status: z.enum(["not_approved", "included", "truncated", "unavailable"]),
      retained_bytes: z.number().int().min(0),
      excluded_fields: z.number().int().min(0),
      truncated_fields: z.number().int().min(0),
    }),
    nodes: z.array(browserAxNodeSchema),
  }),
  scripts: z.object({
    total: z.number().int().min(0),
    items: z.array(browserScriptSchema),
  }),
  resources: z.array(browserResourceSchema),
  network: z.object({
    requests: z.array(browserNetworkRequestSchema),
    websocket_events: z.array(browserWebSocketEventSchema),
    coverage_started_at: z.iso.datetime(),
    prior_activity_available: z.literal(false),
  }),
  console: z.object({
    events: z.array(browserConsoleEventSchema),
    coverage_started_at: z.iso.datetime(),
    prior_activity_available: z.literal(false),
  }),
  workers: z.array(browserWorkerSchema),
  metadata: browserSafeMetadataSchema,
  storage: z.object({
    origin: z.string(),
    usage_bytes: z.number().min(0).nullable(),
    quota_bytes: z.number().min(0).nullable(),
    local_storage_keys: z.array(z.string()),
    session_storage_keys: z.array(z.string()),
    indexed_db_names: z.array(z.string()),
    cache_names: z.array(z.string()),
    values_redacted: z.literal(true),
  }),
  limitations: z.array(z.string()),
});
export type WebPageInspection = z.infer<typeof webPageInspectionSchema>;
