import type { ReferenceSourcePolicy } from "../domain/referenceSourcePolicy.js";

/** Typed expected failure returned by historical-source imports. */
export interface ReferenceSourceImportError {
  readonly tag: "reference-source-import";
  readonly code: "cancelled" | "invalid-root" | "unsupported" | "io" | "parse";
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
  if (error.code === "invalid-root")
    return {
      category: "invalid_input",
      message:
        "Reference source directory could not be opened. Check that the path exists, is readable, and points to a directory.",
    };
  if (error.code === "unsupported")
    return {
      category: "unsupported_host",
      message:
        "Safe no-follow file opens are unavailable on this host. Import the source tree with REA on Linux (including WSL) or macOS.",
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

/** Import a caller-selected local source tree as historical reference. */
export interface ReferenceSourceImportOptions {
  readonly root: string;
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

export const PARSEABLE_REFERENCE_SOURCE_LANGUAGES: ReadonlySet<string> =
  new Set(["JavaScript", "TypeScript", "JSX", "TSX"]);
