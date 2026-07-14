import { z } from "zod";

const parseExactOrigin = (value: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname.includes("*") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return undefined;
  return url.origin;
};

const MAX_BROWSER_URL_CHARS = 65_536;
const MAX_SANITIZED_BROWSER_URL_CHARS = 131_072;
const MAX_QUERY_PARAMETER_NAMES = 256;
const MAX_QUERY_PARAMETER_NAME_CHARS = 256;

/** Exact normalized HTTP(S) authority used for browser observation scope. */
export const browserOriginSchema = z
  .string()
  .min(1)
  .max(2_048)
  .transform((value, context) => {
    const origin = parseExactOrigin(value);
    if (origin === undefined) {
      context.addIssue({
        code: "custom",
        message: "Expected one exact HTTP(S) origin without a path or wildcard",
      });
      return z.NEVER;
    }
    return origin;
  });

const isLiteralLoopback = (hostname: string): boolean =>
  hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";

/** Loopback-only HTTP endpoint accepted for a user-owned CDP browser. */
export const browserEndpointSchema = z
  .string()
  .min(1)
  .max(2_048)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid CDP endpoint URL" });
      return z.NEVER;
    }
    if (
      url.protocol !== "http:" ||
      !isLiteralLoopback(url.hostname) ||
      url.port === "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      context.addIssue({
        code: "custom",
        message:
          "CDP endpoint must be an explicit-port HTTP URL on 127.0.0.1 or ::1",
      });
      return z.NEVER;
    }
    return url.origin;
  });

const allowedOriginsSchema = z
  .array(browserOriginSchema)
  .min(1)
  .max(32)
  .transform((origins) => [...new Set(origins)].sort());

const approvedBrowserInput = {
  cdp_endpoint: browserEndpointSchema,
  allowed_origins: allowedOriginsSchema,
  approved: z
    .literal(true)
    .describe("Explicit approval for browser observation"),
};

/** Public input for bounded discovery of allowed page targets. */
export const listBrowserTargetsInputSchema = z.object({
  ...approvedBrowserInput,
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(100),
});

const browserInspectionLimitsSchema = z.object({
  max_frames: z.number().int().min(1).max(1_000).default(200),
  max_dom_nodes: z.number().int().min(1).max(10_000).default(2_000),
  max_ax_nodes: z.number().int().min(1).max(10_000).default(2_000),
  max_scripts: z.number().int().min(1).max(1_000).default(200),
  max_resources: z.number().int().min(1).max(10_000).default(2_000),
  max_workers: z.number().int().min(1).max(5_000).default(500),
  max_storage_keys: z.number().int().min(1).max(10_000).default(1_000),
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
  max_network_events: z.number().int().min(1).max(10_000).default(1_000),
  max_console_events: z.number().int().min(1).max(2_000).default(200),
  max_websocket_events: z.number().int().min(1).max(5_000).default(500),
});

const DEFAULT_BROWSER_INSPECTION_LIMITS = {
  max_frames: 200,
  max_dom_nodes: 2_000,
  max_ax_nodes: 2_000,
  max_scripts: 200,
  max_resources: 2_000,
  max_workers: 500,
  max_storage_keys: 1_000,
  max_script_source_bytes: 1_024 * 1_024,
  max_total_script_source_bytes: 4 * 1_024 * 1_024,
  max_network_events: 1_000,
  max_console_events: 200,
  max_websocket_events: 500,
} as const;

