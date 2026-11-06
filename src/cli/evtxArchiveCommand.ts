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
  EVTX_ARCHIVE_OPERATION as operation,
  EVTX_ARCHIVE_PROVIDER,
} from "../domain/evtxArchive/evtxArchive.js";
import {
  evtxArchiveFileBytesSchema,
  evtxArchiveRecordsSchema,
} from "../domain/evtxArchive/evtxArchiveQuery.js";
import { z } from "incur";
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
export const registerEvtxArchiveCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectEvtxArchive, {
    description:
      "Inspect the records of a local Windows Event Log (.evtx) file offline",
    args: z.object({
      path: localPathStringSchema.describe("Local .evtx path"),
    }),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
      maxFileBytes: evtxArchiveFileBytesSchema,
      maxRecords: evtxArchiveRecordsSchema,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectEvtxArchive, async () => {
          const selected = parseCliAnalysisEvidenceDelivery(
            operation,
            options,
            deliverySchema,
          );
          if (!selected.ok) return projectAnalysisError(selected.error);
          const resources = new ArtifactResourceScope();
          const { inspectEvtxArchiveEvidence } =
            await import("../application/evtxArchive/EvtxArchiveService.js");
          return deliverCliAnalysisEvidence({
            callerInputPath: args.path,
            run: async () => {
              const inspected = await inspectEvtxArchiveEvidence(
                {
                  path: absoluteCallerPath(args.path),
                  format: "evtx",
                  max_file_bytes: options.maxFileBytes,
                  max_records: options.maxRecords,
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
                    EVTX_ARCHIVE_PROVIDER.id,
                    operation,
                  );
                }),
            },
            providerId: EVTX_ARCHIVE_PROVIDER.id,
            operation,
            signal,
            detail: selected.value.detail,
            evidenceOutput: selected.value.evidenceOutput,
          });
        }),
      ),
  });
};
