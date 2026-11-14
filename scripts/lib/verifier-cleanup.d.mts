/** Attempt every independent cleanup and preserve each failure. */
export function closeVerifierResources(
  tasks: readonly (() => void | Promise<void>)[],
): Promise<void>;

/** Finish one operation and its cleanup without losing either failure. */
export function withVerifierCleanup<T>(
  operation: () => T | Promise<T>,
  cleanupTasks: readonly (() => void | Promise<void>)[],
): Promise<T>;

/**
 * A cleanup task that releases one resource only after every cleanup that may
 * still use it has succeeded; otherwise the resource is retained and reported.
 */
export function releaseAfter(
  dependents: readonly (() => void | Promise<void>)[],
  release: () => void | Promise<void>,
  retained: string,
): () => Promise<void>;
