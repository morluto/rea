import { z } from "incur";
import type { Logger } from "pino";
import type { Evidence } from "../domain/evidence.js";
import type { CliInstance } from "./types.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { logCliCommand } from "../cliLogging.js";
import { compareStaticObservedEndpointsFactsSchema } from "../contracts/javascript/applicationWorkflowInputContracts.js";
import { jsonInputArgument } from "./jsonInputArgument.js";
import { getEvidenceInputContract } from "../domain/evidenceInputContract.js";
import { endpointComparisonViewRequestSchema } from "../domain/analysisView/endpointComparisonView.js";
import { parseAnalysisInput } from "../application/AnalysisInput.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER } from "../domain/investigationProviders.js";
import { withCommandCancellation } from "./commandCancellation.js";
import {
  evidenceBundleOption,
  runEvidenceInputCommand,
} from "./evidenceInputCommand.js";
import {
  analysisEvidenceDeliveryOptions,
  parseCliAnalysisEvidenceDelivery,
  publishCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";

const operation = "compare_static_and_observed_endpoints";
const comparisonDocumentSchema = getEvidenceInputContract(
  compareStaticObservedEndpointsFactsSchema,
).frameSchema;
const deliverySchema = z
  .object({
    detail: analysisEvidenceDeliveryOptions.detail,
    view: endpointComparisonViewRequestSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.view !== undefined && value.detail !== "summary")
      context.addIssue({
        code: "custom",
        path: ["view"],
        message:
          "A selected page requires --detail summary and --evidence_output.",
      });
  });
const commandOptions = z.object({
  evidenceBundle: evidenceBundleOption,
  ...analysisEvidenceDeliveryOptions,
  view: z
    .string()
    .optional()
    .describe(
      "JSON endpoint-comparison page; requires --detail summary and --evidence_output",
    ),
});

const runComparison = async (
  inputJson: string,
  options: z.output<typeof commandOptions>,
  signal: AbortSignal,
) => {
  const selected = parseCliAnalysisEvidenceDelivery(
    operation,
    options,
    deliverySchema,
  );
  if (!selected.ok) return projectAnalysisError(selected.error);
  const delivery = {
    providerId: JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER.id,
    operation,
    signal,
    detail: selected.value.detail,
    evidenceOutput: selected.value.evidenceOutput,
    ...(selected.value.view === undefined ? {} : { view: selected.value.view }),
  };
  const raw = await parseCliJsonInput(inputJson, operation, signal);
  if (!raw.ok) return raw.error;
  // The frame validates transport fields without cloning either Evidence before budget admission.
  const input = parseAnalysisInput(
    operation,
    raw.value,
    comparisonDocumentSchema,
    signal,
  );
  if (!input.ok) return projectAnalysisError(input.error);
  let sources: readonly Evidence[] = [];
  const result = await runEvidenceInputCommand(
    operation,
    options.evidenceBundle,
    signal,
    async (lookup) => {
      const { compareStaticAndObservedEndpointsEvidence } =
        await import("../application/javascript/StaticObservedEndpointComparisonService.js");
      const compared = await compareStaticAndObservedEndpointsEvidence(
        { ...input.value, detail: options.detail },
        lookup,
        { signal },
      );
      if (!compared.ok) return compared;
      sources = compared.value.sources;
      return { ok: true, value: compared.value.evidence };
    },
  );
  return publishCliAnalysisEvidence(result, {
    ...delivery,
    sourceEvidence: sources,
  });
};

/** Reuse standard CLI publication so summaries keep their complete source closure on disk. */
export const registerStaticObservedEndpointsCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const name = CLI_COMMANDS.compareStaticAndObservedEndpoints;
  cli.command(name, {
    description:
      "Compare static JavaScript endpoints and HAR Evidence JSON offline; --detail summary with --evidence_output saves full facts for selected inspect-analysis-view pages",
    args: z.object({
      inputJson: jsonInputArgument(
        "Inline JSON or file containing application, capture and optional origin",
        comparisonDocumentSchema,
      ),
    }),
    options: commandOptions,
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, name, () =>
          runComparison(args.inputJson, options, signal),
        ),
      ),
  });
};
