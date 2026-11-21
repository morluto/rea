import { MAX_NODE_TIMER_DELAY_MS } from "../domain/analysisResourceLimits.js";
import { readProviderRegistration } from "../providers/ReadProviderRegistration.js";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { jsonRecordSchema } from "../domain/jsonRecord.js";
import type { RetainedResourceScope } from "../ports/AnalysisProvider.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import type { AnalysisInputIssue } from "../domain/analysisErrorCore.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../domain/result.js";

/** Omitted registration `timeoutMs` for each upstream IDA MCP request. */
export const DEFAULT_IDA_REQUEST_TIMEOUT_MS = 300_000;
/** Shortest valid registration request timeout. */
const MIN_IDA_REQUEST_TIMEOUT_MS = 1;
/** Loopback names plus the Docker and Podman gateway names for the container's host. */
const LOCAL_IDA_HTTP_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "host.docker.internal",
  "host.containers.internal",
]);

const common = {
  sensitive: z
    .strictObject({
      headers: z.array(z.string().min(1)).default([]),
      env: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  mode: z.enum(["attached", "headless"]).default("attached"),
  /**
   * An attached registration names its upstream protocol. `"legacy"` (the
   * removed ida-pro-mcp 1.4 GUI proxy) is still recognized so that a stored
   * registration is refused with migration guidance rather than reported as an
   * unknown value or read as another protocol. Headless mode uses the database
   * supervisor when `protocol` is omitted, or `"hexrays"` for the official
   * Hex-Rays IDA MCP.
   */
  protocol: z.enum(["legacy", "native", "hexrays"]).optional(),
  timeoutMs: z
    .int()
    .min(MIN_IDA_REQUEST_TIMEOUT_MS)
    .max(MAX_NODE_TIMER_DELAY_MS)
    .default(DEFAULT_IDA_REQUEST_TIMEOUT_MS),
  workspaceRoot: z
    .string()
    .refine(isAbsolute, "workspaceRoot must be absolute on the REA host")
    .optional(),
};
/** Refusal for a stored registration that still selects the removed 1.4 proxy. */
export const LEGACY_PROTOCOL_REMOVED =
  'the legacy ida-pro-mcp 1.4 attached protocol was removed. Replace this registration with the native ida-free-mcp plugin ("protocol": "native") for an open GUI database, or an ida-pro-mcp 2.x database supervisor in headless mode, as described in "Migrate a legacy attached registration"';
const registrationSchema = z
  .union([
    z
      .object({
        ...common,
        type: z.literal("stdio").optional(),
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        env: jsonRecordSchema(z.string()).default({}),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal("http").optional(),
        url: z.url().refine((value) => {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            LOCAL_IDA_HTTP_HOSTS.has(url.hostname) &&
            url.username === "" &&
            url.password === ""
          );
        }, "IDA MCP must use a local HTTP endpoint without URL credentials"),
        headers: jsonRecordSchema(z.string()).default({}),
      })
      .strict(),
  ])
  .refine(
    (config) =>
      config.protocol === undefined ||
      config.protocol === "hexrays" ||
      config.mode === "attached",
    'An IDA MCP protocol requires attached mode; a headless registration omits protocol or sets "hexrays"',
  )
  .refine(
    (config) => config.protocol !== undefined || config.mode !== "attached",
    'attached IDA registrations must set protocol to "native" (ida-free-mcp plugin)',
  )
  // Hex-Rays database leases belong to the MCP server process. Only a stdio
  // registration gives REA a server, and therefore leases, of its own.
  .refine(
    (config) =>
      config.protocol !== "hexrays" ||
      (config.mode === "headless" && "command" in config),
    "The Hex-Rays IDA MCP protocol requires a headless stdio registration",
  )
  // Resolve the upstream protocol once; consumers never infer it from mode.
  .transform((config, context) => {
    if (config.protocol === "legacy") {
      context.addIssue({
        code: "custom",
        path: ["protocol"],
        message: LEGACY_PROTOCOL_REMOVED,
      });
      return z.NEVER;
    }
    return { ...config, protocol: config.protocol ?? ("modern" as const) };
  });

/** An upstream MCP registration plus REA's database lifecycle selection. */
export type IdaConfiguration = z.infer<typeof registrationSchema>;

/** Render only schema-owned constraints, never rejected registration values. */
const registrationConstraint = (
  issue: AnalysisInputIssue,
): string | undefined => {
  if (issue.path.length === 1 && issue.path[0] === "timeoutMs")
    return `timeoutMs must be an integer from ${String(MIN_IDA_REQUEST_TIMEOUT_MS)} to ${String(MAX_NODE_TIMER_DELAY_MS)} milliseconds`;
  return issue.message === undefined
    ? undefined
    : `${issue.path.join(".") || "registration"}: ${issue.message}`;
};

/** Resolved compatibility facts; persisted identities and diagnostics intentionally differ. */
export const IDA_COMPATIBILITY_PROFILES = {
  modern: {
    protocol: "modern",
    mode: "headless",
    identity: "database-supervisor",
    diagnosticIdentity: "database-supervisor",
    diagnosticLabel: "headless",
  },
  hexrays: {
    protocol: "hexrays",
    mode: "headless",
    identity: "hexrays-ida-mcp",
    diagnosticIdentity: "hexrays",
    diagnosticLabel: "Hex-Rays",
  },
  native: {
    protocol: "native",
    mode: "attached",
    identity: "native-ida-mcp",
    diagnosticIdentity: "native",
    diagnosticLabel: "native attached",
  },
} as const;
export type IdaCompatibilityProfile =
  (typeof IDA_COMPATIBILITY_PROFILES)[keyof typeof IDA_COMPATIBILITY_PROFILES];

/** The compatibility facts of the registration's resolved protocol. */
export const idaCompatibilityProfile = (
  config: IdaConfiguration,
): IdaCompatibilityProfile => IDA_COMPATIBILITY_PROFILES[config.protocol];

/** Read one explicit registration without starting or installing a provider. */
export const readIdaConfiguration = (
  path: string,
  options: {
    readonly signal?: AbortSignal;
    readonly resourceScope: RetainedResourceScope;
  },
): Promise<Result<IdaConfiguration, ConfigurationError>> =>
  readProviderRegistration(path, options, {
    setting: "REA_IDA_MCP_CONFIG",
    label: "IDA MCP",
    operation: "ida:registration",
    parse: (input) => {
      const envelope = z
        .object({ mcpServers: z.object({ "ida-pro-mcp": z.unknown() }) })
        .safeParse(input);
      const registration = envelope.success
        ? envelope.data.mcpServers["ida-pro-mcp"]
        : input;
      const parsed = registrationSchema.safeParse(registration);
      if (parsed.success) return ok(parsed.data);
      // Only schema-authored correction text is admitted; Zod's aggregate
      // message can contain registration values, including credentials.
      const constraints = projectInputIssues(
        parsed.error.issues,
        registration,
      ).flatMap((issue) => {
        const constraint = registrationConstraint(issue);
        return constraint === undefined ? [] : [constraint];
      });
      if (constraints.length === 0)
        return err(
          idaConfigurationError(
            "REA_IDA_MCP_CONFIG must contain an IDA MCP command/args or local url registration; see docs/providers/ida-provider.md.",
            parsed.error,
          ),
        );
      return err(
        new ConfigurationError(
          `REA_IDA_MCP_CONFIG: ${constraints.join("; ")}. See docs/providers/ida-provider.md.`,
          {
            cause: parsed.error,
            settings: constraints.map((constraint) => ({
              setting: "REA_IDA_MCP_CONFIG",
              constraint,
            })),
          },
        ),
      );
    },
  });

/**
 * Name the registration key that sets an IDA request or readiness deadline.
 * `ceilingMs` is the parsed `timeoutMs`; a shorter effective value is the time
 * remaining inside that ceiling.
 */
export const idaRegistrationTimeoutGuidance = (
  timeoutMs: number,
  phase: "request" | "readiness",
  ceilingMs: number = timeoutMs,
): { readonly userMessage: string; readonly remediationAction: string } => ({
  userMessage:
    phase === "readiness"
      ? `IDA readiness reached its ${String(timeoutMs)} ms deadline while the headless worker was still busy (deadlineExpired).`
      : ceilingMs === timeoutMs
        ? `This IDA request reached the registration timeoutMs deadline of ${String(timeoutMs)} ms (deadlineExpired).`
        : `This IDA request reached its ${String(timeoutMs)} ms deadline (deadlineExpired), within the registration timeoutMs ceiling of ${String(ceilingMs)} ms.`,
  remediationAction: `Set timeoutMs in the JSON file named by REA_IDA_MCP_CONFIG to an integer from 1 to ${String(MAX_NODE_TIMER_DELAY_MS)} (omitted means ${String(DEFAULT_IDA_REQUEST_TIMEOUT_MS)}). REA applies the edited file on the next IDA connection after it re-reads the registration; an already open session keeps the timeout it connected with. Allow execution, cleanup and delivery headroom in the outer MCP client deadline. Confirm outstanding work and cleanup before retrying.`,
});

/** A REA_IDA_MCP_CONFIG rejection that names the setting it concerns. */
export const idaConfigurationError = (
  constraint: string,
  cause?: unknown,
): ConfigurationError =>
  new ConfigurationError(constraint, {
    ...(cause === undefined ? {} : { cause }),
    settings: [{ setting: "REA_IDA_MCP_CONFIG", constraint }],
  });
