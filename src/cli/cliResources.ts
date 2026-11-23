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

/** Settle every process-owned resource, then report each failure. */
export const closeCliResources = async (): Promise<void> => {
  const results = await Promise.allSettled(
    [...closers.values()].map((close) => close()),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "CLI resource cleanup failed");
};
