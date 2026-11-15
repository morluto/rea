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
import { PRODUCT_IDENTITY } from "../identity.js";
import { isCliOperationFailure, logCliCommand } from "../cliLogging.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { nativeCommandTimeoutField } from "../domain/native/nativeDeadlines.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { registerNativeCallCommands } from "./nativeCallCommands.js";
import { toolContract } from "../contracts/toolContracts.js";
import {
  registerContractCommand,
  runOnSessionTarget,
} from "./contractCommand.js";

export const registerUtilityCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  analysis: Pick<DirectAnalysis, "runProviderAnalysis" | "runSessionStatus">,
): void => {
  const { runProviderAnalysis } = analysis;
  const run = runOnSessionTarget(runProviderAnalysis, logger);
  registerCapabilityCommands(cli, logger, analysis);
  registerNativeCommands(cli, logger, runProviderAnalysis);
  registerNativeCallCommands(cli, logger, runProviderAnalysis);
  registerNativeUiCommands(cli, logger, run);
  registerReferenceSourceCommand(cli, logger, environment);
};

/**
 * Passive observation and active scenarios have different input contracts.
 * Only the scenario command accepts steps, so passive observation rejects
 * them as an unknown flag instead of silently dropping them.
 */
const registerNativeUiCommands = (
  cli: CliInstance,
  logger: Logger,
  run: ReturnType<typeof runOnSessionTarget>,
): void => {
  const sessionTarget = { description: "Local native executable or app path" };
  const fields = {
    pid: { description: "Existing application PID" },
    window_id: { description: "Exact selected application window ID" },
    max_nodes: { description: "Maximum accessibility nodes per capture" },
  } as const;
  registerContractCommand(
    cli,
    logger,
    toolContract("observe_native_ui"),
    {
      command: CLI_COMMANDS.observeNativeUi,
      description:
        "Observe one already-running native application window by PID and window ID",
      sessionTarget,
      fields,
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    toolContract("capture_native_ui_scenario"),
    {
      command: CLI_COMMANDS.captureNativeUiScenario,
      description:
        "Run declarative AX actions or waits in one exact native application window",
      sessionTarget,
      runtimeJson: { steps: "steps must be valid JSON" },
      fields: {
        ...fields,
        steps: {
          description:
            "Required JSON array of one or more declarative AX actions or waits",
        },
      },
    },
    run,
  );
};

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
  const run = runOnSessionTarget(runProviderAnalysis, logger);
  const machoTarget = { description: "Mach-O or app path" };
  registerContractCommand(
    cli,
    logger,
    toolContract("inspect_macho"),
    {
      command: CLI_COMMANDS.inspectMacho,
      description: "Run inspect_macho without launching Hopper",
      sessionTarget: machoTarget,
      omit: { detail: "The CLI returns the complete inspection Evidence" },
    },
    run,
  );
  for (const [command, tool] of [
    [CLI_COMMANDS.inspectSignature, "inspect_signature"],
    [CLI_COMMANDS.listArchitectures, "list_architectures"],
  ] as const)
    registerContractCommand(
      cli,
      logger,
      toolContract(tool),
      {
        command,
        description: `Run ${tool} without launching Hopper`,
        sessionTarget: machoTarget,
      },
      run,
    );
  // inspect_plist reports a plist the target itself selects under the
  // contract's `path` field, which this command spells --relative-path, so
  // it keeps its own option until that producer names the target apart.
  cli.command(CLI_COMMANDS.inspectPlist, {
    description: "Parse app plist metadata without launching Hopper",
    args: z.object({
      path: localPathStringSchema.describe("App or Mach-O path"),
    }),
    options: z.object({
      relativePath: localPathStringSchema
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
  registerContractCommand(
    cli,
    logger,
    toolContract("demangle_swift"),
    {
      command: CLI_COMMANDS.demangleSwift,
      description: "Demangle Swift symbols without Hopper",
      sessionTarget: {
        description: "Artifact path used for evidence identity",
      },
      positionals: ["symbols"],
      fields: {
        symbols: { description: "Swift mangled symbols to demangle" },
      },
    },
    run,
  );
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
