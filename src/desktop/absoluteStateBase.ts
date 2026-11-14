import { isAbsolute } from "node:path";

/**
 * XDG Base Directory Specification assumes an absolute path for each XDG variable.
 * A nonempty relative value is therefore read as the application's fallback home folder,
 * not resolved against the caller's working directory. An empty or unset value uses the
 * fallback too. The result is always absolute.
 */
export const absoluteStateBase = (
  value: string | undefined,
  fallback: string,
): string =>
  value === undefined || value === "" || !isAbsolute(value) ? fallback : value;
