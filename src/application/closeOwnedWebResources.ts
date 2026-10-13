/** Attempt every web workflow cleanup owner and report all failures. */
export const closeOwnedWebResources = async (
  close: readonly ((() => Promise<void>) | undefined)[],
  message: string,
): Promise<void> => {
  const results = await Promise.allSettled(
    close.flatMap((owner) =>
      owner === undefined ? [] : [Promise.resolve().then(owner)],
    ),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) throw new AggregateError(failures, message);
};
