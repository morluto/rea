import { z } from "incur";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { projectArtifactCloseFailure } from "../artifacts/StableArtifactFailure.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ok } from "../domain/result.js";
import {
  OTLP_TRACE_OPERATION as operation,
  OTLP_TRACE_PROVIDER,
} from "../domain/otlpTrace/otlpTrace.js";
import { withCommandCancellation } from "./commandCancellation.js";
import {
  analysisEvidenceDeliveryOptions,
  parseCliAnalysisEvidenceDelivery,
  deliverCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";

/** One-shot publication keeps the complete span inventory for later offline pages. */
export const registerOtlpTraceCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectOtlpTrace, {
    description:
      "Inventory spans, parent links and timing in a saved OTLP JSON trace export offline without contacting a collector",
    args: z.object({
      path: localPathStringSchema.describe("Local OTLP JSON trace export path"),
    }),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectOtlpTrace, async () => {
          const selected = parseCliAnalysisEvidenceDelivery(
            operation,
            options,
            z.object({ detail: analysisEvidenceDeliveryOptions.detail }),
          );
          if (!selected.ok) return projectAnalysisError(selected.error);
          const resources = new ArtifactResourceScope();
          const { inspectOtlpTraceEvidence } =
            await import("../application/otlpTrace/OtlpTraceService.js");
          return deliverCliAnalysisEvidence({
            callerInputPath: args.path,
            run: async () => {
              const inspected = await inspectOtlpTraceEvidence(
                { path: absoluteCallerPath(args.path) },
                resources,
                { signal },
              );
              return inspected.ok ? ok(inspected.value.evidence) : inspected;
            },
            service: {
              close: () =>
                resources.close().catch((cause: unknown) => {
                  throw projectArtifactCloseFailure(
                    cause,
                    OTLP_TRACE_PROVIDER.id,
                    operation,
                  );
                }),
            },
            providerId: OTLP_TRACE_PROVIDER.id,
            operation,
            signal,
            detail: selected.value.detail,
            evidenceOutput: selected.value.evidenceOutput,
          });
        }),
      ),
  });
};