/** Public input for one passive, bounded inspection of an existing page. */
export const inspectWebPageInputSchema = z
  .object({
    ...approvedBrowserInput,
    target_id: z.string().trim().min(1).max(256),
    observation_ms: z.number().int().min(0).max(10_000).default(500),
    include_script_sources: z.boolean().default(false),
    include_storage_keys: z.boolean().default(false),
    limits: browserInspectionLimitsSchema.default(
      DEFAULT_BROWSER_INSPECTION_LIMITS,
    ),
  })
  .superRefine((input, context) => {
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

export type ListBrowserTargetsInput = z.infer<
  typeof listBrowserTargetsInputSchema
>;
export type InspectWebPageInput = z.infer<typeof inspectWebPageInputSchema>;

const sanitizedBrowserUrlSchema = z.object({
  url: z.string().max(MAX_SANITIZED_BROWSER_URL_CHARS),
  origin: z.string().max(2_048).nullable(),
  query_parameter_names: z
    .array(z.string().max(MAX_QUERY_PARAMETER_NAME_CHARS))
    .max(MAX_QUERY_PARAMETER_NAMES),
  redacted: z.boolean(),
});
export type SanitizedBrowserUrl = z.infer<typeof sanitizedBrowserUrlSchema>;

/** Remove credentials and query values before a browser URL becomes durable. */
export const sanitizeBrowserUrl = (value: string): SanitizedBrowserUrl => {
  let parsed: URL;
  const wasTruncated = value.length > MAX_BROWSER_URL_CHARS;
  try {
    parsed = new URL(value.slice(0, MAX_BROWSER_URL_CHARS));
  } catch {
    return {
      url: "[unsupported-url]",
      origin: null,
      query_parameter_names: [],
      redacted: true,
    };
  }
  const hadCredentials = parsed.username !== "" || parsed.password !== "";
  const hadFragment = parsed.hash !== "";
  const names = [
    ...new Set(
      [...parsed.searchParams.keys()].map((name) =>
        name.slice(0, MAX_QUERY_PARAMETER_NAME_CHARS),
      ),
    ),
  ]
    .sort()
    .slice(0, MAX_QUERY_PARAMETER_NAMES);
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.search = "";
  for (const name of names) parsed.searchParams.append(name, "[REDACTED]");
  return {
    url: parsed.href,
    origin: parsed.origin === "null" ? null : parsed.origin,
    query_parameter_names: names,
    redacted: wasTruncated || hadCredentials || hadFragment || names.length > 0,
  };
};

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
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().min(0),
    content: z.string(),
  }),
]);
const browserScriptSchema = z.object({
  script_id: z.string(),
  url: z.string(),
  origin: z.string().nullable(),
  cdp_hash: z.string(),
  length: z.number().int().min(0),
  is_module: z.boolean(),
  language: z.string().nullable(),
  source_map_url: z.string().nullable(),
  source: browserScriptSourceSchema,
});
const browserResourceSchema = z.object({
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
});
const browserConsoleEventSchema = z.object({
  type: z.string(),
  timestamp: z.number(),
  argument_types: z.array(z.string()),
  url: z.string().nullable(),
  line: z.number().int().min(0).nullable(),
  column: z.number().int().min(0).nullable(),
});
const browserWebSocketEventSchema = z.object({
  request_id: z.string(),
  direction: z.enum(["sent", "received"]),
  opcode: z.number().int().min(0),
  payload_bytes: z.number().int().min(0),
});
const browserWorkerSchema = z.object({
  target_id: z.string(),
  type: z.string(),
  url: z.string(),
  origin: z.string().nullable(),
  attached: z.boolean(),
});

/** Provider-neutral normalized result for one passive web-page observation. */
export const webPageInspectionSchema = z.object({
  schema_version: z.literal(1),
  browser: browserVersionSchema,
  target: browserTargetSchema,
  capture_window: z.object({
    started_at: z.iso.datetime(),
    ended_at: z.iso.datetime(),
    observation_ms: z.number().int().min(0),
  }),
  completeness: z.object({
    status: z.enum(["complete", "truncated"]),
    truncated_sections: z.array(z.string()),
    dropped_events: z.number().int().min(0),
  }),
  frames: z.array(browserFrameSchema),
  dom: z.object({
    total_nodes: z.number().int().min(0),
    nodes: z.array(browserDomNodeSchema),
  }),
  accessibility: z.object({
    total_nodes: z.number().int().min(0),
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
