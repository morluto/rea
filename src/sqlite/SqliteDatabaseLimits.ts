/** Bound frozen input, retained JSON and worker allocation before parsing untrusted files. */
export const SQLITE_DATABASE_LIMITS = {
  concurrentInspections: 2,
  inputBytes: 256 * 1024 * 1024,
  outputBytes: 16 * 1024 * 1024,
  diagnosticBytes: 1024 * 1024,
} as const;
/**
 * Failure reasons the worker protocol may carry. The reply schema and the
 * worker's own failure type read this one list, so a refusal that the worker
 * can emit cannot be one the client refuses to parse.
 */
export const SQLITE_INSPECTION_REASONS = [
  "format",
  "selection",
  "column-selection",
  "row-offset",
  "column-evaluation",
  "row-evaluation",
  "column-limit",
  "unsupported",
  "unavailable",
  "output-limit",
  "memory",
] as const;
export type SqliteInspectionReason = (typeof SQLITE_INSPECTION_REASONS)[number];
/** Reasons that carry their own reply fields rather than a bare message. */
export const SQLITE_STRUCTURED_INSPECTION_REASONS = [
  "column-evaluation",
  "column-limit",
] as const;
/** Internal rejection retains the failed boundary without returning partial success. */
export class SqliteInspectionFailure extends Error {
  constructor(
    readonly reason: SqliteInspectionReason,
    message: string,
  ) {
    super(message);
  }
}
/** Selected generated cells the private connection cannot compute; the database stays readable. */
export class SqliteColumnEvaluationFailure extends SqliteInspectionFailure {
  constructor(
    message: string,
    /** Selected or stored columns that remain readable without the failed expressions. */
    readonly readableColumns: readonly string[],
  ) {
    super("column-evaluation", message);
  }
}
/** A projection above this connection's result-column capacity; the database stays readable. */
export class SqliteColumnLimitFailure extends SqliteInspectionFailure {
  constructor(
    message: string,
    readonly selectedColumns: number,
    readonly engineColumnLimit: number,
  ) {
    super("column-limit", message);
  }
}
/** SQLite's primary result code for a native node:sqlite failure, if it carries one. */
export const sqlitePrimaryResultCode = (cause: unknown): number | undefined =>
  cause instanceof Error &&
  "errcode" in cause &&
  typeof cause.errcode === "number"
    ? cause.errcode & 0xff
    : undefined;
