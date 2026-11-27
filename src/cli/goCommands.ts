import type { Logger } from "pino";

import { createGoBinaryService } from "../composition/go.js";
import { GO_TOOL_CONTRACTS } from "../contracts/go/goToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { deliverWithService } from "./contractCommandRunners.js";
import type { CliInstance } from "./types.js";

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
          description:
            "Slice to read from a universal Mach-O, by CPU family; arm64e and arm64e.x1 read only a slice of that subtype, as lipo -thin does; when several slices share a family, arm64 (arm64 or arm64v8) or x86_64 names the subtype, and a value matching several slices is refused; required for universal files",
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
