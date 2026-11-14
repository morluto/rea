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
  WARC_ARCHIVE_OPERATION as operation,
  WARC_ARCHIVE_PROVIDER,
} from "../domain/warcArchive/warcArchive.js";
import {
  warcArchiveDecodedBytesSchema,
  warcArchiveFileBytesSchema,
  warcArchiveRecordsSchema,
} from "../domain/warcArchive/warcArchiveQuery.js";
import { z } from "incur";
import { withCommandCancellation } from "./commandCancellation.js";
import { cliDecimalField } from "./options.js";
import {
  analysisEvidenceDeliveryOptions,
  parseCliAnalysisEvidenceDelivery,
  deliverCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";

const deliverySchema = z.object({
  detail: analysisEvidenceDeliveryOptions.detail,
});

/** One-shot publication keeps the complete inventory for later offline pages. */
export const registerWarcArchiveCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectWarcArchive, {
    description:
      "Inspect the records of a local WARC or WARC.gz archive offline",
    args: z.object({
      path: localPathStringSchema.describe("Local WARC or WARC.gz path"),
    }),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
      // Decimal tokens only: numeric coercion would read "0x10" as 16 and
      // "1e2" as 100. The shared fields keep their bounds and defaults.
      maxFileBytes: cliDecimalField(warcArchiveFileBytesSchema),
      maxDecodedBytes: cliDecimalField(warcArchiveDecodedBytesSchema),
      maxRecords: cliDecimalField(warcArchiveRecordsSchema),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectWarcArchive, async () => {
          const selected = parseCliAnalysisEvidenceDelivery(
            operation,
            options,
            deliverySchema,
          );
          if (!selected.ok) return projectAnalysisError(selected.error);
          const resources = new ArtifactResourceScope();
          const { inspectWarcArchiveEvidence } =
            await import("../application/warcArchive/WarcArchiveService.js");
          return deliverCliAnalysisEvidence({
            callerInputPath: args.path,
            run: async () => {
              const inspected = await inspectWarcArchiveEvidence(
                {
                  path: absoluteCallerPath(args.path),
                  format: "warc",
                  max_file_bytes: options.maxFileBytes,
                  max_decoded_bytes: options.maxDecodedBytes,
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
                    WARC_ARCHIVE_PROVIDER.id,
                    operation,
                  );
                }),
            },
            providerId: WARC_ARCHIVE_PROVIDER.id,
            operation,
            signal,
            detail: selected.value.detail,
            evidenceOutput: selected.value.evidenceOutput,
          });
        }),
      ),
  });
};
