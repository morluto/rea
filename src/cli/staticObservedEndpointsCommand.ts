import type { Logger } from "pino";
import type { Evidence } from "../domain/evidence.js";
import type { CliInstance } from "./types.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { APPLICATION_TOOL_CONTRACTS } from "../contracts/applicationToolContracts.js";
import { JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER } from "../domain/investigationProviders.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractDocumentCommand } from "./contractCommand.js";
import {
  evidenceBundleOption,
  runEvidenceInputCommand,
} from "./evidenceInputCommand.js";
import { publishCliAnalysisEvidence } from "./analysisEvidenceDelivery.js";
import { parseAnalysisInput } from "../application/AnalysisInput.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

/** Reuse standard CLI publication so summaries keep their complete source closure on disk. */
export const registerStaticObservedEndpointsCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerContractDocumentCommand(
    cli,
    logger,
    contractNamed(
      APPLICATION_TOOL_CONTRACTS,
      "compare_static_and_observed_endpoints",
    ),
    {
      command: CLI_COMMANDS.compareStaticAndObservedEndpoints,
      description:
        "Compare static JavaScript endpoints and HAR Evidence JSON offline; --detail summary with --evidence_output saves full facts for selected inspect-analysis-view pages",
      document:
        "Inline JSON or file containing application, capture and optional origin",
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
      cliOptions: { evidenceBundle: evidenceBundleOption },
    },
    async (document, { signal, operation, delivery, cliOptions, frame }) => {
      if (delivery === undefined)
        throw new Error(`${operation} declares evidenceDelivery`);
      // Refuse a malformed document before reading the Evidence bundle.
      const framed = parseAnalysisInput(operation, document, frame, signal);
      if (!framed.ok) return projectAnalysisError(framed.error);
      let sources: readonly Evidence[] = [];
      const result = await runEvidenceInputCommand(
        operation,
        cliOptions.evidenceBundle,
        signal,
        async (lookup) => {
          const { compareStaticAndObservedEndpointsEvidence } =
            await import("../application/javascript/StaticObservedEndpointComparisonService.js");
          const compared = await compareStaticAndObservedEndpointsEvidence(
            document,
            lookup,
            { signal },
          );
          if (!compared.ok) return compared;
          sources = compared.value.sources;
          return { ok: true, value: compared.value.evidence };
        },
      );
      return publishCliAnalysisEvidence(result, {
        providerId: JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER.id,
        operation,
        signal,
        detail: delivery.detail,
        evidenceOutput: delivery.evidenceOutput,
        ...(delivery.view === undefined ? {} : { view: delivery.view }),
        sourceEvidence: sources,
      });
    },
  );
