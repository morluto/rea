/** Standard executable names and locations used to discover Homebrew. */
const HOMEBREW_COMMANDS = [
  "brew",
  "/opt/homebrew/bin/brew",
  "/usr/local/bin/brew",
] as const;

/**
 * Return the first defined result from standard Homebrew executables.
 * A probe returning `undefined` means that location was unavailable or failed;
 * other falsy values are successful results and stop discovery.
 */
export const probeHomebrew = async <T>(
  probe: (command: string) => Promise<T | undefined>,
): Promise<T | undefined> => {
  for (const command of HOMEBREW_COMMANDS) {
    const result = await probe(command);
    if (result !== undefined) return result;
  }
  return undefined;
};
