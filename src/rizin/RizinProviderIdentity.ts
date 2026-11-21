/** Source-owned static provider identity and public operation names. */
export const RIZIN_PROVIDER_IDENTITY = {
  id: "rizin",
  name: "Rizin",
  version: null,
} as const;

/** How a caller repairs the configured Rizin command. */
export const RIZIN_COMMAND_REPAIR = {
  provider: "rizin",
  setting: "REA_RIZIN_COMMAND",
  remediationAction:
    "Set REA_RIZIN_COMMAND to an installed executable Rizin command, or make that command available on PATH. Check execute permission on the command and search permission on its parent directories before retrying.",
} as const;
