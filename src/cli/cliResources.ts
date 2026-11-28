import type { ArtifactResourceScope } from "../resources/index.js";

/**
 * Process-owned CLI resources. Each owning module registers its closer when it
 * loads, so a CLI closes only the command families it loaded.
 */
const closers = new Map<string, () => Promise<void>>();

/** Register an owner's closer. A repeated name keeps its first closer. */
export const ownCliProcessResource = (
  name: string,
  close: () => Promise<void>,
): void => {
  if (!closers.has(name)) closers.set(name, close);
};

const throwCleanupFailures = (failures: unknown[], message: string): void => {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
};

/** Register cleanup for one family and retain scopes whose close needs a retry. */
export const registerCliScopeCleanup = (
  name: string,
  failureMessage: string,
) => {
  const scopes = new Set<ArtifactResourceScope>();
  ownCliProcessResource(name, async () => {
    const failures: unknown[] = [];
    for (const scope of scopes) {
      try {
        await scope.close();
        scopes.delete(scope);
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    throwCleanupFailures(failures, failureMessage);
  });
  return (scope: ArtifactResourceScope): void => {
    scopes.add(scope);
  };
};

/**
 * Settle every process-owned resource, then report each failure.
 * A closer can throw before it returns a promise. Each call starts on its
 * own turn so that failure stays with its owner and the others still settle.
 */
export const closeCliResources = async (): Promise<void> => {
  const results = await Promise.allSettled(
    [...closers.values()].map((close) => Promise.resolve().then(close)),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  throwCleanupFailures(failures, "CLI resource cleanup failed");
};
