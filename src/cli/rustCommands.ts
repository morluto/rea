import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { createRustBinaryService } from "../composition/rust.js";
import { RUST_TOOL_CONTRACTS } from "../contracts/rust/rustToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  deliverWithService,
  registerContractCommand,
} from "./contractCommand.js";
import { PRODUCER_LIMITS_HELP } from "./producerLimitsOption.js";
import type { CliInstance } from "./types.js";

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
      command: CLI_COMMANDS.inspectRustBinary,
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
          description: "Local ELF, PE, thin Mach-O or universal Mach-O image",
        },
        producer_limits: { description: PRODUCER_LIMITS_HELP },
        architecture: {
          description:
            "Slice to read from a universal Mach-O, by CPU family; when several slices share a family, arm64 (arm64 or arm64v8), arm64e (arm64e or arm64e.x1) or x86_64 names the subtype, and a value matching several slices is refused; required for universal files",
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
