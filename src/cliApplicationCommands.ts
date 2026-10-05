import { Cli, z } from "incur";

import {
  compareApplicationVersionsEvidenceValidated,
  compareJavaScriptExportShapesEvidenceValidated,
  compareSourceToBundleEvidenceValidated,
  traceApplicationFeatureEvidenceValidated,
} from "./application/JavaScriptApplicationWorkflowService.js";
import { traceJavaScriptSemanticsEvidenceValidated } from "./application/JavaScriptSemanticTraceService.js";
import { runControlledReplay } from "./application/JavaScriptReplayService.js";
import {
  executeNodeCharacterization,
  prepareNodeCharacterization,
} from "./application/NodeRuntimeCharacterizationService.js";
import {
  evaluateReconstructionCoverage,
  reconstructionCoverageEvaluationInputSchema,
} from "./application/ReconstructionCoverageService.js";
import { buildReconstructionObligationLedgerEvidenceValidated } from "./application/ReconstructionObligationLedgerService.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { parseCliJsonInput } from "./cliJsonInput.js";
import { logCliCommand } from "./cliLogging.js";
import {
  AnalysisInputError,
  projectAnalysisError,
  type AnalysisError,
} from "./domain/errors.js";
import { jsonValueSchema, type JsonValue } from "./domain/jsonValue.js";
import type { Logger } from "./logger.js";
import { parseConfig } from "./config.js";
import { LinuxJavaScriptReplayRunner } from "./replay/LinuxJavaScriptReplayRunner.js";
import { SystemJavaScriptReplayHost } from "./replay/SystemJavaScriptReplayHost.js";
import type { AppConfig } from "./config.js";
import { traceApplicationFeatureInputSchema } from "./domain/javascriptFeatureTraceSchemas.js";
import { traceJavaScriptSemanticsInputSchema } from "./domain/javascriptSemanticTraceSchemas.js";
import { compareApplicationVersionsInputSchema } from "./domain/javascriptApplicationVersionComparisonSchemas.js";
import { compareSourceToBundleInputSchema } from "./domain/sourceToBundleComparisonSchemas.js";
import { compareJavaScriptExportShapesInputSchema } from "./domain/javascriptExportShapeComparisonSchemas.js";
import { projectInputIssues } from "./domain/inputIssueProjection.js";
import { reconstructionObligationLedgerInputSchema } from "./domain/reconstructionObligationLedgerSchemas.js";

type CliInstance = ReturnType<typeof Cli.create>;

/** Register CLI equivalents of provider-neutral application graph workflows. */
export const registerApplicationCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void => {
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.traceApplicationFeature,
    description:
      "Trace a typed seed through authenticated application Evidence JSON",
    inputSchema: traceApplicationFeatureInputSchema,
    workflow: traceApplicationFeatureEvidenceValidated,
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.traceJavaScriptSemantics,
    description:
      "Trace bounded static semantic relations through authenticated application Evidence",
    inputSchema: traceJavaScriptSemanticsInputSchema,
    workflow: traceJavaScriptSemanticsEvidenceValidated,
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.compareApplicationVersions,
    description:
      "Compare two authenticated JavaScript Application Graph versions",
    inputSchema: compareApplicationVersionsInputSchema,
    workflow: compareApplicationVersionsEvidenceValidated,
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.compareSourceToBundle,
    description:
      "Compare committed historical source with authenticated application Evidence",
    inputSchema: compareSourceToBundleInputSchema,
    workflow: compareSourceToBundleEvidenceValidated,
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.compareJavaScriptExportShapes,
    description:
      "Compare exact static JavaScript export return shapes without execution",
    inputSchema: compareJavaScriptExportShapesInputSchema,
    workflow: compareJavaScriptExportShapesEvidenceValidated,
  });
  cli.command(CLI_COMMANDS.runControlledReplay, {
    description:
      "Plan or execute an extracted-module replay in the isolated Linux sandbox",
    args: z.object({
      inputJson: z.string().describe("Inline replay JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, CLI_COMMANDS.runControlledReplay, async () => {
        const input = await parseCliJsonInput(
          args.inputJson,
          CLI_COMMANDS.runControlledReplay,
        );
        if (!input.ok) return input.error;
        const config = parseConfig(environment);
        if (!config.ok) return projectAnalysisError(config.error);
        const result = await runControlledReplay(
          {
            configuration: () => config.value.javascriptReplayConfiguration,
            host: new SystemJavaScriptReplayHost(),
            runner: new LinuxJavaScriptReplayRunner(),
          },
          input.value,
        );
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
  });
  registerConfiguredJsonCommand({
    cli,
    logger,
    environment,
    name: CLI_COMMANDS.prepareNodeCharacterization,
    description:
      "Prepare one exact Node/JavaScript characterization without execution",
    workflow: (config, input) =>
      prepareNodeCharacterization(replayDependencies(config), input),
  });
  registerConfiguredJsonCommand({
    cli,
    logger,
    environment,
    name: CLI_COMMANDS.executeNodeCharacterization,
    description:
      "Execute one exact Node/JavaScript characterization from its content-bound plan",
    workflow: (config, input) =>
      executeNodeCharacterization(replayDependencies(config), input),
  });
  registerObligationLedgerCommand(cli, logger);
  registerCoverageCommand(cli, logger);
};

const registerObligationLedgerCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.buildReconstructionObligationLedger,
    description:
      "Generate a deterministic Evidence-backed reconstruction obligation ledger page",
    inputSchema: reconstructionObligationLedgerInputSchema,
    workflow: (input) => {
      const result =
        buildReconstructionObligationLedgerEvidenceValidated(input);
      return result.ok
        ? { ok: true, value: jsonValueSchema.parse(result.value) }
        : result;
    },
  });

