/**
 * A test-owned home for a child process. Without one, a child resolves the
 * account's real home and reads its saved REA configuration.
 */
export const childHomeEnvironment = (home: string): Record<string, string> => ({
  HOME: home,
  USERPROFILE: home,
});

/** Variables a child reads to find its home. */
const HOME_SELECTION_VARIABLES = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
] as const;

/**
 * Whether the caller's environment selects the child's home itself. A caller
 * that sets any of these keeps all of them, even an empty value.
 */
export const selectsChildHome = (
  environment: Readonly<Record<string, unknown>> | undefined,
): boolean =>
  environment !== undefined &&
  HOME_SELECTION_VARIABLES.some((name) => Object.hasOwn(environment, name));
