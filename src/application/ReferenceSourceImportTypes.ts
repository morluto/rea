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
    | "policy"
    | "limit";
  readonly message: string;
}

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
