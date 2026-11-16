import type { Logger } from "pino";

import {
  ArtifactResourceScope,
  projectArtifactCloseFailure,
} from "../resources/index.js";
import { NTFS_JOURNAL_TOOL_CONTRACTS } from "../contracts/ntfsJournalToolContracts.js";
import {
  NTFS_JOURNAL_OPERATION as operation,
  NTFS_JOURNAL_PROVIDER,
} from "../domain/windows/ntfsJournalQuery.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  inspectWithService,
  registerContractCommand,
  type EvidenceInspectionService,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

export const registerNtfsJournalCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerContractCommand(
    cli,
    logger,
    contractNamed(NTFS_JOURNAL_TOOL_CONTRACTS, operation),
    {
      description:
        "Inspect paired offline NTFS MFT and USN journal acquisitions",
      positionals: ["mft_path", "journal_path"],
      callerPaths: ["mft_path", "journal_path"],
      fields: {
        mft_path: { description: "Acquired NTFS Master File Table stream" },
        journal_path: {
          description: "Acquired NTFS change journal data stream",
        },
      },
    },
    // The journal is the inspected input; the MFT is its caller-paired companion.
    inspectWithService(
      createNtfsJournalService,
      NTFS_JOURNAL_PROVIDER.id,
      "journal_path",
    ),
  );

/** One-shot journal inspection that owns the acquisition files it opens. */
const createNtfsJournalService = (): EvidenceInspectionService => {
  const resources = new ArtifactResourceScope();
  return {
    inspect: async (input, { signal }) => {
      const { inspectNtfsJournalEvidence } =
        await import("../application/ntfs/NtfsJournalService.js");
      return inspectNtfsJournalEvidence(input, resources, signal);
    },
    close: () =>
      resources.close().catch((cause: unknown) => {
        throw projectArtifactCloseFailure(
          cause,
          NTFS_JOURNAL_PROVIDER.id,
          operation,
        );
      }),
  };
};
