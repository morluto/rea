import { absoluteCallerPath } from "../filesystem/callerPath.js";
import type { Radare2Input } from "../domain/reverseEngineering.js";

export const RADARE2_PROVIDER_IDENTITY = {
  id: "radare2",
  name: "Radare2",
  version: null,
} as const;

/** How a caller repairs the configured radare2 command. */
export const RADARE2_COMMAND_REPAIR = {
  provider: "radare2",
  setting: "REA_R2_COMMAND",
  remediationAction:
    "Set REA_R2_COMMAND to an installed executable radare2 command, or make that command available on PATH. Check execute permission on the command and search permission on its parent directories before retrying.",
} as const;

/** Build a one-shot radare2 command while retaining plugin availability. */
export const radare2Command = (input: Radare2Input): readonly string[] => [
  "-N",
  "-q",
  "-e",
  "scr.color=0",
  "-e",
  "scr.utf8=0",
  "-c",
  input.command,
  absoluteCallerPath(input.path),
];

/** What REA cannot attest about command outcomes and plugin-visible inputs. */
export const radare2CommandLimitations = (
  _input: Radare2Input,
): readonly string[] => [
  "Radare2 commands and retained plugins may read files or access network resources outside the selected artifact; those external inputs are not bound to Evidence.",
];
