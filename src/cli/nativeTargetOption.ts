import { OPEN_BINARY_TOOL_CONTRACT } from "../contracts/openBinaryToolContract.js";
import type { CliSessionTarget } from "./contractCliDescriptionTypes.js";

/** Help of the flags that bind a native target interpretation. */
const NATIVE_OPEN_HELP = {
  format:
    "Explicit interpretation: dos-com or raw-binary (headerless), or gamecube-dol (GameCube/Wii DOL, never auto-detected); omission preserves header-based detection",
  architecture:
    "Caller-supplied CPU family; required with --target-format raw-binary, must be omitted with gamecube-dol",
  entryPoint:
    "Caller-supplied code entry address (0xhex), also the load address without --base-address; required with --target-format raw-binary unless --architecture-variant is given, optional with gamecube-dol (must equal the DOL header entry)",
  baseAddress:
    "Address of raw file offset 0 (0xhex), separate from --entry-point; only with --architecture-variant",
  architectureVariant:
    "ARM M-profile variant of a raw image, decoded in Thumb state; requires --architecture arm and --base-address",
  vectorTableAddress:
    "Address of the M-profile vector table (0xhex) when --entry-point is omitted and the table is not at --base-address",
  provider:
    "Bind deep analysis to a provider ID or use deterministic auto selection",
  snapshot: "Load and update a local analysis snapshot",
} as const;

/**
 * A native executable opened as an MCP client opens it, with `open_binary`'s
 * format, architecture, entry point, raw load and provider fields. An operation that
 * loads and updates an analysis snapshot also takes `snapshot_path`, with
 * `snapshot` as its help when it differs from the shared one.
 */
export const nativeTarget = (
  description: string,
  snapshot?: true | string,
): CliSessionTarget => ({
  description,
  open: {
    contract: OPEN_BINARY_TOOL_CONTRACT,
    fields: {
      ...(snapshot === undefined
        ? {}
        : {
            snapshot_path: {
              name: "snapshot",
              callerPath: true,
              description:
                snapshot === true ? NATIVE_OPEN_HELP.snapshot : snapshot,
            },
          }),
      format: {
        name: "target-format",
        values: ["dos-com", "raw-binary", "gamecube-dol"],
        description: NATIVE_OPEN_HELP.format,
      },
      architecture: { description: NATIVE_OPEN_HELP.architecture },
      entry_point: {
        name: "entry-point",
        description: NATIVE_OPEN_HELP.entryPoint,
      },
      base_address: {
        name: "base-address",
        description: NATIVE_OPEN_HELP.baseAddress,
      },
      architecture_variant: {
        name: "architecture-variant",
        description: NATIVE_OPEN_HELP.architectureVariant,
      },
      vector_table_address: {
        name: "vector-table-address",
        description: NATIVE_OPEN_HELP.vectorTableAddress,
      },
      provider_id: { name: "provider", description: NATIVE_OPEN_HELP.provider },
    },
  },
});
