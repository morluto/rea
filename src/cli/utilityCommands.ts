import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { z } from "incur";
import { cliDecimalField } from "./options.js";

import type { DirectAnalysis } from "../composition/directAnalysis.js";
import { createHistoricalSourceSummary } from "../domain/referenceSourceSummary.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { importReferenceSource } from "../application/ReferenceSourceImport.js";
import {
  referenceSourceImportAnalysisError,
  type ReferenceSourceImportOptions,
} from "../application/ReferenceSourceImportTypes.js";
import { err } from "../domain/result.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { parseConfig } from "../config/parseConfig.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  AnalysisInputError,
  type AnalysisInputIssue,
} from "../domain/analysisErrorCore.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { safeParseJson } from "../domain/safeJson.js";
import {
  nativeUiObservationInputSchema,
  nativeUiScenarioInputSchema,
} from "../domain/native/nativeUiObservation.js";
import {
  nativeCommandTimeoutField,
  nativeUiDeadlineField,
} from "../domain/native/nativeDeadlines.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { isCliOperationFailure, logCliCommand } from "../cliLogging.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { swiftSymbolsSchema } from "../contracts/native/nativeToolContracts.js";
import { localPathStringSchema } from "../domain/localPath.js";
import type { Logger } from "pino";
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

// Decimal tokens only; shared fields own their bounds and defaults.
const nativeUiScopeFields = nativeUiObservationInputSchema.shape;
const nativeUiScopeOptions = {
  pid: cliDecimalField(
    nativeUiScopeFields.pid.describe("Existing application PID"),
  ),
  windowId: cliDecimalField(
    nativeUiScopeFields.window_id.describe(
      "Exact selected application window ID",
    ),
  ),
  screenshot: nativeUiScopeFields.screenshot,
  accessibility: nativeUiScopeFields.accessibility,
  maxNodes: cliDecimalField(
    nativeUiScopeFields.max_nodes.describe(
      "Maximum accessibility nodes per capture",
    ),
  ),
  nativeUiDeadlineMs: cliDecimalField(nativeUiDeadlineField),
};

