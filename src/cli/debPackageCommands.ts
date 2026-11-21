import type { Logger } from "pino";

import { createDebPackageService } from "../composition/debPackage.js";
import { DEB_PACKAGE_TOOL_CONTRACTS } from "../contracts/deb/debPackageToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  inspectWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** Resolve an operator-selected Debian package through the shared inspection workflow. */
export const registerDebPackageCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createDebPackageService();
  const contract = contractNamed(
    DEB_PACKAGE_TOOL_CONTRACTS,
    "inspect_deb_package",
  );
  registerContractCommand(
    cli,
    logger,
    contract,
    {
      description:
        "Inspect a local Debian .deb without installing it or running maintainer scripts",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: { description: "Local Debian .deb package" },
      },
    },
    inspectWithService(() => service, "rea-deb-package"),
  );
};
