import { z } from "incur";

import type { DirectAnalysis } from "../composition/directAnalysis.js";
import type { ReferenceSourcePolicy } from "../domain/referenceSourcePolicy.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { importReferenceSource } from "../application/ReferenceSourceImport.js";
import { projectReferenceSourceImportError } from "../application/ReferenceSourceImportTypes.js";
import type { AnalysisCleanupObservation } from "../domain/analysisErrorBase.js";
import { parseConfig } from "../config/parseConfig.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { safeParseJson } from "../domain/safeJson.js";
import { nativeUiScenarioInputSchema } from "../domain/native/nativeUiObservation.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { logCliCommand } from "../cliLogging.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { swiftSymbolsSchema } from "../contracts/native/nativeToolContracts.js";
import type { Logger } from "pino";
import { isReferenceSourceImportCliFailure } from "./referenceSourceImportStatus.js";
import type { CliInstance } from "./types.js";
import { registerNativeCallCommands } from "./nativeCallCommands.js";

export const registerUtilityCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  analysis: Pick<DirectAnalysis, "runProviderAnalysis" | "runSessionStatus">,
): void => {
  const { runProviderAnalysis } = analysis;
  registerCapabilityCommands(cli, logger, analysis);
  registerNativeCommands(cli, logger, runProviderAnalysis);
  registerNativeCallCommands(cli, logger, runProviderAnalysis);
  registerNativeUiCommands(cli, logger, runProviderAnalysis);
  registerReferenceSourceCommand(cli, logger, environment);
};

const nativeUiScopeOptions = {
  pid: z.number().int().positive().describe("Existing application PID"),
  windowId: z
    .number()
    .int()
    .positive()
    .describe("Exact selected application window ID"),
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
};

const nativeUiScope = (options: {
  readonly pid: number;
  readonly windowId: number;
  readonly screenshot: boolean;
  readonly accessibility: boolean;
  readonly maxNodes: number;
}) => ({
  pid: options.pid,
  window_id: options.windowId,
  screenshot: options.screenshot,
  accessibility: options.accessibility,
  max_nodes: options.maxNodes,
});

/**
 * Passive observation and active scenarios have different input contracts.
 * Only the scenario command accepts steps, so passive observation rejects
 * them as an unknown flag instead of silently dropping them.
 */
const registerNativeUiCommands = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  const pathArgument = z.object({
    path: z.string().describe("Local native executable or app path"),
  });
  cli.command(CLI_COMMANDS.observeNativeUi, {
    description:
      "Observe one already-running native application window by PID and window ID",
    args: pathArgument,
    options: z.object(nativeUiScopeOptions),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.observeNativeUi, () =>
        runProviderAnalysis(
          args.path,
          "observe_native_ui",
          nativeUiScope(options),
          logger,
        ),
      ),
  });
  const operation = "capture_native_ui_scenario";
  cli.command(CLI_COMMANDS.captureNativeUiScenario, {
    description:
      "Run declarative AX actions or waits in one exact native application window",
    args: pathArgument,
    options: z.object({
      ...nativeUiScopeOptions,
      steps: z
        .string()
        .optional()
        .describe("JSON array of declarative AX actions or waits"),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.captureNativeUiScenario, async () => {
        const parameters = nativeUiScope(options);
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
              ...(options.steps === undefined ? {} : { steps: decoded.value }),
            }),
          );
        return runProviderAnalysis(args.path, operation, parsed.data, logger);
      }),
  });
};

const invalidNativeUiScenarioInput = (
  operation: string,
  issues: ConstructorParameters<typeof AnalysisInputError>[2],
) => ({
  error: "Application workflow failed",
  ...projectAnalysisError(new AnalysisInputError(operation, undefined, issues)),
});

const registerCapabilityCommands = (
  cli: CliInstance,
  logger: Logger,
  { runSessionStatus }: Pick<DirectAnalysis, "runSessionStatus">,
): void => {
  for (const command of [
    CLI_COMMANDS.capabilities,
    CLI_COMMANDS.providers,
  ] as const) {
    cli.command(command, {
      description:
        command === "capabilities"
          ? "List provider capabilities and side effects"
          : "List configured analysis providers",
      run: () => logCliCommand(logger, command, () => runSessionStatus(logger)),
    });
  }
};

const registerNativeCommands = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
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
          "Plist path relative to the app root, or an absolute path (default: the bundle's Info.plist)",
        ),
    }),
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
  environment: Readonly<Record<string, string | undefined>>,
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
          return runReferenceSourceImport(
            args.root,
            config.value.referenceSourcePolicy,
          );
        },
        isReferenceSourceImportCliFailure,
      ),
  });
};

const runReferenceSourceImport = async (
  root: string,
  policy: ReferenceSourcePolicy,
): Promise<unknown> => {
  const resources = new ArtifactResourceScope();
  let outcome:
    | {
        readonly kind: "result";
        readonly imported: Awaited<ReturnType<typeof importReferenceSource>>;
      }
    | { readonly kind: "thrown"; readonly cause: unknown };
  try {
    outcome = {
      kind: "result",
      imported: await importReferenceSource(
        {
          root,
          caller: "rea-cli",
          policy,
          importer: PRODUCT_IDENTITY.packageName,
          importerVersion: PRODUCT_IDENTITY.packageVersion,
        },
        resources,
      ),
    };
  } catch (cause: unknown) {
    outcome = { kind: "thrown", cause };
  }

  let closeOutcome:
    | { readonly kind: "closed" }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    await resources.close();
    closeOutcome = { kind: "closed" };
  } catch (cause: unknown) {
    closeOutcome = { kind: "failed", cause };
  }

  if (outcome.kind === "thrown") {
    if (closeOutcome.kind === "failed")
      throw new AggregateError(
        [outcome.cause, closeOutcome.cause],
        "Reference source import and cleanup both failed",
        { cause: outcome.cause },
      );
    throw outcome.cause;
  }

  const imported = outcome.imported;
  if (!imported.ok) {
    const cleanup =
      closeOutcome.kind === "closed"
        ? imported.error.cleanup
        : mergeReferenceSourceCleanup(
            imported.error.cleanup,
            ArtifactReaderFailure.cleanupObservation(
              closeOutcome.cause,
              "reference source",
            ),
          );
    return {
      error: "Import failed",
      ...projectReferenceSourceImportError({
        ...imported.error,
        ...(cleanup === undefined ? {} : { cleanup }),
      }),
    };
  }

  if (closeOutcome.kind === "failed")
    return {
      error: "Import failed",
      ...projectReferenceSourceImportError({
        tag: "reference-source-import",
        code: "io",
        message: "Reference source cleanup failed after import",
        cleanup: ArtifactReaderFailure.cleanupObservation(
          closeOutcome.cause,
          "reference source",
        ),
        cause: closeOutcome.cause,
      }),
    };
  return imported.value;
};

const mergeReferenceSourceCleanup = (
  first: AnalysisCleanupObservation | undefined,
  second: AnalysisCleanupObservation,
): AnalysisCleanupObservation =>
  first === undefined
    ? second
    : {
        reason: `${first.reason}; ${second.reason}`,
        resources: [...new Set([...first.resources, ...second.resources])],
      };
