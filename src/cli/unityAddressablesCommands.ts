import type { Logger } from "pino";

import { createUnityAddressablesService } from "../composition/unityAddressables.js";
import { UNITY_ADDRESSABLES_TOOL_CONTRACTS } from "../contracts/unity/unityAddressablesToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { deliverWithService } from "./contractCommandRunners.js";
import type { CliInstance } from "./types.js";

/** CLI and MCP share inspection; one-shot summaries preserve a complete Evidence file. */
export const registerUnityAddressablesCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(
      UNITY_ADDRESSABLES_TOOL_CONTRACTS,
      "inspect_unity_addressables",
    ),
    {
      description:
        "Inventory a Unity Addressables catalog (catalog.json or catalog.bin): keys, locations, providers, dependencies and bundle hash/CRC",
      positionals: ["path"],
      callerPaths: ["path", "hash_path"],
      evidenceDelivery: true,
      fields: {
        path: { description: "Local catalog.json or catalog.bin" },
        hash_path: {
          name: "hash",
          description:
            "catalog.hash file to record next to the catalog; read only",
        },
      },
    },
    (input, context) =>
      // The CLI delivers the summary itself, so the service returns complete
      // Evidence; the contract's own default would retain a summary instead.
      deliverWithService(createUnityAddressablesService, "unity-addressables")(
        { ...(input as object), detail: "complete" },
        context,
      ),
  );
};
