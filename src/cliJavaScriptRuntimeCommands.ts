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

const observeOptionsSchema = z.object({
  runtimeKind: javascriptRuntimeKindSchema
    .optional()
    .describe(
      "Declared target role; Inspector cannot authenticate the Electron role",
    ),
  observationMs: z
    .number()
    .int()
    .min(0)
    .default(100)
    .describe("Observation window in milliseconds"),
});

/** Register CLI equivalents of passive V8 Inspector tools. */
export const registerJavaScriptRuntimeObservationCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void => {
  cli.command(CLI_COMMANDS.listJavaScriptRuntimeTargets, {
    description: "List Node/Electron V8 Inspector targets",
    args: z.object({
      endpoint: z.string().describe("Literal-loopback Inspector endpoint"),
    }),
    run: ({ args }) =>
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
      endpoint: z.string().describe("Literal-loopback Inspector endpoint"),
      targetId: z
        .string()
        .describe("Target from list-javascript-runtime-targets"),
    }),
    options: observeOptionsSchema,
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.observeJavaScriptRuntime, async () => {
        const context = await runtimeContext("observe_javascript_runtime", environment);
        if (!context.ok) return context.error;
        const parsed = observeJavaScriptRuntimeInputSchema.safeParse({
          inspector_endpoint: args.endpoint,
          target_id: args.targetId,
          runtime_kind: options.runtimeKind,
          observation_ms: options.observationMs,
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

const runtimeContext = async (
  operation: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const config = parseConfig(environment);
  if (!config.ok) return { ok: false as const, error: cliError(config.error) };
  const policy = config.value.v8InspectorObservationPolicy;
  if (policy.status === "disabled")
    return {
      ok: false as const,
      error: cliError(
        new AnalysisCapabilityUnavailableError(
          "rea-v8-inspector",
          operation,
          "V8 Inspector observation is disabled; enable REA_V8_INSPECTOR_OBSERVE_ENABLED to authorize loopback endpoints",
        ),
      ),
    };
  const authority = await loadConfiguredPermissionAuthority(config.value);
  if (!authority.ok)
    return { ok: false as const, error: cliError(authority.error) };
  return {
    ok: true as const,
    authority: authority.value,
    provider: new V8InspectorProvider(),
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
