import type { Logger } from "pino";

import { createUnrealPakService } from "../composition/unreal.js";
import { UNREAL_TOOL_CONTRACTS } from "../contracts/unreal/unrealToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  deliverWithService,
  registerContractCommand,
  type EvidenceInspectionService,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** CLI and MCP share inspection; one-shot summaries preserve a complete Evidence file. */
export const registerUnrealCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(UNREAL_TOOL_CONTRACTS, "inspect_unreal_pak"),
    {
      description: "Inventory an Unreal Engine .pak footer and index entries",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      fields: {
        path: {
          description: "Local Unreal Engine .pak file (version 1 to 12)",
        },
      },
    },
    deliverWithService(createCompleteUnrealPakService, "unreal-pak"),
  );
};

/** The CLI hashes and decodes the complete index; delivery selects the summary. */
const createCompleteUnrealPakService = (): EvidenceInspectionService => {
  const service = createUnrealPakService();
  return {
    inspect: (input, options) =>
      service.inspect(
        typeof input === "object" && input !== null
          ? { ...input, detail: "complete" }
          : input,
        options,
      ),
    close: () => service.close(),
  };
};
