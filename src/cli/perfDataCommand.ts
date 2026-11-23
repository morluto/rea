import type { Logger } from "pino";

import {
  ArtifactResourceScope,
  projectArtifactCloseFailure,
} from "../resources/index.js";
import { PERF_DATA_TOOL_CONTRACTS } from "../contracts/perfDataToolContracts.js";
import {
  PERF_DATA_OPERATION as operation,
  PERF_DATA_PROVIDER,
} from "../domain/perfData/perfData.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import {
  inspectWithService,
  type EvidenceInspectionService,
} from "./contractCommandRunners.js";
import type { CliInstance } from "./types.js";

export const registerPerfDataCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerContractCommand(
    cli,
    logger,
    contractNamed(PERF_DATA_TOOL_CONTRACTS, operation),
    {
      description: "Inspect one local Linux perf recording (perf.data) offline",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local perf.data path" } },
    },
    inspectWithService(createPerfDataService, PERF_DATA_PROVIDER.id, "path"),
  );

/** One-shot recording inspection that owns the file it opens. */
const createPerfDataService = (): EvidenceInspectionService => {
  const resources = new ArtifactResourceScope();
  return {
    inspect: async (input, { signal }) => {
      const { inspectPerfDataEvidence } =
        await import("../application/perfData/PerfDataService.js");
      const inspected = await inspectPerfDataEvidence(input, resources, {
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
          PERF_DATA_PROVIDER.id,
          operation,
        );
      }),
  };
};
