import type { Logger } from "pino";

import { evmInterfaceModule } from "../composition/evm.js";
import { VERIFY_SOLIDITY_METADATA_CONTRACT } from "../contracts/evm/solidityMetadataToolContracts.js";
import { registerContractCommand } from "./contractCommand.js";
import { inspectWithService } from "./contractCommandRunners.js";
import { PRODUCER_LIMITS_HELP } from "./producerLimitsOption.js";
import type { CliInstance } from "./types.js";

/** Resolve operator paths and preserve explicit encoding through the shared workflow. */
export const registerEvmCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = evmInterfaceModule.create(environment);
  registerContractCommand(
    cli,
    logger,
    evmInterfaceModule.contract,
    {
      description:
        "Infer interface candidates from explicit local EVM bytecode",
      positionals: ["path", "encoding"],
      callerPaths: ["path"],
      jsonText: ["producer_limits"],
      fields: {
        path: { description: "Local bytecode carrier" },
        encoding: { description: "Selected carrier representation" },
        producer_limits: { description: PRODUCER_LIMITS_HELP },
      },
      omit: {
        detail:
          "One-shot output is complete Evidence; this command has no summary delivery",
      },
    },
    inspectWithService(() => service, "evmole-interface"),
  );
  registerContractCommand(
    cli,
    logger,
    VERIFY_SOLIDITY_METADATA_CONTRACT,
    {
      description:
        "Check a local metadata file against a bytecode metadata commitment",
      positionals: ["path", "encoding", "metadata_path"],
      callerPaths: ["path", "metadata_path"],
      fields: {
        path: { description: "Local bytecode carrier" },
        encoding: { description: "Selected carrier representation" },
        metadata_path: { description: "Local compiler metadata JSON file" },
        max_file_bytes: { description: "Maximum carrier size in bytes" },
        max_metadata_bytes: { description: "Maximum metadata size in bytes" },
      },
    },
    inspectWithService(
      async () =>
        (
          await import("../composition/solidityMetadata.js")
        ).createSolidityMetadataBindingService(),
      "rea-solidity-metadata",
    ),
  );
};
