/**
 * Read the version recorded in a client verification receipt.
 * @param {import("../../lib/verify-commands.mjs").VerifierCommands} commands
 * @param {string} command
 * @param {NodeJS.ProcessEnv} env
 * @param {{args?: readonly string[], cwd?: string}} options
 */
export const readClientVersion = async (
  commands,
  command,
  env,
  { args = ["--version"], ...options } = {},
) => {
  const result = await commands.exec(command, args, {
    env,
    ...options,
    timeout: 30_000,
    stdin: "pipe",
  });
  return result.stdout.trim();
};
