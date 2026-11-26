/**
 * Path syntax that Windows destination materialization refuses before touching
 * the filesystem: backslashes (path separators), colons (NTFS alternate data
 * streams), and U+0001-U+001F control characters.
 */
export const windowsDestinationPathIssue = (
  path: string,
): "backslash" | "colon" | "control" | undefined => {
  if (path.includes("\\")) return "backslash";
  if (path.includes(":")) return "colon";
  if (/[\u0001-\u001f]/u.test(path)) return "control";
  return undefined;
};

/**
 * Windows-reserved filename characters beyond those already refused by
 * {@link windowsDestinationPathIssue} (`\`, `:`, U+0001-U+001F) and POSIX (`/`, NUL).
 */
const WINDOWS_RESERVED_FILENAME_CHARACTER = /[*?"<>|]/u;

/**
 * Windows reserved device names, alone or before any extension (including
 * Win32 superscript digits and spaces immediately before the dot).
 */
const WINDOWS_RESERVED_DEVICE_NAME =
  /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?: *\.|$)/iu;

/**
 * Whether a single path segment is portable across POSIX and Windows
 * destinations: nonempty, not `.` or `..`, free of `/` and NUL, admitted by
 * the shared Windows destination rules ({@link windowsDestinationPathIssue}),
 * free of other Windows-reserved characters (`* ? " < > |`), not a Windows
 * reserved device name, and without a trailing dot or space.
 */
export const isPortablePathSegment = (segment: string): boolean =>
  segment.length > 0 &&
  segment !== "." &&
  segment !== ".." &&
  !segment.includes("/") &&
  !segment.includes("\0") &&
  windowsDestinationPathIssue(segment) === undefined &&
  !WINDOWS_RESERVED_FILENAME_CHARACTER.test(segment) &&
  !WINDOWS_RESERVED_DEVICE_NAME.test(segment) &&
  !/[. ]$/u.test(segment);
