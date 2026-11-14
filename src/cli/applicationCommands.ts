import { registerPlaywrightTraceCommand } from "./playwrightTraceCommand.js";
import { registerApiContractCommand } from "./apiContractCommand.js";
import { registerNtfsJournalCommand } from "./ntfsJournalCommand.js";
import { Cli, z } from "incur";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { logCliCommand } from "../cliLogging.js";
import {
  compareApplicationVersionsRequestSchema,
  compareJavaScriptExportShapesRequestSchema,
  traceApplicationFeatureRequestSchema,
  traceJavaScriptSemanticsRequestSchema,
} from "../contracts/javascript/applicationWorkflowInputContracts.js";
import { applicationInventoryProjectionInputSchema } from "../domain/mobileApplicationGraphProjection.js";
import { reconstructionCoverageEvaluationInputSchema } from "../domain/reconstructionCoverageInput.js";
import { reconstructionObligationLedgerInputSchema } from "../domain/reconstructionObligationLedgerSchemas.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Logger } from "pino";
import { registerSourceToBundleCommand } from "./sourceToBundleCommand.js";
import { registerStaticObservedEndpointsCommand } from "./staticObservedEndpointsCommand.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import type { Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import {
  evidenceBundleOption,
  runEvidenceInputCommand,
} from "./evidenceInputCommand.js";
import { withCommandCancellation } from "./commandCancellation.js";

type CliInstance = ReturnType<typeof Cli.create>;

