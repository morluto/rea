import type { ReferenceSourcePolicy } from "../domain/referenceSourcePolicy.js";
import type { ReferenceSourceLimits } from "../reference/ReferenceSourceReader.js";

/** Typed expected failure returned by historical-source imports. */
export interface ReferenceSourceImportError {
  readonly tag: "reference-source-import";
  readonly code:
    | "cancelled"
    | "invalid-limits"
    | "invalid-root"
    | "io"
    | "parse"
    | "policy";
  readonly message: string;
}

/** Safe CLI projection for a historical-source import failure. */
export const projectReferenceSourceImportError = (
  error: ReferenceSourceImportError,
): Readonly<{ category: string; message: string }> => {
  if (error.code === "cancelled")
    return {
      category: "cancelled",
      message:
        "Reference source import was cancelled. Start it again when ready.",
    };
  if (error.code === "invalid-limits")
    return {
      category: "invalid_input",
      message:
        "Reference source limits are invalid. Use positive integer limits, then try again.",
    };
  if (error.code === "invalid-root")
    return {
      category: "invalid_input",
      message:
        "Reference source directory could not be opened. Check that the path exists, is readable, and points to a directory.",
    };
  if (error.code === "policy")
    return {
      category: "permission_required",
      message:
        "Reference source directory is not approved. Add its directory to `REA_REFERENCE_ROOTS_JSON`, restart REA, then try again.",
    };
  if (error.code === "io")
    return {
      category: "execution_failure",
      message:
        "Reference source files could not be read. Check directory permissions and try again.",
    };
  return {
    category: "execution_failure",
    message:
      "Reference source could not be indexed. Check that the source tree is readable, then try again.",
  };
};

/** Bounded import request paired with mandatory operator policy. */
export interface ReferenceSourceImportOptions {
  readonly root: string;
  readonly limits?: ReferenceSourceLimits;
  readonly signal?: AbortSignal;
  readonly caller: string;
  readonly policy: ReferenceSourcePolicy;
  readonly importer?: string;
  readonly importerVersion?: string | null;
  readonly excludePaths?: readonly string[];
}

export const DEFAULT_REFERENCE_SOURCE_IGNORE_PATTERNS = [
  ".git/",
  ".git/hooks/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  "htmlcov/",
  ".coverage",
  "*.log",
] as const;

export const DEFAULT_REFERENCE_SOURCE_LIMITS: ReferenceSourceLimits = {
  maxBytes: 16 * 1024 * 1024,
  maxEntries: 10_000,
  maxDepth: 32,
  maxPathBytes: 4_096,
};

export const PARSEABLE_REFERENCE_SOURCE_LANGUAGES: ReadonlySet<string> =
  new Set(["JavaScript", "TypeScript", "JSX", "TSX"]);
