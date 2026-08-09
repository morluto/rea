import { Cli, z } from "incur";

import {
  listJavaScriptRuntimeTargets,
  observeJavaScriptRuntime,
} from "./application/JavaScriptRuntimeObservationService.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import { V8InspectorProvider } from "./browser/V8InspectorProvider.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { logCliCommand } from "./cliLogging.js";
import { parseConfig } from "./config.js";
import { v8InspectorLocationScopes } from "./config/passiveObservation.js";
import {
  javascriptRuntimeKindSchema,
  listJavaScriptRuntimeTargetsInputSchema,
  observeJavaScriptRuntimeInputSchema,
} from "./domain/javascriptRuntimeObservation.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  projectAnalysisError,
} from "./domain/errors.js";
import type { JsonValue } from "./domain/jsonValue.js";
import type { Logger } from "./logger.js";

const scopeOptions = {
  allowedFileRoots: z
    .array(z.string().min(1))
    .optional()
    .describe("Exact roots; defaults to REA_V8_INSPECTOR_FILE_ROOTS_JSON"),
  allowedOrigins: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Exact origins; defaults to REA_V8_INSPECTOR_ALLOWED_ORIGINS_JSON",
    ),
  approved: z.boolean().default(false).describe("Approve passive attachment"),
};

const listOptionsSchema = z.object({
  ...scopeOptions,
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Zero-based target offset"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(100)
    .describe("Maximum targets to return"),
});

const observeOptionsSchema = z.object({
  ...scopeOptions,
  runtimeKind: javascriptRuntimeKindSchema.describe(
    "Declared target role; Inspector cannot authenticate the Electron role",
  ),
  observationMs: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(100)
    .describe("Bounded observation window in milliseconds"),
  maxEvents: z
    .number()
    .int()
    .min(1)
    .max(50_000)
    .default(10_000)
    .describe("Maximum retained protocol events"),
  maxScripts: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(2_000)
    .describe("Maximum retained scripts"),
  maxExecutionContexts: z
    .number()
    .int()
    .min(1)
    .max(5_000)
    .default(1_000)
    .describe("Maximum retained execution contexts"),
  maxLocationBytes: z
    .number()
    .int()
    .min(64)
    .max(65_536)
    .default(16_384)
    .describe("Maximum bytes in one protocol location"),
  maxTotalMetadataBytes: z
    .number()
    .int()
    .min(1_024)
    .max(32 * 1_024 * 1_024)
    .default(4 * 1_024 * 1_024)
    .describe("Maximum retained metadata bytes"),
});

/** Register CLI equivalents of passive V8 Inspector tools. */
export const registerJavaScriptRuntimeObservationCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.listJavaScriptRuntimeTargets, {
    description: "List approved Node/Electron V8 Inspector targets",
    args: z.object({
      endpoint: z.string().describe("Configured literal-loopback endpoint"),
    }),
    options: listOptionsSchema,
    run: ({ args, options }) =>
      logCliCommand(
        logger,
        CLI_COMMANDS.listJavaScriptRuntimeTargets,
        async () => {
          const context = await runtimeContext(
            "list_javascript_runtime_targets",
          );
          if (!context.ok) return context.error;
          const parsed = listJavaScriptRuntimeTargetsInputSchema.safeParse({
            inspector_endpoint: args.endpoint,
            allowed_file_roots:
              options.allowedFileRoots ?? context.allowedFileRoots,
            allowed_origins: options.allowedOrigins ?? context.allowedOrigins,
            approved: options.approved,
            offset: options.offset,
            limit: options.limit,
          });
          if (!parsed.success)
            return inputError("list_javascript_runtime_targets");
          const result = await listJavaScriptRuntimeTargets(
            context.provider,
            context.authority,
            parsed.data,
          );
          return result.ok ? result.value : cliError(result.error);
        },
      ),
  });

  cli.command(CLI_COMMANDS.observeJavaScriptRuntime, {
    description: "Passively observe one exact Node/Electron Inspector target",
    args: z.object({
      endpoint: z.string().describe("Configured literal-loopback endpoint"),
      targetId: z
        .string()
        .describe("Target from list-javascript-runtime-targets"),
    }),
    options: observeOptionsSchema,
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.observeJavaScriptRuntime, async () => {
        const context = await runtimeContext("observe_javascript_runtime");
        if (!context.ok) return context.error;
        const parsed = observeJavaScriptRuntimeInputSchema.safeParse({
          inspector_endpoint: args.endpoint,
          allowed_file_roots:
            options.allowedFileRoots ?? context.allowedFileRoots,
          allowed_origins: options.allowedOrigins ?? context.allowedOrigins,
          target_id: args.targetId,
          runtime_kind: options.runtimeKind,
          approved: options.approved,
          observation_ms: options.observationMs,
          limits: {
            max_events: options.maxEvents,
            max_scripts: options.maxScripts,
            max_execution_contexts: options.maxExecutionContexts,
            max_location_bytes: options.maxLocationBytes,
            max_total_metadata_bytes: options.maxTotalMetadataBytes,
          },
        });
        if (!parsed.success) return inputError("observe_javascript_runtime");
        const result = await observeJavaScriptRuntime(
          context.provider,
          context.authority,
          parsed.data,
        );
        return result.ok ? result.value : cliError(result.error);
      }),
  });
};

const runtimeContext = async (operation: string) => {
  const config = parseConfig(process.env);
  if (!config.ok) return { ok: false as const, error: cliError(config.error) };
  const policy = config.value.v8InspectorObservationPolicy;
  if (policy.status === "disabled")
    return {
      ok: false as const,
      error: cliError(
        new AnalysisCapabilityUnavailableError(
          "rea-v8-inspector",
          operation,
          "V8 Inspector observation is disabled; configure exact endpoints and file or origin scopes before enabling it",
        ),
      ),
    };
  const authority = await loadConfiguredPermissionAuthority(config.value);
  if (!authority.ok)
    return { ok: false as const, error: cliError(authority.error) };
  const scopes = v8InspectorLocationScopes(policy.locations);
  return {
    ok: true as const,
    authority: authority.value,
    provider: new V8InspectorProvider(),
    allowedFileRoots: scopes.fileRoots,
    allowedOrigins: scopes.allowedOrigins,
  };
};

const inputError = (operation: string): JsonValue =>
  cliError(new AnalysisInputError(operation));

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "JavaScript runtime observation failed",
  ...projectAnalysisError(error),
});
