import type { Logger } from "pino";

import { JavaScriptRecoveryService } from "../application/javascript/JavaScriptRecoveryService.js";
import { createJavaScriptRecoveryProvider } from "../composition/javascriptRecovery.js";
import { JAVASCRIPT_RECOVERY_TOOL_CONTRACTS } from "../contracts/javascript/javascriptRecoveryToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import type { CliInstance } from "./types.js";

/** Share source recovery with MCP while keeping CLI spelling at this boundary. */
export const registerJavaScriptRecoveryCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const service = new JavaScriptRecoveryService(
    createJavaScriptRecoveryProvider(environment),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(
      JAVASCRIPT_RECOVERY_TOOL_CONTRACTS,
      "recover_javascript_sources",
    ),
    {
      description:
        "Recover readable JavaScript modules with source provenance and verified files",
      positionals: ["path", "output_directory"],
      // The command has always refused relative paths before the engine
      // check; it keeps the contract's absolute-path fields unchanged.
      fields: { additional_paths: { name: "additionalPath" } },
    },
    (input, { operation, signal }) =>
      finishAnalysisCommand(
        () => service.recover(input, { signal }),
        service,
        "wakaru",
        operation,
        signal,
      ).then(projectCliAnalysisResult),
  );
};
