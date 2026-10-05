import { Cli, z } from "incur";

import {
  inspectElectronPage,
  listElectronTargets,
} from "./application/ElectronObservationService.js";
import { captureElectronScenario } from "./application/ElectronActiveObservationService.js";
import { reconcileJavaScriptRuntimeEvidence } from "./application/JavaScriptRuntimeReconciliationService.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import { CdpElectronProvider } from "./browser/CdpElectronProvider.js";
import { PlaywrightElectronActiveProvider } from "./browser/PlaywrightElectronActiveProvider.js";
import { logCliCommand } from "./cliLogging.js";
import { parseConfig } from "./config.js";
import {
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
} from "./domain/electronObservation.js";
import { electronActiveObservationInputSchema } from "./domain/electronActiveObservation.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  projectAnalysisError,
} from "./domain/errors.js";
import type { JsonValue } from "./domain/jsonValue.js";
import type { Logger } from "./logger.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { parseCliJsonInput } from "./cliJsonInput.js";
import {
  electronPageInspectionOptions,
  javascriptApplicationOptions,
} from "./cliObservationOptions.js";
import { runCliJavaScriptApplicationAnalysis } from "./cli/javascriptApplicationAnalysis.js";

/** Register CLI equivalents of the Electron MCP tools. */
export const registerElectronCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void => {
  registerElectronObservationCommands(cli, logger);
  registerElectronActiveCommand(cli, logger, environment);
  registerJavaScriptApplicationCommand(cli, logger);
  registerJavaScriptRuntimeReconciliationCommand(cli, logger);
};

const registerElectronActiveCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void => {
  cli.command(CLI_COMMANDS.captureElectronScenario, {
    description: "Run one approved, bounded owned Electron scenario",
    args: z.object({
      inputJson: z
        .string()
        .describe(
          "Inline JSON or a JSON file matching capture_electron_scenario",
        ),
    }),
    run: ({ args }) =>
      logCliCommand(logger, CLI_COMMANDS.captureElectronScenario, async () => {
        const input = await parseCliJsonInput(
          args.inputJson,
          "capture_electron_scenario",
        );
        if (!input.ok) return input.error;
        const parsed = electronActiveObservationInputSchema.safeParse(
          input.value,
        );
        if (!parsed.success) return inputError("capture_electron_scenario");
        const context = await electronContext(environment);
        if (!context.ok) return context.error;
        const result = await captureElectronScenario(
          context.activeProvider,
          context.authority,
          parsed.data,
        );
        return result.ok ? result.value : cliError(result.error);
      }),
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
    description: "List local file pages exposed by Electron CDP",
    args: z.object({
      endpoint: z.string().describe("Literal-loopback Electron CDP endpoint"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "list-electron-targets", async () => {
        const context = await electronObservationContext(
          "list_electron_targets",
        );
        if (!context.ok) return context.error;
        const parsed = listElectronTargetsInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
        });
        if (!parsed.success) return inputError("list_electron_targets");
        const result = await listElectronTargets(
          context.provider,
          context.authority,
          parsed.data,
        );
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
        const context = await electronObservationContext(
          "inspect_electron_page",
        );
        if (!context.ok) return context.error;
        const parsed = inspectElectronPageInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          target_id: args.targetId,
          observation_ms: options.observationMs,
          include_script_sources: options.includeScriptSources,
        });
        if (!parsed.success) return inputError("inspect_electron_page");
        const result = await inspectElectronPage(
          context.provider,
          context.authority,
          parsed.data,
        );
        return result.ok ? result.value : cliError(result.error);
      }),
  });
};

const registerJavaScriptApplicationCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.analyzeJavaScriptApplication, {
    description:
      "Statically reconstruct a local JavaScript/Electron application",
    args: z.object({
      path: z.string().describe("Absolute ASAR or extracted application path"),
    }),
    options: javascriptApplicationOptions,
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.analyzeJavaScriptApplication, () =>
        runCliJavaScriptApplicationAnalysis({
          input_path: args.path,
          format: options.artifactFormat,
        }),
      ),
  });
};

const electronContext = async (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const config = parseConfig(environment);
  if (!config.ok) return { ok: false as const, error: cliError(config.error) };
  const authority = await loadConfiguredPermissionAuthority(config.value);
  if (!authority.ok)
    return { ok: false as const, error: cliError(authority.error) };
  return {
    ok: true as const,
    authority: authority.value,
    provider: new CdpElectronProvider(),
    activeProvider: new PlaywrightElectronActiveProvider(),
    observationPolicy: config.value.electronObservationPolicy,
  };
};

const electronObservationContext = async (
  operation: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const context = await electronContext(environment);
  if (!context.ok) return context;
  if (context.observationPolicy.status === "disabled")
    return {
      ok: false as const,
      error: cliError(
        new AnalysisCapabilityUnavailableError(
          "rea-cdp-electron",
          operation,
          "Electron observation is disabled; enable REA_ELECTRON_OBSERVE_ENABLED to authorize loopback endpoints",
        ),
      ),
    };
  return context;
};

const inputError = (operation: string): JsonValue =>
  cliError(new AnalysisInputError(operation));

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "Electron analysis failed",
  ...projectAnalysisError(error),
});
