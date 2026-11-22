/**
 * The registrar of each top-level CLI command name, recorded from the compiled
 * registration table by `scripts/record-cli-commands.mjs` after compilation.
 * Source runs leave this undefined, so every command loads the complete CLI.
 */
export const RECORDED_CLI_COMMAND_REGISTRATIONS:
  | Readonly<Record<string, string>>
  | undefined = undefined;
