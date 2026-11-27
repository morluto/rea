import type { Logger } from "pino";

import { createGoBinaryService } from "../composition/go.js";
import { GO_TOOL_CONTRACTS } from "../contracts/go/goToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { deliverWithService } from "./contractCommandRunners.js";
import type { CliInstance } from "./types.js";
import { UNIVERSAL_SLICE_ARCHITECTURE_HELP } from "./universalSliceOption.js";

/** Resolve caller paths and inspect static build metadata through the shared workflow. */
export const registerGoCommands = (cli: CliInstance, logger: Logger): void => {
  const contract = contractNamed(GO_TOOL_CONTRACTS, "inspect_go_binary");
  registerContractCommand(
    cli,
    logger,
    contract,
    {
      description:
        "Inspect embedded Go compiler, modules, build settings and optional static (ptr, len) string literals without target execution",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      fields: {
        path: {
          description: "Local ELF, PE, thin Mach-O or universal Mach-O image",
        },
        architecture: {
          description: UNIVERSAL_SLICE_ARCHITECTURE_HELP,
        },
        include_string_literals: {
          description:
            "Also recover bounded inferred Go UTF-8 string literals from static (ptr, len) headers",
        },
      },
    },
    deliverWithService(createGoBinaryService, "go-build-info"),
  );
};
