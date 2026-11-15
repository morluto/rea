import type { Logger } from "pino";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { projectArtifactCloseFailure } from "../artifacts/StableArtifactFailure.js";
import { PLAYWRIGHT_TRACE_TOOL_CONTRACTS } from "../contracts/playwrightTraceToolContracts.js";
import {
  PLAYWRIGHT_TRACE_OPERATION as operation,
  PLAYWRIGHT_TRACE_PROVIDER,
} from "../domain/playwrightTrace/playwrightTrace.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  deliverWithService,
  registerContractCommand,
  type EvidenceInspectionService,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** Standard one-shot publication keeps complete inventory Evidence for later offline pages. */
export const registerPlaywrightTraceCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerContractCommand(
    cli,
    logger,
    contractNamed(PLAYWRIGHT_TRACE_TOOL_CONTRACTS, operation),
    {
      description:
        "Inventory local saved Playwright v10 trace ZIP events offline without launching a browser",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
      fields: {
        path: { description: "Local Playwright trace ZIP path" },
        view: {
          description:
            "JSON playwright-trace page; requires --detail summary and --evidence_output",
        },
      },
    },
    deliverWithService(
      createPlaywrightTraceService,
      PLAYWRIGHT_TRACE_PROVIDER.id,
    ),
  );

/** One-shot trace inventory that owns the archive it opens. */
const createPlaywrightTraceService = (): EvidenceInspectionService => {
  const resources = new ArtifactResourceScope();
  return {
    inspect: async (input, { signal }) => {
      const { PlaywrightTraceService } =
        await import("../application/playwrightTrace/PlaywrightTraceService.js");
      const { PlaywrightTraceDecoder } =
        await import("../browser/history/playwrightTrace/PlaywrightTraceDecoder.js");
      return new PlaywrightTraceService(
        new PlaywrightTraceDecoder(resources),
      ).inspect(input, signal);
    },
    close: () =>
      resources.close().catch((cause: unknown) => {
        throw projectArtifactCloseFailure(
          cause,
          PLAYWRIGHT_TRACE_PROVIDER.id,
          operation,
        );
      }),
  };
};
