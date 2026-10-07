import { reconstructionCoverageEvaluationInputSchema } from "../domain/reconstructionCoverageInput.js";
import { Cli, z } from "incur";

import {
  compareApplicationVersionsEvidenceValidated,
  compareJavaScriptExportShapesEvidenceValidated,
  compareSourceToBundleEvidenceValidated,
  traceApplicationFeatureEvidenceValidated,
} from "../application/JavaScriptApplicationWorkflowService.js";
import { traceJavaScriptSemanticsEvidenceValidated } from "../application/JavaScriptSemanticTraceService.js";
import { evaluateReconstructionCoverage } from "../application/ReconstructionCoverageService.js";
import { buildReconstructionObligationLedgerEvidenceValidated } from "../application/ReconstructionObligationLedgerService.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { logCliCommand } from "../cliLogging.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import type { Logger } from "../logger.js";
import { traceApplicationFeatureInputSchema } from "../domain/javascriptFeatureTraceSchemas.js";
import { traceJavaScriptSemanticsInputSchema } from "../domain/javascriptSemanticTraceSchemas.js";
import { compareApplicationVersionsInputSchema } from "../domain/javascriptApplicationVersionComparisonSchemas.js";
import { compareSourceToBundleInputSchema } from "../domain/sourceToBundleComparisonSchemas.js";
import { compareJavaScriptExportShapesInputSchema } from "../domain/javascriptExportShapeComparisonSchemas.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { reconstructionObligationLedgerInputSchema } from "../domain/reconstructionObligationLedgerSchemas.js";

type CliInstance = ReturnType<typeof Cli.create>;

/** Register CLI equivalents of provider-neutral application graph workflows. */
export const registerApplicationCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
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
