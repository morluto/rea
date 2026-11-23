import { BinaryTargetError } from "./configurationErrors.js";

/**
 * `resolve` covers the caller-selected path before canonicalization; `read`
 * covers a canonical path opened with symbolic links rejected.
 */
export type TargetFilesystemStage = "resolve" | "read";

/** Classify a filesystem failure while reading a previously selected target. */
export const classifyBinaryTargetFilesystemFailure = (
  path: string,
  cause: unknown,
): BinaryTargetError | undefined =>
  classifyTargetFilesystemFailure(path, cause, "read");

/** Project a filesystem failure at `stage` as the target's admission error. */
export const classifyTargetFilesystemFailure = (
  path: string,
  cause: unknown,
  stage: TargetFilesystemStage,
): BinaryTargetError | undefined => {
  if (!(cause instanceof Error)) return undefined;
  const code = filesystemErrorCode(cause);
  return code === undefined
    ? undefined
    : new BinaryTargetError(
        path,
        targetFailureReason(code, cause.message, stage),
        { cause },
      );
};

const filesystemErrorCode = (cause: Error): string | undefined => {
  const code: unknown = Reflect.get(cause, "code");
  return typeof code === "string" ? code : undefined;
};

const targetFailureReason = (
  code: string,
  detail: string,
  stage: TargetFilesystemStage,
): string => {
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return `target does not exist or a path component is not a directory: ${detail}`;
    case "EACCES":
    case "EPERM":
      return `permission denied while reading target: ${detail}`;
    case "EISDIR":
      return `target is a directory, not a readable file: ${detail}`;
    case "ENOTFILE":
      return "target is not a regular file";
    case "ELOOP":
      // A canonical path has no symbolic links left, so a link rejected while
      // reading it appeared after resolution. Before that, ELOOP is a loop or
      // an over-deep link chain in the selected path itself.
      return stage === "resolve"
        ? `target path could not be resolved: too many symbolic links or a symbolic link loop: ${detail}`
        : `target changed while being opened: ${detail}`;
    default:
      return `target could not be read (${code}): ${detail}`;
  }
};
