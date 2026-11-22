import { OPEN_BINARY_TOOL_CONTRACT } from "../contracts/openBinaryToolContract.js";
import type { CliSessionTarget } from "./contractCliDescription.js";

/** Help of the flags that bind a native target interpretation. */
const NATIVE_OPEN_HELP = {
  format:
    "Explicit interpretation: dos-com or raw-binary (headerless), or gamecube-dol (GameCube/Wii DOL, never auto-detected); omission preserves header-based detection",
  architecture:
    "Caller-supplied CPU family; required with --target-format raw-binary, must be omitted with gamecube-dol",
  entryPoint:
    "Caller-supplied load and entry address (0xhex); required with --target-format raw-binary, optional with gamecube-dol (must equal the DOL header entry)",
  provider:
    "Bind deep analysis to a provider ID or use deterministic auto selection",
  snapshot: "Load and update a local analysis snapshot",
} as const;

/**
 * A native executable opened as an MCP client opens it, with `open_binary`'s
 * format, architecture, entry point and provider fields. An operation that
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
      provider_id: { name: "provider", description: NATIVE_OPEN_HELP.provider },
    },
  },
});
