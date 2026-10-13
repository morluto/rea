/** Bound frozen input, retained JSON and worker allocation before parsing untrusted files. */
export const SQLITE_DATABASE_LIMITS = {
  concurrentInspections: 2,
  inputBytes: 256 * 1024 * 1024,
  outputBytes: 16 * 1024 * 1024,
  timeoutMs: 30_000,
  diagnosticBytes: 1024 * 1024,
} as const;
/** Internal rejection retains the failed boundary without returning partial success. */
export class SqliteInspectionFailure extends Error {
  constructor(
    readonly reason:
      | "format"
      | "selection"
      | "unsupported"
      | "unavailable"
      | "output-limit"
      | "memory",
    message: string,
  ) {
    super(message);
  }
}
