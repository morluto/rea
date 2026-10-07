import { Cli, z } from "incur";

import {
  listJavaScriptRuntimeTargets,
  observeJavaScriptRuntime,
} from "./application/JavaScriptRuntimeObservationService.js";
import { createJavaScriptRuntimeObservationProvider } from "./composition/javascriptRuntimeObservation.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { logCliCommand } from "./cliLogging.js";
import {
  javascriptRuntimeKindSchema,
  listJavaScriptRuntimeTargetsInputSchema,
  observeJavaScriptRuntimeInputSchema,
} from "./domain/javascriptRuntimeObservation.js";
import { AnalysisInputError } from "./domain/analysisErrorCore.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";
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
          const context = runtimeContext();
          const parsed = listJavaScriptRuntimeTargetsInputSchema.safeParse({
            inspector_endpoint: args.endpoint,
          });
          if (!parsed.success)
            return inputError("list_javascript_runtime_targets");
          const result = await listJavaScriptRuntimeTargets(
            context.provider,
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
        const context = runtimeContext();
        const parsed = observeJavaScriptRuntimeInputSchema.safeParse({
          inspector_endpoint: args.endpoint,
          target_id: args.targetId,
          runtime_kind: options.runtimeKind,
          observation_ms: options.observationMs,
        });
        if (!parsed.success) return inputError("observe_javascript_runtime");
        const result = await observeJavaScriptRuntime(
          context.provider,
          parsed.data,
        );
        return result.ok ? result.value : cliError(result.error);
      }),
  });
};

const runtimeContext = () => ({
  provider: createJavaScriptRuntimeObservationProvider(),
});

const inputError = (operation: string): JsonValue =>
  cliError(new AnalysisInputError(operation));

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "JavaScript runtime observation failed",
  ...projectAnalysisError(error),
});