/** Register CLI equivalents of provider-neutral application graph workflows. */
export const registerApplicationCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  registerEvidenceJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.traceApplicationFeature,
    operation: "trace_application_feature",
    description:
      "Trace a typed seed through authenticated application Evidence JSON",
    inputSchema: traceApplicationFeatureRequestSchema,
    workflow: async (input, lookup, signal) => {
      const { traceApplicationFeatureEvidence } =
        await import("../application/javascript/JavaScriptApplicationWorkflowService.js");
      const result = traceApplicationFeatureEvidence(input, lookup, { signal });
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerEvidenceJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.traceJavaScriptSemantics,
    operation: "trace_javascript_semantics",
    description:
      "Trace bounded static semantic relations through authenticated application Evidence",
    inputSchema: traceJavaScriptSemanticsRequestSchema,
    workflow: async (input, lookup, signal) => {
      const { traceJavaScriptSemanticsEvidence } =
        await import("../application/javascript/JavaScriptSemanticTraceService.js");
      const result = traceJavaScriptSemanticsEvidence(input, lookup, {
        signal,
      });
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerEvidenceJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.compareApplicationVersions,
    operation: "compare_application_versions",
    description:
      "Compare two authenticated JavaScript Application Graph versions",
    inputSchema: compareApplicationVersionsRequestSchema,
    workflow: async (input, lookup, signal) => {
      const { compareApplicationVersionsEvidence } =
        await import("../application/javascript/JavaScriptApplicationWorkflowService.js");
      const result = compareApplicationVersionsEvidence(input, lookup, {
        signal,
      });
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerSourceToBundleCommand(cli, logger);
  registerStaticObservedEndpointsCommand(cli, logger);
  registerApiContractCommand(cli, logger);
  registerNtfsJournalCommand(cli, logger);
  registerPlaywrightTraceCommand(cli, logger);
  registerEvidenceJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.compareJavaScriptExportShapes,
    operation: "compare_javascript_export_shapes",
    description:
      "Compare exact static JavaScript export return shapes without execution",
    inputSchema: compareJavaScriptExportShapesRequestSchema,
    workflow: async (input, lookup, signal) => {
      const { compareJavaScriptExportShapesEvidence } =
        await import("../application/javascript/JavaScriptApplicationWorkflowService.js");
      const result = compareJavaScriptExportShapesEvidence(input, lookup, {
        signal,
      });
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerObligationLedgerCommand(cli, logger);
  registerCoverageCommand(cli, logger);
  registerEvidenceJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.projectAndroidApplicationGraph,
    operation: "project_android_application_graph",
    description:
      "Project authenticated APK inventory Evidence into an Android application graph",
    inputSchema: applicationInventoryProjectionInputSchema,
    workflow: async (input, lookup, signal) => {
      const { projectAndroidApplicationEvidence } =
        await import("../application/android/AndroidApplicationService.js");
      const result = projectAndroidApplicationEvidence(input, lookup, {
        signal,
      });
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerEvidenceJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.projectAppleApplicationGraph,
    operation: "project_apple_application_graph",
    description:
      "Project authenticated IPA or macOS app inventory Evidence into an Apple application graph",
    inputSchema: applicationInventoryProjectionInputSchema,
    workflow: async (input, lookup, signal) => {
      const { projectAppleApplicationEvidence } =
        await import("../application/apple/AppleApplicationService.js");
      const result = projectAppleApplicationEvidence(input, lookup, { signal });
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerEvidenceJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.projectHarmonyApplicationGraph,
    operation: "project_harmony_application_graph",
    description:
      "Project authenticated HarmonyOS HAP, HSP, or App Pack inventory Evidence into an application graph",
    inputSchema: applicationInventoryProjectionInputSchema,
    workflow: async (input, lookup, signal) => {
      const { projectHarmonyApplicationEvidence } =
        await import("../application/harmony/HarmonyApplicationService.js");
      const result = projectHarmonyApplicationEvidence(input, lookup, {
        signal,
      });
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
    inputSchema: reconstructionObligationLedgerInputSchema,
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
    inputSchema: reconstructionCoverageEvaluationInputSchema,
    workflow: async (input) => {
      const { evaluateReconstructionCoverage } =
        await import("../application/ReconstructionCoverageService.js");
      return evaluateReconstructionCoverage(input);
    },
  });

interface JsonCommandOptions<Schema extends z.ZodType> {
  readonly cli: CliInstance;
  readonly logger: Logger;
  readonly name: string;
  readonly description: string;
  /**
   * Schema of the JSON document the caller supplies through `inputJson`,
   * for `--schema` display only. The workflow service still owns runtime
   * validation, so its error identity and diagnostics are unchanged.
   */
  readonly inputSchema: Schema;
  readonly workflow: (
    input: unknown,
  ) => Promise<
    | { readonly ok: true; readonly value: JsonValue }
    | { readonly ok: false; readonly error: AnalysisError }
  >;
}

/**
 * Input document schemas for JSON-input commands, for `--schema` display.
 * Incur derives `--schema` from a command's positional `args`, which for
 * these commands is only the `inputJson: string` wrapper, so the CLI
 * dispatcher answers `--schema` for them from this registry instead.
 * Populated when the commands register; the owning service still validates
 * the document at runtime.
 */
export interface JsonCommandSchema {
  readonly inputSchema: z.ZodType;
  readonly optionsSchema?: z.ZodType | undefined;
}

export const jsonCommandSchemas = new Map<string, JsonCommandSchema>();

const evidenceJsonCommandOptions = z.object({
  evidenceBundle: evidenceBundleOption,
});

const registerJsonCommand = <Schema extends z.ZodType>({
  cli,
  logger,
  name,
  description,
  inputSchema,
  workflow,
}: JsonCommandOptions<Schema>): void => {
  jsonCommandSchemas.set(name, { inputSchema });
  cli.command(name, {
    description,
    args: z.object({
      inputJson: z.string().describe("Inline workflow JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, name, async () => {
        const input = await parseCliJsonInput(args.inputJson, name);
        if (!input.ok) return input.error;
        const result = await workflow(input.value);
        return result.ok
          ? result.value
          : {
              error: "Application workflow failed",
              ...projectAnalysisError(result.error, "invocation"),
            };
      }),
  });
};

/** Evidence consumers share one explicit portable source and cancellation lifetime. */
const registerEvidenceJsonCommand = ({
  cli,
  logger,
  name,
  operation,
  description,
  inputSchema,
  workflow,
}: {
  readonly cli: CliInstance;
  readonly logger: Logger;
  readonly name: string;
  readonly operation: string;
  readonly description: string;
  /**
   * Schema of the JSON document the caller supplies through `inputJson`,
   * for `--schema` display only. The workflow service still owns runtime
   * validation, so its error identity and diagnostics are unchanged.
   */
  readonly inputSchema: z.ZodType;
  readonly workflow: (
    input: unknown,
    lookup: EvidenceLookup | undefined,
    signal: AbortSignal,
  ) => Promise<Result<Evidence, AnalysisError>>;
}): void => {
  jsonCommandSchemas.set(name, {
    inputSchema,
    optionsSchema: evidenceJsonCommandOptions,
  });
  cli.command(name, {
    description,
    args: z.object({
      inputJson: z.string().describe("Inline workflow JSON or JSON file path"),
    }),
    options: evidenceJsonCommandOptions,
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, name, async () => {
          const input = await parseCliJsonInput(args.inputJson, name, signal);
          if (!input.ok) return input.error;
          const result = await runEvidenceInputCommand(
            operation,
            options.evidenceBundle,
            signal,
            (lookup) => workflow(input.value, lookup, signal),
          );
          return result.ok
            ? result.value
            : {
                error: "Application workflow failed",
                ...result.error,
              };
        }),
      ),
  });
};
