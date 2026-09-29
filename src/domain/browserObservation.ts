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

/** Exact normalized HTTP(S) authority used for browser observation scope. */
export const browserOriginSchema = z
  .string()
  .min(1)
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
  .transform((origins) => Array.from(new Set(origins)).sort());

const browserInput = {
  cdp_endpoint: browserEndpointSchema,
  allowed_origins: browserAllowedOriginsSchema,
};

/** Public input for complete discovery of allowed page targets. */
export const listBrowserTargetsInputSchema = z.object({
  ...browserInput,
});

const inspectWebPageInputFacts = {
  ...browserInput,
  target_id: z.string().trim().min(1),
  observation_ms: z.number().int().min(0).default(500),
  include_accessibility_text: z.boolean().default(false),
  include_console_text: z.boolean().default(false),
  include_json_body_shapes: z.boolean().default(false),
  include_websocket_shapes: z.boolean().default(false),
  include_storage_keys: z.boolean().default(false),
  include_storage_fingerprints: z.boolean().default(false),
} as const;

const inspectWebPageWithoutSourceSchema = z.strictObject({
  ...inspectWebPageInputFacts,
  include_script_sources: z.literal(false).default(false),
});

const inspectWebPageWithSourceShapeSchema = z.strictObject({
  ...inspectWebPageInputFacts,
  include_script_sources: z.literal(true).default(true),
});

type InspectWebPageShape =
  | z.output<typeof inspectWebPageWithoutSourceSchema>
  | z.output<typeof inspectWebPageWithSourceShapeSchema>;

const refineInspectWebPageInput = (
  input: InspectWebPageShape,
  context: z.RefinementCtx,
): void => {
  if (input.include_storage_fingerprints && !input.include_storage_keys)
    context.addIssue({
      code: "custom",
      path: ["include_storage_fingerprints"],
      message: "Storage fingerprints require storage key capture",
    });
};

/** Caller schema for source-capturing inspection and bundle analysis. */
export const inspectWebPageWithSourceInputSchema =
  inspectWebPageWithSourceShapeSchema.superRefine(refineInspectWebPageInput);

/** Caller-visible schema for one passive inspection. */
export const inspectWebPageInputSchema = z.union([
  inspectWebPageWithoutSourceSchema.superRefine(refineInspectWebPageInput),
  inspectWebPageWithSourceInputSchema,
]);

export type ListBrowserTargetsInput = z.infer<
  typeof listBrowserTargetsInputSchema
>;
export type InspectWebPageInput = z.infer<typeof inspectWebPageInputSchema>;

export const sanitizedBrowserUrlSchema = z.object({
  url: z.string(),
  origin: z.string().nullable(),
  query_parameter_names: z.array(z.string()),
  redacted: z.boolean(),
});
export type SanitizedBrowserUrl = z.infer<typeof sanitizedBrowserUrlSchema>;

/** Remove credentials and query values before a browser URL becomes durable. */
export const sanitizeBrowserUrl = (value: string): SanitizedBrowserUrl => {
  let parsed: URL;
  try {
    parsed = new URL(value);
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
  const names = [...new Set(parsed.searchParams.keys())].sort();
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.search = "";
  for (const name of names) parsed.searchParams.append(name, "[REDACTED]");
  return {
    url: parsed.href,
    origin: parsed.origin === "null" ? null : parsed.origin,
    query_parameter_names: names,
    redacted: hadCredentials || hadFragment || names.length > 0,
  };
};

/** Remove credentials, fragments, and query values from endpoint candidates. */
export const sanitizeEndpointCandidate = (value: string): string => {
  try {
    const parsed = new URL(value, "https://rea.invalid");
    const sanitized = sanitizeBrowserUrl(parsed.href).url;
    return parsed.origin === "https://rea.invalid"
      ? sanitized.replace("https://rea.invalid", "")
      : sanitized;
  } catch {
    return value.split("#", 1)[0]?.split("?", 1)[0] ?? "";
  }
};
