import { z } from "zod";

export {
  browserTargetListSchema,
  webPageInspectionSchema,
  type BrowserTargetList,
  type WebPageInspection,
} from "./browserObservationSchemas.js";

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

/** Recognize the URL API's bracketed IPv6 form and normalized bare literals. */
export const isLiteralLoopbackHostname = (hostname: string): boolean =>
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
      !isLiteralLoopbackHostname(url.hostname) ||
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

export const browserAllowedOriginsSchema = z
  .array(browserOriginSchema)
  .min(1)
  .max(32)
  .transform((origins) => [...new Set(origins)].sort());

const approvedBrowserInput = {
  cdp_endpoint: browserEndpointSchema,
  allowed_origins: browserAllowedOriginsSchema,
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
  max_ax_text_field_bytes: z
    .number()
    .int()
    .min(1)
    .max(16 * 1_024)
    .default(1_024),
  max_total_ax_text_bytes: z
    .number()
    .int()
    .min(1)
    .max(1_024 * 1_024)
    .default(64 * 1_024),
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
  max_console_text_field_bytes: z
    .number()
    .int()
    .min(1)
    .max(16 * 1_024)
    .default(1_024),
  max_total_console_text_bytes: z
    .number()
    .int()
    .min(1)
    .max(1_024 * 1_024)
    .default(64 * 1_024),
  max_json_body_bytes: z
    .number()
    .int()
    .min(1)
    .max(4 * 1_024 * 1_024)
    .default(1_024 * 1_024),
  max_total_json_body_bytes: z
    .number()
    .int()
    .min(1)
    .max(16 * 1_024 * 1_024)
    .default(4 * 1_024 * 1_024),
  max_json_shape_nodes: z.number().int().min(1).max(100_000).default(5_000),
  max_json_shape_depth: z.number().int().min(1).max(100).default(20),
  max_websocket_events: z.number().int().min(1).max(5_000).default(500),
  max_websocket_shape_bytes: z
    .number()
    .int()
    .min(1)
    .max(1_024 * 1_024)
    .default(64 * 1_024),
  max_total_websocket_shape_bytes: z
    .number()
    .int()
    .min(1)
    .max(16 * 1_024 * 1_024)
    .default(1_024 * 1_024),
});

const DEFAULT_BROWSER_INSPECTION_LIMITS = {
  max_frames: 200,
  max_dom_nodes: 2_000,
  max_ax_nodes: 2_000,
  max_ax_text_field_bytes: 1_024,
  max_total_ax_text_bytes: 64 * 1_024,
  max_scripts: 200,
  max_resources: 2_000,
  max_workers: 500,
  max_storage_keys: 1_000,
  max_script_source_bytes: 1_024 * 1_024,
  max_total_script_source_bytes: 4 * 1_024 * 1_024,
  max_network_events: 1_000,
  max_console_events: 200,
  max_console_text_field_bytes: 1_024,
  max_total_console_text_bytes: 64 * 1_024,
  max_json_body_bytes: 1_024 * 1_024,
  max_total_json_body_bytes: 4 * 1_024 * 1_024,
  max_json_shape_nodes: 5_000,
  max_json_shape_depth: 20,
  max_websocket_events: 500,
  max_websocket_shape_bytes: 64 * 1_024,
  max_total_websocket_shape_bytes: 1_024 * 1_024,
} as const;

/** Public input for one passive, bounded inspection of an existing page. */
export const inspectWebPageInputSchema = z
  .object({
    ...approvedBrowserInput,
    target_id: z.string().trim().min(1).max(256),
    observation_ms: z.number().int().min(0).max(10_000).default(500),
    include_accessibility_text: z.boolean().default(false),
    include_console_text: z.boolean().default(false),
    console_text_approved: z.boolean().default(false),
    include_json_body_shapes: z.boolean().default(false),
    json_body_schema_approved: z.boolean().default(false),
    include_websocket_shapes: z.boolean().default(false),
    websocket_shape_approved: z.boolean().default(false),
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
    for (const [include, approved, path, message] of [
      [
        input.include_console_text,
        input.console_text_approved,
        "console_text_approved",
        "Console text capture requires separate approval",
      ],
      [
        input.include_json_body_shapes,
        input.json_body_schema_approved,
        "json_body_schema_approved",
        "JSON body schema capture requires separate approval",
      ],
      [
        input.include_websocket_shapes,
        input.websocket_shape_approved,
        "websocket_shape_approved",
        "WebSocket shape capture requires separate approval",
      ],
    ] as const)
      if (include && !approved)
        context.addIssue({ code: "custom", path: [path], message });
    if (
      input.limits.max_console_text_field_bytes >
      input.limits.max_total_console_text_bytes
    )
      context.addIssue({
        code: "custom",
        path: ["limits", "max_console_text_field_bytes"],
        message:
          "Per-field console text limit cannot exceed the total text limit",
      });
    if (
      input.limits.max_json_body_bytes > input.limits.max_total_json_body_bytes
    )
      context.addIssue({
        code: "custom",
        path: ["limits", "max_json_body_bytes"],
        message: "Per-body JSON limit cannot exceed the total body limit",
      });
    if (
      input.limits.max_websocket_shape_bytes >
      input.limits.max_total_websocket_shape_bytes
    )
      context.addIssue({
        code: "custom",
        path: ["limits", "max_websocket_shape_bytes"],
        message:
          "Per-frame WebSocket limit cannot exceed the total frame limit",
      });
    if (
      input.limits.max_ax_text_field_bytes >
      input.limits.max_total_ax_text_bytes
    )
      context.addIssue({
        code: "custom",
        path: ["limits", "max_ax_text_field_bytes"],
        message:
          "Per-field accessibility text limit cannot exceed the total text limit",
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
