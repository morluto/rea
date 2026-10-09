import { Cli, z } from "incur";

import {
  inspectElectronPage,
  listElectronTargets,
} from "../application/javascript/ElectronObservationService.js";
import { captureElectronScenario } from "../application/javascript/ElectronActiveObservationService.js";
import { reconcileJavaScriptRuntimeEvidence } from "../application/javascript/JavaScriptRuntimeReconciliationService.js";
import { logCliCommand } from "../cliLogging.js";
import {
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
} from "../domain/javascript/electronObservation.js";
import { electronActiveObservationInputSchema } from "../domain/javascript/electronActiveObservation.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Logger } from "../logger.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput, resolveCliJsonPaths } from "../cliJsonInput.js";
import {
  electronPageInspectionOptions,
  javascriptApplicationOptions,
} from "../cliObservationOptions.js";
import { runCliJavaScriptApplicationAnalysis } from "./javascriptApplicationAnalysis.js";
import type { CliResultOutput } from "./streamedJsonOutput.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Register CLI equivalents of the Electron MCP tools. */
export const registerElectronCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  resultOutput?: CliResultOutput,
): void => {
  registerElectronObservationCommands(cli, logger);
  registerElectronActiveCommand(cli, logger, environment);
  registerJavaScriptApplicationCommand(cli, logger, resultOutput);
  registerJavaScriptRuntimeReconciliationCommand(cli, logger);
};

const registerElectronActiveCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  cli.command(CLI_COMMANDS.captureElectronScenario, {
    description: "Run one owned Electron scenario with cancellable actions",
    args: z.object({
      inputJson: z
        .string()
        .describe(
          "Inline JSON or a JSON file matching capture_electron_scenario",
        ),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.captureElectronScenario,
          async () => {
            const input = await parseCliJsonInput(
              args.inputJson,
              "capture_electron_scenario",
            );
            if (!input.ok) return input.error;
            const parsed = electronActiveObservationInputSchema.safeParse(
              resolveCliJsonPaths(input.value, [
                ["executable_path"],
                ["application_path"],
                ["application_root"],
              ]),
            );
            if (!parsed.success)
              return inputError(
                "capture_electron_scenario",
                parsed.error.issues,
                input.value,
              );
            const { createElectronScenarioProvider } =
              await import("../composition/electronScenario.js");
            const result = await captureElectronScenario(
              createElectronScenarioProvider(environment),
              parsed.data,
              { signal },
            );
            return result.ok ? result.value : cliError(result.error);
          },
        ),
      ),
  });
};

const registerJavaScriptRuntimeReconciliationCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.reconcileJavaScriptRuntime, {
    description:
      "Reconcile static application and passive runtime Evidence JSON",
    args: z.object({
      inputJson: z
        .string()
        .describe(
          "Inline JSON or a JSON file path matching reconcile_javascript_runtime",
        ),
    }),
    run: ({ args }) =>
      logCliCommand(
        logger,
        CLI_COMMANDS.reconcileJavaScriptRuntime,
        async () => {
          const input = await parseCliJsonInput(
            args.inputJson,
            "reconcile_javascript_runtime",
          );
          if (!input.ok) return input.error;
          const result = reconcileJavaScriptRuntimeEvidence(input.value);
          return result.ok ? result.value : cliError(result.error);
        },
      ),
  });
};

const registerElectronObservationCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  registerElectronTargetList(cli, logger);
  registerElectronPageInspection(cli, logger);
};

const registerElectronTargetList = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.listElectronTargets, {
    description:
      "List local file pages exposed by the selected Electron CDP endpoint",
    args: z.object({
      endpoint: z.string().describe("Literal-loopback Electron CDP endpoint"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "list-electron-targets", async () => {
        const context = await electronObservationContext();
        const parsed = listElectronTargetsInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
        });
        if (!parsed.success) return inputError("list_electron_targets");
        const result = await listElectronTargets(context.provider, parsed.data);
        return result.ok ? result.value : cliError(result.error);
      }),
  });
};

const registerElectronPageInspection = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectElectronPage, {
    description: "Passively inspect one Electron file page",
    args: z.object({
      endpoint: z.string().describe("Literal-loopback Electron CDP endpoint"),
      targetId: z.string().describe("Target ID from list-electron-targets"),
    }),
    options: electronPageInspectionOptions,
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-electron-page", async () => {
        const context = await electronObservationContext();
        const parsed = inspectElectronPageInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          target_id: args.targetId,
          observation_ms: options.observationMs,
          include_script_sources: options.includeScriptSources,
        });
        if (!parsed.success) return inputError("inspect_electron_page");
        const result = await inspectElectronPage(context.provider, parsed.data);
        return result.ok ? result.value : cliError(result.error);
      }),
  });
};

const registerJavaScriptApplicationCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  resultOutput?: CliResultOutput,
): void => {
  cli.command(CLI_COMMANDS.analyzeJavaScriptApplication, {
    description:
      "Statically reconstruct a local JavaScript/Electron application",
    args: z.object({
      path: z.string().describe("ASAR or extracted application path"),
    }),
    options: javascriptApplicationOptions,
    run: ({ args, options, format }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.analyzeJavaScriptApplication, () =>
          runCliJavaScriptApplicationAnalysis(
            { input_path: args.path, format: options.artifactFormat },
            resultOutput === undefined
              ? undefined
              : {
                  output: resultOutput,
                  command: CLI_COMMANDS.analyzeJavaScriptApplication,
                  format,
                },
            signal,
          ),
        ),
      ),
  });
};

const electronObservationContext = async () => {
  const { createElectronObservationProvider } =
    await import("../composition/electronObservation.js");
  return { provider: createElectronObservationProvider() };
};

const inputError = (
  operation: string,
  issues?: Parameters<typeof projectInputIssues>[0],
  input?: unknown,
): JsonValue =>
  cliError(
    new AnalysisInputError(
      operation,
      undefined,
      issues === undefined ? [] : projectInputIssues(issues, input),
    ),
  );

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "Electron analysis failed",
  ...projectAnalysisError(error),
});
