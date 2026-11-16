import { isAbsolute } from "node:path";

/**
 * An XDG base folder: the variable's value when it is an absolute path, and
 * the home default otherwise. The XDG Base Directory Specification defines
 * these variables as absolute paths and says to ignore a relative value, so a
 * relative one must not redirect a lookup under the working directory.
 *
 * The fallback may be a thunk so a caller whose default needs the host account
 * never pays for that lookup when the variable already decides the folder.
 */
export const xdgBase = (
  value: string | undefined,
  fallback: string | (() => string),
): string =>
  value !== undefined && isAbsolute(value)
    ? value
    : typeof fallback === "function"
      ? fallback()
      : fallback;
