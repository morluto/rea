import { z } from "incur";

import {
  runCapabilityStatus,
  runProviderAnalysis,
  runProviderStatus,
} from "../composition/directAnalysis.js";
import { importReferenceSource } from "../application/ReferenceSourceImport.js";
import { projectReferenceSourceImportError } from "../application/ReferenceSourceImportTypes.js";
import { parseConfig } from "../config.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { safeParseJson } from "../domain/safeJson.js";
import { nativeUiScenarioInputSchema } from "../domain/native/nativeUiObservation.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { logCliCommand } from "../cliLogging.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { swiftSymbolsSchema } from "../contracts/native/nativeToolContracts.js";
import type { Logger } from "../logger.js";
import { isReferenceSourceImportCliFailure } from "./referenceSourceImportStatus.js";
import type { CliInstance } from "./types.js";
import { registerNativeCallCommands } from "./nativeCallCommands.js";

export const registerUtilityCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void => {
  registerCapabilityCommands(cli, logger);
  registerNativeCommands(cli, logger);
  registerNativeCallCommands(cli, logger);
  for (const [command, operation] of [
    [CLI_COMMANDS.observeNativeUi, "observe_native_ui"],
    [CLI_COMMANDS.captureNativeUiScenario, "capture_native_ui_scenario"],
  ] as const) {
    cli.command(command, {
      description:
        "Observe or run a scenario in one exact native application window",
      args: z.object({
        path: z.string().describe("Local native executable or app path"),
      }),
      options: z.object({
        pid: z.number().int().positive().describe("Existing application PID"),
        windowId: z
          .number()
          .int()
          .positive()
          .describe("Exact selected application window ID"),
        steps: z
          .string()
          .optional()
          .describe("JSON array of declarative AX actions or waits"),
        screenshot: z
          .boolean()
          .default(true)
          .describe("Capture only the selected window"),
        accessibility: z
          .boolean()
          .default(true)
          .describe("Read the selected window accessibility tree"),
        maxNodes: z
          .number()
          .int()
          .positive()
          .safe()
          .default(500)
          .describe("Maximum accessibility nodes per capture"),
      }),
      alias: {
        windowId: "window-id",
        maxNodes: "max-nodes",
      },
      run: ({ args, options }) =>
        logCliCommand(logger, command, async () => {
          const parameters = {
            pid: options.pid,
            window_id: options.windowId,
            screenshot: options.screenshot,
            accessibility: options.accessibility,
            max_nodes: options.maxNodes,
          };
          if (operation === "capture_native_ui_scenario") {
            const decoded =
              options.steps === undefined
                ? { ok: true as const, value: undefined }
                : safeParseJson(options.steps);
            if (!decoded.ok)
              return invalidNativeUiScenarioInput(operation, [
                { path: ["steps"], reason: "invalid_format", expected: "JSON" },
              ]);
            const parsed = nativeUiScenarioInputSchema.safeParse({
              ...parameters,
              steps: decoded.value,
            });
            if (!parsed.success)
              return invalidNativeUiScenarioInput(
                operation,
                projectInputIssues(parsed.error.issues, {
                  ...parameters,
                  ...(options.steps === undefined
                    ? {}
                    : { steps: decoded.value }),
                }),
              );
            return runProviderAnalysis(
              args.path,
              operation,
              parsed.data,
              logger,
            );
          }
          return runProviderAnalysis(args.path, operation, parameters, logger);
        }),
    });
  }
  registerReferenceSourceCommand(cli, logger, environment);
};

const invalidNativeUiScenarioInput = (
  operation: string,
  issues: ConstructorParameters<typeof AnalysisInputError>[2],
) => ({
  error: "Application workflow failed",
  ...projectAnalysisError(new AnalysisInputError(operation, undefined, issues)),
});

const registerCapabilityCommands = (cli: CliInstance, logger: Logger): void => {
  for (const command of [
    CLI_COMMANDS.capabilities,
    CLI_COMMANDS.providers,
  ] as const) {
    cli.command(command, {
      description:
        command === "capabilities"
          ? "List provider capabilities and side effects"
          : "List configured analysis providers",
      run: () =>
        logCliCommand(logger, command, () =>
          command === CLI_COMMANDS.providers
            ? runProviderStatus(logger)
            : runCapabilityStatus(logger),
        ),
    });
  }
};

const registerNativeCommands = (cli: CliInstance, logger: Logger): void => {
  for (const [command, tool] of [
    [CLI_COMMANDS.inspectMacho, "inspect_macho"],
    [CLI_COMMANDS.inspectSignature, "inspect_signature"],
    [CLI_COMMANDS.listArchitectures, "list_architectures"],
  ] as const) {
    cli.command(command, {
      description: `Run ${tool} without launching Hopper`,
      args: z.object({ path: z.string().describe("Mach-O or app path") }),
      run: ({ args }) =>
        logCliCommand(logger, command, () =>
          runProviderAnalysis(args.path, tool, {}, logger),
        ),
    });
  }
  cli.command(CLI_COMMANDS.inspectPlist, {
    description: "Parse app plist metadata without launching Hopper",
    args: z.object({ path: z.string().describe("App or Mach-O path") }),
    options: z.object({
      relativePath: z
        .string()
        .optional()
        .describe(
          "Plist path relative to the app root (default: Contents/Info.plist)",
        ),
    }),
    alias: { relativePath: "relative-path" },
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-plist", () =>
        runProviderAnalysis(
          args.path,
          "inspect_plist",
          options.relativePath === undefined
            ? {}
            : { path: options.relativePath },
          logger,
        ),
      ),
  });
  cli.command(CLI_COMMANDS.demangleSwift, {
    description: "Demangle Swift symbols without Hopper",
    args: z.object({
      path: z.string().describe("Artifact path used for evidence identity"),
      symbols: swiftSymbolsSchema.describe("Swift mangled symbols to demangle"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "demangle-swift", () =>
        runProviderAnalysis(
          args.path,
          "demangle_swift",
          { symbols: args.symbols },
          logger,
        ),
      ),
  });
};

const registerReferenceSourceCommand = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void => {
  cli.command(CLI_COMMANDS.importReferenceSource, {
    description: "Import a source tree as historical reference only",
    args: z.object({
      root: z
        .string()
        .describe("Local source directory to import as historical reference"),
    }),
    run: ({ args }) =>
      logCliCommand(
        logger,
        "import-reference-source",
        async () => {
          const config = parseConfig(environment);
          if (!config.ok)
            return {
              error: "Import failed",
              ...projectAnalysisError(config.error),
            };
          const imported = await importReferenceSource({
            root: args.root,
            caller: "rea-cli",
            policy: config.value.referenceSourcePolicy,
            importer: PRODUCT_IDENTITY.packageName,
            importerVersion: null,
          });
          return imported.ok
            ? imported.value
            : {
                error: "Import failed",
                ...projectReferenceSourceImportError(imported.error),
              };
        },
        isReferenceSourceImportCliFailure,
      ),
  });
};
