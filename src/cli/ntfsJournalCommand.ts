import { z } from "incur";
import type { Logger } from "pino";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { projectArtifactCloseFailure } from "../artifacts/StableArtifactFailure.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { localPathStringSchema } from "../domain/localPath.js";
import {
  NTFS_JOURNAL_OPERATION as operation,
  NTFS_JOURNAL_PROVIDER,
  ntfsJournalInputSchema,
} from "../domain/windows/ntfsJournalQuery.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { deliverCliAnalysisEvidence } from "./analysisEvidenceDelivery.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { cliDecimalField } from "./options.js";
import type { CliInstance } from "./types.js";

export const registerNtfsJournalCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectNtfsJournal, {
    description: "Inspect paired offline NTFS MFT and USN journal acquisitions",
    args: z.object({
      mftPath: localPathStringSchema.describe(
        "Acquired NTFS Master File Table stream",
      ),
      journalPath: localPathStringSchema.describe(
        "Acquired NTFS change journal data stream",
      ),
    }),
    options: z.object({
      startFileOffset: cliDecimalField(
        ntfsJournalInputSchema.shape.start_file_offset,
      ),
      maxRows: cliDecimalField(ntfsJournalInputSchema.shape.max_rows),
      mftRecordLimit: cliDecimalField(
        ntfsJournalInputSchema.shape.mft_record_limit,
      ),
      mftRecordStart: cliDecimalField(
        ntfsJournalInputSchema.shape.mft_record_start,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectNtfsJournal, async () => {
          const resources = new ArtifactResourceScope();
          const { inspectNtfsJournalEvidence } =
            await import("../application/ntfs/NtfsJournalService.js");
          return deliverCliAnalysisEvidence({
            callerInputPath: args.journalPath,
            callerInputPaths: { mft_path: args.mftPath },
            run: () =>
              inspectNtfsJournalEvidence(
                {
                  mft_path: absoluteCallerPath(args.mftPath),
                  journal_path: absoluteCallerPath(args.journalPath),
                  start_file_offset: options.startFileOffset,
                  max_rows: options.maxRows,
                  mft_record_start: options.mftRecordStart,
                  mft_record_limit: options.mftRecordLimit,
                },
                resources,
                signal,
              ),
            service: {
              close: () =>
                resources.close().catch((cause: unknown) => {
                  throw projectArtifactCloseFailure(
                    cause,
                    NTFS_JOURNAL_PROVIDER.id,
                    operation,
                  );
                }),
            },
            providerId: NTFS_JOURNAL_PROVIDER.id,
            operation,
            signal,
            detail: "complete",
            evidenceOutput: undefined,
          });
        }),
      ),
  });
};
