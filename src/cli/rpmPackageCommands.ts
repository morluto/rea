import type { Logger } from "pino";

import { createRpmPackageService } from "../composition/rpmPackage.js";
import { RPM_PACKAGE_TOOL_CONTRACTS } from "../contracts/rpm/rpmPackageToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  deliverWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** Inspect operator-selected RPM packages through the same shared workflow as MCP. */
export const registerRpmPackageCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(RPM_PACKAGE_TOOL_CONTRACTS, "inspect_rpm_package"),
    {
      description:
        "Inspect RPM lead, signature and header metadata without installing the package or unpacking the payload",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      fields: {
        path: { description: "Local RPM package" },
        include_script_text: {
          description:
            "Include scriptlet source text, bounded by --max-script-bytes; never executed",
        },
      },
    },
    deliverWithService(createRpmPackageService, "rea-rpm-package"),
  );
};
