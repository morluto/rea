import type {
  ReferenceSourceEntry,
  ReferenceSourceFailureCode,
  ReferenceSourceReaderError,
} from "./ReferenceSourceReaderTypes.js";

export const failure = (
  code: ReferenceSourceReaderError["code"],
  message: string,
): ReferenceSourceReaderError => ({
  tag: "reference-source-reader",
  code,
  message,
});

export const cancelled = (
  signal?: AbortSignal,
): ReferenceSourceReaderError => ({
  ...failure("cancelled", "Reference source traversal cancelled"),
  ...(signal?.aborted === true ? { cause: signal.reason } : {}),
});

export const safeSize = (size: bigint): number | undefined => {
  const value = Number(size);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

export const FILESYSTEM_ERROR_CODES = new Set([
  "EACCES",
  "EBADF",
  "EEXIST",
  "EIO",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  // A traversed child can exceed the platform's absolute path limit even
  // though the selected root and every component are valid.
  "ENAMETOOLONG",
  "ENFILE",
  "ENOENT",
  "ENOTDIR",
  "ENOSPC",
  "EPERM",
  "EROFS",
]);

export interface FilesystemFailureDetail {
  /** Relocation-independent operation and parsed errno; location lives in entry.path. */
  readonly message: string;
  /** Exact host diagnostic, retained separately from semantic graph commitments. */
  readonly localDiagnostic?: string;
}

/** Parse known filesystem failures once, separating semantics from host presentation. */
export const filesystemFailureDetail = (
  cause: unknown,
  operation: string,
): FilesystemFailureDetail | undefined => {
  if (!(cause instanceof Error)) return undefined;
  const code: unknown = Reflect.get(cause, "code");
  if (typeof code !== "string" || !FILESYSTEM_ERROR_CODES.has(code))
    return undefined;
  const message =
    code === "ENAMETOOLONG"
      ? `${operation}: ENAMETOOLONG (entry path exceeds the operating system path limit)`
      : `${operation}: ${code}`;
  const localDiagnostic = `${operation}: ${cause.message}`;
  return {
    message,
    ...(localDiagnostic === message ? {} : { localDiagnostic }),
  };
};

export const entryFailure = (
  ...[path, kind, code, message, size, localDiagnostic]: readonly [
    string,
    Extract<ReferenceSourceEntry, { status: "failed" }>["kind"],
    ReferenceSourceFailureCode,
    string,
    size?: number,
    localDiagnostic?: string,
  ]
): ReferenceSourceEntry => ({
  status: "failed",
  kind,
  path,
  code,
  message,
  ...(size === undefined ? {} : { size }),
  ...(localDiagnostic === undefined ? {} : { localDiagnostic }),
});