interface ConfiguredJsonCommandOptions {
  readonly cli: CliInstance;
  readonly logger: Logger;
  /** Environment the configuration is read from; defaults to the process environment. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly name: string;
  readonly description: string;
  readonly workflow: (
    config: AppConfig,
    input: unknown,
  ) => Promise<
    | { readonly ok: true; readonly value: JsonValue }
    | { readonly ok: false; readonly error: AnalysisError }
  >;
}

const registerConfiguredJsonCommand = ({
  cli,
  logger,
  environment = process.env,
  name,
  description,
  workflow,
}: ConfiguredJsonCommandOptions): void => {
  cli.command(name, {
    description,
    args: z.object({
      inputJson: z.string().describe("Inline workflow JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, name, async () => {
        const input = await parseCliJsonInput(args.inputJson, name);
        if (!input.ok) return input.error;
        const configured = configuredConfig(environment);
        if (!configured.ok) return configured.error;
        const result = await workflow(configured.config, input.value);
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
  });
};

const registerCoverageCommand = (cli: CliInstance, logger: Logger): void =>
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.evaluateReconstructionCoverage,
    description: "Evaluate inline fail-closed reconstruction coverage",
    inputSchema: reconstructionCoverageEvaluationInputSchema,
    workflow: (input) => {
      const result = evaluateReconstructionCoverage(input);
      return result.ok
        ? { ok: true, value: jsonValueSchema.parse(result.value) }
        : result;
    },
  });

const configuredConfig = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
):
  | {
      readonly ok: true;
      readonly config: AppConfig;
    }
  | {
      readonly ok: false;
      readonly error: ReturnType<typeof projectAnalysisError>;
    } => {
  const configured = parseConfig(environment);
  return configured.ok
    ? { ok: true, config: configured.value }
    : { ok: false, error: projectAnalysisError(configured.error) };
};

const replayDependencies = (config: AppConfig) => ({
  configuration: () => config.javascriptReplayConfiguration,
  host: new SystemJavaScriptReplayHost(),
  runner: new LinuxJavaScriptReplayRunner(),
});

interface JsonCommandOptions<Schema extends z.ZodType> {
  readonly cli: CliInstance;
  readonly logger: Logger;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly workflow: (
    input: z.output<Schema>,
  ) =>
    | { readonly ok: true; readonly value: JsonValue }
    | { readonly ok: false; readonly error: AnalysisError };
}

const registerJsonCommand = <Schema extends z.ZodType>({
  cli,
  logger,
  name,
  description,
  inputSchema,
  workflow,
}: JsonCommandOptions<Schema>): void => {
  cli.command(name, {
    description,
    args: z.object({
      inputJson: z.string().describe("Inline workflow JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, name, async () => {
        const input = await parseCliJsonInput(args.inputJson, name);
        if (!input.ok) return input.error;
        const parsed = inputSchema.safeParse(input.value);
        if (!parsed.success)
          return {
            error: "Application workflow failed",
            ...projectAnalysisError(
              new AnalysisInputError(
                name,
                undefined,
                projectInputIssues(parsed.error.issues, input.value),
              ),
            ),
          };
        const result = workflow(parsed.data);
        return result.ok
          ? result.value
          : {
              error: "Application workflow failed",
              ...projectAnalysisError(result.error),
            };
      }),
  });
};
