import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { createRawRasterDiscoveryService } from "../composition/binaryDiagnostics.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../contracts/native/binaryDiagnosticsToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  registerContractCommand,
  inspectWithService,
} from "./contractCommand.js";
/** The canonical contract owns bounds, defaults and repeated numeric options. */
export function registerRawRasterCommands(
  cli: CliInstance,
  logger: Logger,
): void {
  registerContractCommand(
    cli,
    logger,
    contractNamed(
      BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
      "inspect_raw_raster_candidates",
    ),
    {
      description:
        "Rank raw raster hypotheses, not verified images, in a bounded file range",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: { description: "Local file" },
        min_score: {
          description:
            "Minimum heuristic score from 0 to 1, e.g. 0.5; not a probability",
        },
      },
    },
    inspectWithService(createRawRasterDiscoveryService, "rea-workflow"),
  );
}
