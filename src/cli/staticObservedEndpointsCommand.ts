import type { Logger } from "pino";
import type { Evidence } from "../domain/evidence.js";
import type { CliInstance } from "./types.js";
import { COMPARE_STATIC_AND_OBSERVED_ENDPOINTS_TOOL_CONTRACT } from "../contracts/staticObservedEndpointsToolContract.js";
import { registerContractDocumentCommand } from "./contractCommand.js";
import {
  evidenceBundleOption,
  runEvidenceInputCommand,
} from "./evidenceInputCommand.js";
import { publishCliAnalysisEvidence } from "./analysisEvidenceDelivery.js";

/** Reuse standard CLI publication so summaries keep their complete source closure on disk. */
export const registerStaticObservedEndpointsCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerContractDocumentCommand(
    cli,
    logger,
    COMPARE_STATIC_AND_OBSERVED_ENDPOINTS_TOOL_CONTRACT,
    {
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
      let sources: readonly Evidence[] = [];
      const result = await runEvidenceInputCommand(
        document,
        { operation, signal, frame, cliOptions },
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
        operation,
        signal,
        detail: delivery.detail,
        evidenceOutput: delivery.evidenceOutput,
        ...(delivery.view === undefined ? {} : { view: delivery.view }),
        sourceEvidence: sources,
      });
    },
  );
