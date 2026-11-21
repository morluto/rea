/** Source-owned static provider identity and public operation names. */
export const OBJDUMP_PROVIDER_IDENTITY = {
  id: "objdump.command",
  name: "objdump command",
  version: null,
} as const;

/** How a caller repairs the configured objdump command. */
export const OBJDUMP_COMMAND_REPAIR = {
  provider: "objdump",
  setting: "REA_OBJDUMP_COMMAND",
  remediationAction:
    "Set REA_OBJDUMP_COMMAND to an installed executable GNU objdump command, or make that command available on PATH. Check execute permission on the command and search permission on its parent directories before retrying.",
} as const;
