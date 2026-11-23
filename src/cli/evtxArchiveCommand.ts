import type { Logger } from "pino";

import {
  ArtifactResourceScope,
  projectArtifactCloseFailure,
} from "../resources/index.js";
import { EVTX_ARCHIVE_TOOL_CONTRACTS } from "../contracts/evtxArchiveToolContracts.js";
import {
  EVTX_ARCHIVE_OPERATION as operation,
  EVTX_ARCHIVE_PROVIDER,
} from "../domain/evtxArchive/evtxArchive.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import {
  deliverWithService,
  type EvidenceInspectionService,
} from "./contractCommandRunners.js";
import type { CliInstance } from "./types.js";

/** One-shot publication keeps the complete inventory for later offline pages. */
export const registerEvtxArchiveCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerContractCommand(
    cli,
    logger,
    contractNamed(EVTX_ARCHIVE_TOOL_CONTRACTS, operation),
    {
      description:
        "Inspect the records of a local Windows Event Log (.evtx) file offline",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
      fields: {
        path: { description: "Local .evtx path" },
        format: {
          name: "evtxFormat",
          description: "Input archive syntax: Windows Event Log (evtx)",
        },
      },
    },
    deliverWithService(createEvtxArchiveService, EVTX_ARCHIVE_PROVIDER.id),
  );

/** One-shot log inspection that owns the file it opens. */
const createEvtxArchiveService = (): EvidenceInspectionService => {
  const resources = new ArtifactResourceScope();
  return {
    inspect: async (input, { signal }) => {
      const { inspectEvtxArchiveEvidence } =
        await import("../application/evtxArchive/EvtxArchiveService.js");
      const inspected = await inspectEvtxArchiveEvidence(input, resources, {
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
          EVTX_ARCHIVE_PROVIDER.id,
          operation,
        );
      }),
  };
};
