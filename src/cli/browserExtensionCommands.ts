import type { Logger } from "pino";

import { createBrowserExtensionService } from "../composition/browserExtension.js";
import { BROWSER_EXTENSION_TOOL_CONTRACTS } from "../contracts/browserExtension/browserExtensionToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { deliverWithService } from "./contractCommandRunners.js";
import type { CliInstance } from "./types.js";

/** Inspect one operator-selected extension package through the shared workflow. */
export const registerBrowserExtensionCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(BROWSER_EXTENSION_TOOL_CONTRACTS, "inspect_browser_extension"),
    {
      description:
        "Inspect a CRX, XPI, ZIP, or unpacked manifest.json without loading the extension",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      fields: { path: { description: "Local CRX, XPI, ZIP, or manifest.json" } },
    },
    deliverWithService(createBrowserExtensionService, "rea-browser-extension"),
  );
};
