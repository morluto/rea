import type { ReferenceSourcePolicy } from "../domain/referenceSourcePolicy.js";
import type { AnalysisCleanupObservation } from "../domain/analysisErrorBase.js";
import type { ReferenceSourceRead } from "../reference/ReferenceSourceReaderTypes.js";

/** Typed expected failure returned by historical-source imports. */
export interface ReferenceSourceImportError {
  readonly tag: "reference-source-import";
  readonly code: "cancelled" | "invalid-root" | "unsupported" | "io" | "parse";
  readonly message: string;
  readonly cleanup?: AnalysisCleanupObservation;
  readonly partial?: ReferenceSourceRead;
  readonly cause?: unknown;
}

const IMPORT_FAILURE_GUIDANCE = {
  cancelled: {
    category: "cancelled",
    message:
      "Reference source import was cancelled. Start it again when ready.",
  },
  "invalid-root": {
    category: "invalid_input",
    message:
      "Reference source directory could not be opened. Check that the path exists, is readable, and points to a directory.",
  },
  unsupported: {
    category: "unsupported_host",
    message:
      "Safe no-follow file opens are unavailable on this host. Import the source tree with REA on Linux (including WSL) or macOS.",
  },
  io: {
    category: "execution_failure",
    message:
      "Reference source files could not be read. Check directory permissions and try again.",
  },
  parse: {
    category: "execution_failure",
    message:
      "Reference source could not be indexed. Check that the source tree is readable, then try again.",
  },
} satisfies Record<
  ReferenceSourceImportError["code"],
  { readonly category: string; readonly message: string }
>;

/** Safe CLI projection for a historical-source import failure. */
export const projectReferenceSourceImportError = (
  error: ReferenceSourceImportError,
): Readonly<{
  category: string;
  message: string;
  cleanup?: AnalysisCleanupObservation;
  partial?: ReferenceSourceRead;
}> => {
  const primary = IMPORT_FAILURE_GUIDANCE[error.code];
  const cleanupMessage =
    error.cleanup === undefined
      ? ""
      : ` Cleanup failed during import for ${error.cleanup.resources.join(", ")}: ${error.cleanup.reason}.`;
  return {
    category: primary.category,
    message: `${error.message} ${primary.message}${cleanupMessage}`,
    ...(error.cleanup === undefined ? {} : { cleanup: error.cleanup }),
    ...(error.partial === undefined ? {} : { partial: error.partial }),
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
