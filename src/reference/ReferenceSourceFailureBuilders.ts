import type { ArtifactReaderFailure } from "../resources/index.js";
import { FILESYSTEM_ERROR_CODES } from "./ReferenceSourceReaderErrors.js";
import type { ReferenceSourceReaderError } from "./ReferenceSourceReaderTypes.js";

/** Project resource failures into the reference-source error contract. */
export const referenceSourceResourceFailure = (
  cause: ArtifactReaderFailure,
): ReferenceSourceReaderError => ({
  tag: "reference-source-reader",
  code: cause.reason === "cancelled" ? "cancelled" : "io",
  message: cause.message,
  ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
  cause,
});

/** Preserve root I/O detail while separating bad selections from access failures. */
export const rootFilesystemFailure = (
  cause: unknown,
  operation: string,
):
  | {
      readonly code: "invalid-root" | "io";
      readonly message: string;
      readonly remediationAction?: string;
    }
  | undefined => {
  if (!(cause instanceof Error)) return undefined;
  const code: unknown = Reflect.get(cause, "code");
  if (typeof code !== "string" || !FILESYSTEM_ERROR_CODES.has(code))
    return undefined;
  return {
    code: ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(code)
      ? "invalid-root"
      : "io",
    message: `${operation}: ${cause.message}`,
    ...(code === "ELOOP"
      ? {
          remediationAction:
            "Repair the symbolic-link chain or select another reference source directory.",
        }
      : code === "ENAMETOOLONG"
        ? {
            remediationAction:
              "Select a reference source path within the operating system's path-length limits.",
          }
        : {}),
  };
};
