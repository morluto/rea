/** Reads a small host file safely, returning `"missing"` or `"unreadable"` on refusal. */
export type HostFileReader = (
  path: string,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  preserveCapacity?: boolean,
  cancellationFailure?: (reason: unknown) => Error,
) => Promise<Buffer | "missing" | "unreadable">;
