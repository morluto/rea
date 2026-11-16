import { posix, win32 } from "node:path";

import { HOST_PLATFORM } from "../platform/HostPlatform.js";

/** Append a relative child without collapsing POSIX symlink/.. traversal.
 * Preserve relative parents too: configuration admission owns absolute-path validation.
 * The platform defaults to the running host because most callers then open the
 * joined path on this host; a caller describing another host's layout passes it.
 */
export const appendCallerPath = (
  parent: string,
  child: string,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): string =>
  platform === "win32"
    ? win32.join(parent, child)
    : parent === ""
      ? child
      : `${parent.endsWith("/") ? parent : `${parent}/`}${child}`;

/**
 * Make a caller-selected local path absolute without changing which file it
 * names. POSIX resolves `..` after following the preceding symlink, so lexical
 * normalization of `link/../file` can select a different file. On POSIX, only
 * interior `.` segments and repeated separators are removed, which never
 * change the named file; every `..` is kept for the filesystem to resolve, and
 * a trailing `/` or `/.` keeps its directory requirement as one trailing `/`.
 * A relative `cwd` is made absolute the same way. Win32 resolves `..`
 * lexically, so normalizing there is exact. Absolute POSIX paths never need
 * the ambient cwd, which may already have been removed during cleanup.
 * Without `platform` the running host's rules apply, as they do to its cwd.
 */
export const absoluteCallerPath = (
  path: string,
  {
    cwd,
    platform = HOST_PLATFORM.platform,
  }: { readonly cwd?: string; readonly platform?: NodeJS.Platform } = {},
): string => {
  if (platform === "win32") return win32.resolve(cwd ?? process.cwd(), path);
  if (!posix.isAbsolute(path)) {
    const selectedCwd = cwd ?? process.cwd();
    // This process's own directory must be POSIX-absolute to anchor POSIX
    // semantics; resolving a Windows directory against itself never ends.
    if (cwd === undefined && !posix.isAbsolute(selectedCwd))
      throw new TypeError(
        `Cannot resolve ${path} with POSIX semantics from the non-POSIX working directory ${selectedCwd}`,
      );
    const base = posix.isAbsolute(selectedCwd)
      ? selectedCwd
      : absoluteCallerPath(selectedCwd, { platform });
    return absoluteCallerPath(`${base}/${path}`, { platform });
  }
  const segments = path
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  const directory = /\/\.?$/u.test(path) && segments.length > 0;
  return `/${segments.join("/")}${directory ? "/" : ""}`;
};
