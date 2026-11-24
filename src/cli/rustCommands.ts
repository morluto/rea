import type { Logger } from "pino";

import { createRustBinaryService } from "../composition/rust.js";
import { RUST_TOOL_CONTRACTS } from "../contracts/rust/rustToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { deliverWithService } from "./contractCommandRunners.js";
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
      description:
        "Inspect embedded cargo-auditable Rust dependencies and optional source-path crate/rustc fingerprints without target execution",
      positionals: ["path"],
      callerPaths: ["path"],
      jsonText: ["producer_limits"],
      evidenceDelivery: true,
      viewDelivery: {
        invalidJson:
          "view must be a JSON package, edge or inferred_crates selection",
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
          description:
            "Slice to read from a universal Mach-O, by CPU family; when several slices share a family, arm64 (arm64 or arm64v8), arm64e (arm64e or arm64e.x1) or x86_64 names the subtype, and a value matching several slices is refused; required for universal files",
        },
        include_inferred_crates: {
          description:
            "Also scan read-only data, ELF .comment and WebAssembly data for Cargo crate source-path fingerprints and rustc version banners",
        },
        max_inferred_crates: {
          description:
            "Maximum distinct inferred Cargo crates (1-10000; default 1000; requires --include-inferred-crates)",
        },
        detail: {
          description:
            "Default complete; a view selects compact delivery with --evidence_output",
        },
        view: {
          description:
            "JSON package, edge or inferred_crates selection; retains complete Evidence with --evidence_output",
        },
      },
    },
    deliverWithService(createRustBinaryService, "rust-auditable"),
  );
};
