import type { Logger } from "pino";

import { WASM_COMPONENT_TOOL_CONTRACTS } from "../contracts/wasm/wasmComponentToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { inspectWithService } from "./contractCommandRunners.js";
import type { CliInstance } from "./types.js";

/** Resolve the caller path and decode one component through the shared workflow. */
export const registerWasmComponentCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(WASM_COMPONENT_TOOL_CONTRACTS, "inspect_wasm_component"),
    {
      description:
        "Decode an explicit local WebAssembly component without executing it",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local WebAssembly component" } },
    },
    // The decoder loads only when this command runs.
    inspectWithService(
      async () =>
        (
          await import("../composition/wasmComponent.js")
        ).createWasmComponentService(),
      "wasm-component-binary",
    ),
  );
};
