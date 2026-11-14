async function collectCleanupFailures(tasks) {
  const failures = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (cause) {
      failures.push(cause);
    }
  }

  return failures;
}

/**
 * A cleanup task that releases one resource only after every cleanup that may
 * still use it has succeeded. When a dependent fails, the resource is retained
 * and reported with that failure instead of being released underneath it.
 */
export function releaseAfter(dependents, release, retained) {
  return async () => {
    const failures = await collectCleanupFailures(dependents);
    if (failures.length > 0)
      throw new AggregateError(
        [
          ...failures,
          new Error(`Retained ${retained} because a dependent cleanup failed.`),
        ],
        "Verifier cleanup failed",
      );
    await release();
  };
}

/** Attempt every independent cleanup and preserve each failure. */
export async function closeVerifierResources(tasks) {
  const failures = await collectCleanupFailures(tasks);
  if (failures.length > 0)
    throw new AggregateError(failures, "Verifier cleanup failed");
}

/** Finish one operation and its cleanup without losing either failure. */
export async function withVerifierCleanup(operation, cleanupTasks) {
  let value;
  try {
    value = await operation();
  } catch (cause) {
    const failures = await collectCleanupFailures(cleanupTasks);
    if (failures.length > 0)
      throw new AggregateError(
        [cause, ...failures],
        "Verifier cleanup failed",
        { cause },
      );
    throw cause;
  }
  await closeVerifierResources(cleanupTasks);
  return value;
}
