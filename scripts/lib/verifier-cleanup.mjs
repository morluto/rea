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

/**
 * The leaf reasons of a verifier failure. `withVerifierCleanup` and the
 * fixtures it releases nest `AggregateError`s (verification failure, cleanup
 * failure, retained root), so a reporter that unwraps one level shows only
 * "Verifier cleanup failed" instead of why.
 */
export function verifierFailureReasons(cause) {
  if (cause instanceof AggregateError)
    return cause.errors.flatMap(verifierFailureReasons);
  return [cause instanceof Error ? cause.message : String(cause)];
}
