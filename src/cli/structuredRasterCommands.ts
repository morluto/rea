import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { createStructuredRasterDiscoveryService } from "../composition/binaryDiagnostics.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../contracts/native/binaryDiagnosticsToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  registerContractCommand,
  inspectWithService,
} from "./contractCommand.js";
/** Configured family search: JSON decoding and argv admission use the contract owner. */
export function registerStructuredRasterCommands(
  cli: CliInstance,
  logger: Logger,
): void {
  registerContractCommand(
    cli,
    logger,
    contractNamed(
      BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
      "inspect_structured_raster_candidates",
    ),
    {
      description:
        "Find descriptor-table raster hypotheses under an explicit grammar and logical mapping",
      positionals: ["path"],
      callerPaths: ["path"],
      jsonText: ["segments", "grammar"],
    },
    inspectWithService(createStructuredRasterDiscoveryService, "rea-workflow"),
  );
}
