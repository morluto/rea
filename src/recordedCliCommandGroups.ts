/**
 * Top-level CLI command and alias names mapped to the command group that
 * registers them. Replaced after compilation by the recorder; source runs
 * leave it undefined and register every group.
 */
export const RECORDED_CLI_COMMAND_GROUPS:
  | Readonly<Record<string, string>>
  | undefined = undefined;
