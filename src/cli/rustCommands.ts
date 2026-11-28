import type { Logger } from "pino";

import { createRustBinaryService } from "../composition/rust.js";
import { RUST_TOOL_CONTRACTS } from "../contracts/rust/rustToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { deliverWithService } from "./contractCommandRunners.js";
import { PRODUCER_LIMITS_HELP } from "./producerLimitsOption.js";
import type { CliInstance } from "./types.js";
import { UNIVERSAL_SLICE_ARCHITECTURE_HELP } from "./universalSliceOption.js";

/** Resolve caller paths and inspect embedded Rust dependencies through the shared workflow. */
export const registerRustCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(RUST_TOOL_CONTRACTS, "inspect_rust_binary"),
    {
      description:
        "Inspect an embedded cargo-auditable Rust dependency list without target execution",
      positionals: ["path"],
      callerPaths: ["path"],
      jsonText: ["producer_limits"],
      evidenceDelivery: true,
      viewDelivery: {
        invalidJson: "view must be a JSON package or edge selection",
        kind: "rust",
        viewSelectsSummary: true,
      },
      fields: {
        path: {
          description:
            "Local ELF, PE, thin or universal Mach-O, or WebAssembly core-module image",
        },
        producer_limits: { description: PRODUCER_LIMITS_HELP },
        architecture: {
          description: UNIVERSAL_SLICE_ARCHITECTURE_HELP,
        },
        detail: {
          description:
            "Default complete; a view selects compact delivery with --evidence_output",
        },
        view: {
          description:
            "JSON package or edge selection; retains complete Evidence with --evidence_output",
        },
      },
    },
    deliverWithService(createRustBinaryService, "rust-auditable"),
  );
};