const nativeUiScope = (options: {
  readonly pid: number;
  readonly windowId: number;
  readonly screenshot: boolean;
  readonly accessibility: boolean;
  readonly maxNodes: number;
  readonly nativeUiDeadlineMs?: number | undefined;
}) => ({
  pid: options.pid,
  window_id: options.windowId,
  screenshot: options.screenshot,
  accessibility: options.accessibility,
  max_nodes: options.maxNodes,
  ...(options.nativeUiDeadlineMs === undefined
    ? {}
    : { native_ui_deadline_ms: options.nativeUiDeadlineMs }),
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
    path: localPathStringSchema.describe("Local native executable or app path"),
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
        ).then(projectCliAnalysisResult),
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
        .describe(
          "Required JSON array of one or more declarative AX actions or waits",
        ),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.captureNativeUiScenario, async () => {
        const parameters = nativeUiScope(options);
        const decoded = safeParseJson(options.steps);
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
              steps: decoded.value,
            }),
          );
        const { native_ui_deadline_ms: deadline, ...scenario } = parsed.data;
        return runProviderAnalysis(
          args.path,
          operation,
          deadline === undefined
            ? scenario
            : { ...scenario, native_ui_deadline_ms: deadline },
          logger,
        ).then(projectCliAnalysisResult);
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
      args: z.object({
        path: localPathStringSchema.describe("Mach-O or app path"),
      }),
      options: z.object({
        nativeCommandTimeoutMs: cliDecimalField(nativeCommandTimeoutField),
      }),
      run: ({ args, options }) =>
        logCliCommand(logger, command, () =>
          runProviderAnalysis(
            args.path,
            tool,
            options.nativeCommandTimeoutMs === undefined
              ? {}
              : { native_command_timeout_ms: options.nativeCommandTimeoutMs },
            logger,
          ).then(projectCliAnalysisResult),
        ),
    });
  }
  cli.command(CLI_COMMANDS.inspectPlist, {
    description: "Parse app plist metadata without launching Hopper",
    args: z.object({
      path: localPathStringSchema.describe("App or Mach-O path"),
    }),
    options: z.object({
      relativePath: z
        .string()
        .optional()
        .describe(
          "Plist path relative to the app root, or an absolute path (default: the bundle's Info.plist)",
        ),
      nativeCommandTimeoutMs: cliDecimalField(nativeCommandTimeoutField),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-plist", () =>
        runProviderAnalysis(
          args.path,
          "inspect_plist",
          {
            ...(options.relativePath === undefined
              ? {}
              : { path: options.relativePath }),
            ...(options.nativeCommandTimeoutMs === undefined
              ? {}
              : { native_command_timeout_ms: options.nativeCommandTimeoutMs }),
          },
          logger,
        ).then(projectCliAnalysisResult),
      ),
  });
  cli.command(CLI_COMMANDS.demangleSwift, {
    description: "Demangle Swift symbols without Hopper",
    args: z.object({
      path: localPathStringSchema.describe(
        "Artifact path used for evidence identity",
      ),
      symbols: swiftSymbolsSchema.describe("Swift mangled symbols to demangle"),
    }),
    options: z.object({
      nativeCommandTimeoutMs: cliDecimalField(nativeCommandTimeoutField),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "demangle-swift", () =>
        runProviderAnalysis(
          args.path,
          "demangle_swift",
          {
            symbols: args.symbols,
            ...(options.nativeCommandTimeoutMs === undefined
              ? {}
              : { native_command_timeout_ms: options.nativeCommandTimeoutMs }),
          },
          logger,
        ).then(projectCliAnalysisResult),
      ),
  });
};

const referenceSourceExcludePathsSchema = z.object({
  excludePaths: z.array(z.string().min(1)),
});

const EXCLUDE_PATHS_INPUT_MESSAGE =
  "--exclude-paths must be a JSON array of nonempty Git-ignore rules. Each rule uses Git-ignore syntax, including wildcards, directory suffixes, and negations, rather than a literal path match.";

const invalidReferenceSourceExcludePaths = (
  issues: readonly AnalysisInputIssue[],
) => ({
  error: "Import failed" as const,
  ...projectAnalysisError(
    new AnalysisInputError(
      CLI_COMMANDS.importReferenceSource,
      { userMessage: EXCLUDE_PATHS_INPUT_MESSAGE },
      issues,
    ),
  ),
});

/** Parse caller exclusions before the import opens the selected tree. */
const parseReferenceSourceExcludePaths = (
  encoded: string | undefined,
):
  | {
      readonly ok: true;
      readonly rules: readonly string[] | undefined;
    }
  | {
      readonly ok: false;
      readonly failure: ReturnType<typeof invalidReferenceSourceExcludePaths>;
    } => {
  if (encoded === undefined) return { ok: true, rules: undefined };
  const decoded = safeParseJson(encoded);
  if (!decoded.ok)
    return {
      ok: false,
      failure: invalidReferenceSourceExcludePaths([
        {
          path: ["excludePaths"],
          reason: "invalid_format",
          expected: "JSON",
        },
      ]),
    };
  const parsed = referenceSourceExcludePathsSchema.safeParse({
    excludePaths: decoded.value,
  });
  if (!parsed.success)
    return {
      ok: false,
      failure: invalidReferenceSourceExcludePaths(
        projectInputIssues(parsed.error.issues, {
          excludePaths: decoded.value,
        }),
      ),
    };
  return { ok: true, rules: parsed.data.excludePaths };
};

const registerReferenceSourceCommand = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  cli.command(CLI_COMMANDS.importReferenceSource, {
    description: "Import a source tree as historical reference only",
    args: z.object({
      root: localPathStringSchema.describe(
        "Local source directory to import as historical reference",
      ),
    }),
    options: z
      .object({
        excludePaths: z
          .string()
          .optional()
          .describe(
            "JSON array of Git-ignore rules to exclude. Rules use Git-ignore syntax, including wildcards, directory suffixes, and negations; they are not literal path matches. An empty array adds no caller exclusions.",
          ),
        detail: z
          .enum(["full", "summary"])
          .default("full")
          .describe(
            "Complete committed graph or compact historical-source summary",
          ),
        outlineDepth: cliDecimalField(
          z
            .int()
            .min(0)
            .optional()
            .describe(
              "Summary outline path depth (default: 2; 0 omits entries); requires --detail summary",
            ),
        ),
      })
      .superRefine((options, context) => {
        if (options.outlineDepth !== undefined && options.detail !== "summary")
          context.addIssue({
            code: "custom",
            path: ["outlineDepth"],
            message: "--outline-depth requires --detail summary",
          });
      })
      .meta({
        if: { required: ["outlineDepth"] },
        then: {
          required: ["detail"],
          properties: { detail: { const: "summary" } },
        },
      }),
    run: ({ args, options }) =>
      logCliCommand(
        logger,
        "import-reference-source",
        async () => {
          const excludePaths = parseReferenceSourceExcludePaths(
            options.excludePaths,
          );
          if (!excludePaths.ok) return excludePaths.failure;
          const config = parseConfig(environment);
          if (!config.ok)
            return {
              error: "Import failed",
              ...projectAnalysisError(config.error),
            };
          return withCommandCancellation((signal) =>
            runReferenceSourceImport(
              {
                root: args.root,
                caller: "rea-cli",
                policy: config.value.referenceSourcePolicy,
                importer: PRODUCT_IDENTITY.packageName,
                importerVersion: PRODUCT_IDENTITY.packageVersion,
                signal,
                ...(excludePaths.rules === undefined
                  ? {}
                  : { excludePaths: excludePaths.rules }),
              },
              options.detail === "summary"
                ? (options.outlineDepth ?? 2)
                : undefined,
            ),
          );
        },
        isCliOperationFailure,
      ),
  });
};

const runReferenceSourceImport = async (
  options: ReferenceSourceImportOptions & { readonly signal: AbortSignal },
  outlineDepth: number | undefined,
): Promise<unknown> => {
  const resources = new ArtifactResourceScope();
  const result = await finishAnalysisCommand(
    async () => {
      const imported = await importReferenceSource(options, resources);
      return imported.ok
        ? imported
        : err(referenceSourceImportAnalysisError(imported.error));
    },
    resources,
    "filesystem",
    "import_reference_source",
    options.signal,
    "reference source",
  );
  if (!result.ok) return { error: "Import failed", ...result.error };
  return outlineDepth === undefined
    ? result.value
    : createHistoricalSourceSummary(result.value, outlineDepth);
};
