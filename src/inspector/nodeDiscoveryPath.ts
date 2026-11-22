/**
 * Whether Node Inspector discovery metadata identifies this pathname exactly.
 *
 * Node reports a target URL as `file://` plus the pathname, with quotes and
 * backslashes replaced by underscores. A remaining underscore cannot prove
 * which pathname was used, and Windows pathnames always lose their separators.
 * This module has no imports so that fixtures can share the rule cheaply;
 * callers pass the platform the Node process runs on.
 */
export const isLosslessNodeDiscoveryPath = (
  path: string,
  platform: NodeJS.Platform,
): boolean =>
  platform !== "win32" && path.startsWith("/") && !/[_"\\]/u.test(path);
