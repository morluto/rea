import type { Logger } from "pino";

import {
  ArtifactResourceScope,
  projectArtifactCloseFailure,
} from "../resources/index.js";
import { OTLP_TRACE_TOOL_CONTRACTS } from "../contracts/otlpTraceToolContracts.js";
import {
  OTLP_TRACE_OPERATION as operation,
  OTLP_TRACE_PROVIDER,
} from "../domain/otlpTrace/otlpTrace.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  inspectWithService,
  registerContractCommand,
  type EvidenceInspectionService,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

export const registerOtlpTraceCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerContractCommand(
    cli,
    logger,
    contractNamed(OTLP_TRACE_TOOL_CONTRACTS, operation),
    {
      description:
        "Inventory spans, parent links and timing in a saved OTLP JSON trace export offline without contacting a collector",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local OTLP JSON trace export path" } },
    },
    inspectWithService(createOtlpTraceService, OTLP_TRACE_PROVIDER.id, "path"),
  );

/** One-shot trace inspection that owns the file it opens. */
const createOtlpTraceService = (): EvidenceInspectionService => {
  const resources = new ArtifactResourceScope();
  return {
    inspect: async (input, { signal }) => {
      const { inspectOtlpTraceEvidence } =
        await import("../application/otlpTrace/OtlpTraceService.js");
      const inspected = await inspectOtlpTraceEvidence(input, resources, {
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
          OTLP_TRACE_PROVIDER.id,
          operation,
        );
      }),
  };
};
