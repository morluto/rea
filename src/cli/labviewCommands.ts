import type { Logger } from "pino";

import { createLabviewArtifactService } from "../composition/labview.js";
import { LABVIEW_TOOL_CONTRACTS } from "../contracts/labview/labviewToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { deliverWithService } from "./contractCommandRunners.js";
import type { CliInstance } from "./types.js";

/** CLI and MCP share inspection; the reader never starts a process. */
export const registerLabviewCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(LABVIEW_TOOL_CONTRACTS, "inspect_labview_artifact"),
    {
      description:
        "Inspect a LabVIEW RSRC container (VI/CTL/LLB or LabVIEW-built PE) without executing it",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      fields: {
        path: {
          description: "Local LabVIEW .vi/.ctl/.llb file or LabVIEW-built PE",
        },
      },
    },
    deliverWithService(createLabviewArtifactService, "rea-labview-rsrc"),
  );
};
