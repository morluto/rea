import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { createGoBinaryService } from "../composition/go.js";
import { GO_TOOL_CONTRACTS } from "../contracts/go/goToolContracts.js";
import {
  deliverWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** Resolve caller paths and inspect static build metadata through the shared workflow. */
export const registerGoCommands = (cli: CliInstance, logger: Logger): void => {
  const [contract] = GO_TOOL_CONTRACTS;
  registerContractCommand(
    cli,
    logger,
    contract,
    {
      command: CLI_COMMANDS.inspectGoBinary,
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
            "Slice to read from a universal Mach-O, by CPU family; when several slices share a family, arm64 (arm64 or arm64v8), arm64e (arm64e or arm64e.x1) or x86_64 names the subtype, and a value matching several slices is refused; required for universal files",
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
