import type { Logger } from "pino";

import {
  ArtifactResourceScope,
  projectArtifactCloseFailure,
} from "../resources/index.js";
import { WARC_ARCHIVE_TOOL_CONTRACTS } from "../contracts/warcArchiveToolContracts.js";
import {
  WARC_ARCHIVE_OPERATION as operation,
  WARC_ARCHIVE_PROVIDER,
} from "../domain/warcArchive/warcArchive.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import {
  deliverWithService,
  type EvidenceInspectionService,
} from "./contractCommandRunners.js";
import type { CliInstance } from "./types.js";

/** One-shot publication keeps the complete inventory for later offline pages. */
export const registerWarcArchiveCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerContractCommand(
    cli,
    logger,
    contractNamed(WARC_ARCHIVE_TOOL_CONTRACTS, operation),
    {
      description:
        "Inspect the records of a local WARC or WARC.gz archive offline",
      positionals: ["path"],
      callerPaths: ["path"],
      // The contract fixes the archive `format` to a literal, and argv has no
      // projection for one, so the command leaves it to the contract's value.
      omit: {
        format:
          "The contract fixes the archive format; the file extension selects it",
      },
      fields: { path: { description: "Local WARC or WARC.gz path" } },
      // The command publishes the complete record inventory or a summary.
      evidenceDelivery: true,
    },
    deliverWithService(createWarcArchiveService, WARC_ARCHIVE_PROVIDER.id),
  );

/** One-shot archive inspection that owns the file it opens. */
const createWarcArchiveService = (): EvidenceInspectionService => {
  const resources = new ArtifactResourceScope();
  return {
    inspect: async (input, { signal }) => {
      const { inspectWarcArchiveEvidence } =
        await import("../application/warcArchive/WarcArchiveService.js");
      const inspected = await inspectWarcArchiveEvidence(input, resources, {
        signal,
      });
      return inspected.ok
        ? { ok: true, value: inspected.value.evidence }
        : inspected;
    },
    close: () =>
      resources.close().catch((cause: unknown) => {
        throw projectArtifactCloseFailure(
          cause,
          WARC_ARCHIVE_PROVIDER.id,
          operation,
        );
      }),
  };
};
