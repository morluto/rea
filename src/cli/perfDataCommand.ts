import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { projectArtifactCloseFailure } from "../artifacts/StableArtifactFailure.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  PERF_DATA_OPERATION as operation,
  PERF_DATA_PROVIDER,
} from "../domain/perfData/perfData.js";
import {
  perfDataEventsSchema,
  perfDataFileBytesSchema,
} from "../domain/perfData/perfDataQuery.js";
import { z } from "incur";
import { cliDecimalField } from "./options.js";
import { withCommandCancellation } from "./commandCancellation.js";
import {
  analysisEvidenceDeliveryOptions,
  parseCliAnalysisEvidenceDelivery,
  deliverCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";

const deliverySchema = z.object({
  detail: analysisEvidenceDeliveryOptions.detail,
});

/** One-shot publication keeps the complete inventory for later offline pages. */
export const registerPerfDataCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectPerfData, {
    description: "Inspect one local Linux perf recording (perf.data) offline",
    args: z.object({
      path: localPathStringSchema.describe("Local perf.data path"),
    }),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
      // Decimal tokens only: numeric coercion would read "0x10" as 16 and
      // "1e3" as 1000. The shared fields keep their bounds and defaults.
      maxFileBytes: cliDecimalField(perfDataFileBytesSchema),
      maxEvents: cliDecimalField(perfDataEventsSchema),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectPerfData, async () => {
          const selected = parseCliAnalysisEvidenceDelivery(
            operation,
            options,
            deliverySchema,
          );
          if (!selected.ok) return projectAnalysisError(selected.error);
          const resources = new ArtifactResourceScope();
          const { inspectPerfDataEvidence } =
            await import("../application/perfData/PerfDataService.js");
          return deliverCliAnalysisEvidence({
            callerInputPath: args.path,
            run: async () => {
              const inspected = await inspectPerfDataEvidence(
                {
                  path: absoluteCallerPath(args.path),
                  max_file_bytes: options.maxFileBytes,
                  max_events: options.maxEvents,
                },
                resources,
                { signal },
              );
              return inspected.ok
                ? { ok: true, value: inspected.value.evidence }
                : inspected;
            },
            service: {
              close: () =>
                resources.close().catch((cause: unknown) => {
                  throw projectArtifactCloseFailure(
                    cause,
                    PERF_DATA_PROVIDER.id,
                    operation,
                  );
                }),
            },
            providerId: PERF_DATA_PROVIDER.id,
            operation,
            signal,
            detail: selected.value.detail,
            evidenceOutput: selected.value.evidenceOutput,
          });
        }),
      ),
  });
};
