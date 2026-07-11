/** Standard executable names and locations used to discover Homebrew. */
export const HOMEBREW_COMMANDS = [
  "brew",
  "/opt/homebrew/bin/brew",
  "/usr/local/bin/brew",
] as const;

/** Return the first successful result from the standard Homebrew executables. */
export const probeHomebrew = async <T>(
  probe: (command: string) => Promise<T | undefined>,
): Promise<T | undefined> => {
  for (const command of HOMEBREW_COMMANDS) {
    const result = await probe(command);
    if (result !== undefined) return result;
  }
  return undefined;
};
