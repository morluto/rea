import { Cli, z } from "incur";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Logger } from "pino";
import { traceJavaScriptSemanticsInputSchema } from "../domain/javascript/javascriptSemanticTraceSchemas.js";
import { registerSourceToBundleCommand } from "./sourceToBundleCommand.js";
import { javaScriptAnalysisResourceControlsSchema } from "../domain/javascript/javascriptAnalysisResourceControls.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";

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
    inputSchema: z.unknown(),
    workflow: async (input) => {
      const { traceApplicationFeatureEvidence } =
        await import("../application/javascript/JavaScriptApplicationWorkflowService.js");
      const result = traceApplicationFeatureEvidence(input);
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.traceJavaScriptSemantics,
    description:
      "Trace bounded static semantic relations through authenticated application Evidence",
    inputSchema: traceJavaScriptSemanticsInputSchema,
    workflow: async (input) => {
      const { traceJavaScriptSemanticsEvidenceValidated } =
        await import("../application/javascript/JavaScriptSemanticTraceService.js");
      return traceJavaScriptSemanticsEvidenceValidated(input);
    },
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.compareApplicationVersions,
    description:
      "Compare two authenticated JavaScript Application Graph versions",
    inputSchema: z.unknown(),
    options: z.object({
      maxHeapMb: javaScriptAnalysisResourceControlsSchema.shape.max_heap_mb,
    }),
    workflow: async (input) => {
      const { compareApplicationVersionsEvidence } =
        await import("../application/javascript/JavaScriptApplicationWorkflowService.js");
      const result = compareApplicationVersionsEvidence(input);
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerSourceToBundleCommand(cli, logger);
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.compareJavaScriptExportShapes,
    description:
      "Compare exact static JavaScript export return shapes without execution",
    inputSchema: z.unknown(),
    workflow: async (input) => {
      const { compareJavaScriptExportShapesEvidence } =
        await import("../application/javascript/JavaScriptApplicationWorkflowService.js");
      const result = compareJavaScriptExportShapesEvidence(input);
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerObligationLedgerCommand(cli, logger);
  registerCoverageCommand(cli, logger);
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.projectAndroidApplicationGraph,
    description:
      "Project authenticated APK inventory Evidence into an Android application graph",
    inputSchema: z.unknown(),
    workflow: async (input) => {
      const { projectAndroidApplicationEvidence } =
        await import("../application/android/AndroidApplicationService.js");
      const result = projectAndroidApplicationEvidence(input);
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.projectAppleApplicationGraph,
    description:
      "Project authenticated IPA or macOS app inventory Evidence into an Apple application graph",
    inputSchema: z.unknown(),
    workflow: async (input) => {
      const { projectAppleApplicationEvidence } =
        await import("../application/apple/AppleApplicationService.js");
      const result = projectAppleApplicationEvidence(input);
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.projectHarmonyApplicationGraph,
    description:
      "Project authenticated HarmonyOS HAP, HSP, or App Pack inventory Evidence into an application graph",
    inputSchema: z.unknown(),
    workflow: async (input) => {
      const { projectHarmonyApplicationEvidence } =
        await import("../application/harmony/HarmonyApplicationService.js");
      const result = projectHarmonyApplicationEvidence(input);
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
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
    inputSchema: z.unknown(),
    workflow: async (input) => {
      const { buildReconstructionObligationLedgerEvidence } =
        await import("../application/ReconstructionObligationLedgerService.js");
      return buildReconstructionObligationLedgerEvidence(input);
    },
  });

const registerCoverageCommand = (cli: CliInstance, logger: Logger): void =>
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.evaluateReconstructionCoverage,
    description: "Evaluate inline fail-closed reconstruction coverage",
    inputSchema: z.unknown(),
    workflow: async (input) => {
      const { evaluateReconstructionCoverage } =
        await import("../application/ReconstructionCoverageService.js");
      return evaluateReconstructionCoverage(input);
    },
  });

interface JsonCommandOptions<
  Schema extends z.ZodType,
  Options extends z.ZodRawShape = z.ZodRawShape,
> {
  readonly cli: CliInstance;
  readonly logger: Logger;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly options?: z.ZodObject<Options>;
  readonly workflow: (
    input: z.output<Schema>,
  ) => Promise<
    | { readonly ok: true; readonly value: JsonValue }
    | { readonly ok: false; readonly error: AnalysisError }
  >;
}

const registerJsonCommand = <
  Schema extends z.ZodType,
  Options extends z.ZodRawShape = z.ZodRawShape,
>({
  cli,
  logger,
  name,
  description,
  inputSchema,
  options,
  workflow,
}: JsonCommandOptions<Schema, Options>): void => {
  cli.command(name, {
    description,
    args: z.object({
      inputJson: z.string().describe("Inline workflow JSON or JSON file path"),
    }),
    ...(options === undefined ? {} : { options }),
    run: ({ args, options: commandOptions }) =>
      logCliCommand(logger, name, async () => {
        const input = await parseCliJsonInput(args.inputJson, name);
        if (!input.ok) return input.error;
        const mergedValue =
          commandOptions !== undefined &&
          typeof input.value === "object" &&
          input.value !== null &&
          !Array.isArray(input.value)
            ? {
                ...input.value,
                ...("maxHeapMb" in commandOptions &&
                commandOptions.maxHeapMb !== undefined
                  ? { max_heap_mb: commandOptions.maxHeapMb }
                  : {}),
              }
            : input.value;
        const parsed = inputSchema.safeParse(mergedValue);
        if (!parsed.success)
          return {
            error: "Application workflow failed",
            ...projectAnalysisError(
              analysisInputErrorFromIssues(
                name,
                parsed.error.issues,
                mergedValue,
              ),
            ),
          };
        const result = await workflow(parsed.data);
        return result.ok
          ? result.value
          : {
              error: "Application workflow failed",
              ...projectAnalysisError(result.error),
            };
      }),
  });
};
