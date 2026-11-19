import { absoluteCallerPath } from "../filesystem/callerPath.js";
import type { Radiff2Input } from "../domain/reverseEngineering.js";

export const RADIFF2_PROVIDER_IDENTITY = {
  id: "radiff2",
  name: "radiff2",
  version: null,
} as const;

/** How a caller repairs the configured radiff2 command. */
export const RADIFF2_COMMAND_REPAIR = {
  provider: "radiff2",
  setting: "REA_RADIFF2_COMMAND",
  remediationAction:
    "Set REA_RADIFF2_COMMAND to an installed executable radiff2 command, or make that command available on PATH. Check execute permission on the command and search permission on its parent directories before retrying.",
} as const;

/** Build a one-shot radiff2 comparison of two local artifacts. */
export const radiff2Command = (input: Radiff2Input): readonly string[] => [
  ...(input.operation === "functions" ? ["-Cj"] : []),
  "-A",
  absoluteCallerPath(input.path_a),
  absoluteCallerPath(input.path_b),
];
