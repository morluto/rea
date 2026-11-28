/**
 * Default upper bound on concurrent file reads for repository-wide verification
 * scans so large checkouts stay well below Windows UCRT (8192) and macOS/Linux
 * per-process file descriptor limits without serializing disk I/O.
 */
export const DEFAULT_FILE_READ_CONCURRENCY = 64;

/**
 * Map `items` asynchronously while keeping at most `concurrency` callbacks in
 * flight, preserving input order and failing fast on the first rejection.
 *
 * @template T, U
 * @param {readonly T[]} items
 * @param {(item: T, index: number) => Promise<U>} mapper
 * @param {number} [concurrency]
 * @returns {Promise<U[]>}
 */
export const mapWithConcurrency = async (
  items,
  mapper,
  concurrency = DEFAULT_FILE_READ_CONCURRENCY,
) => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(
      `Expected a positive integer concurrency limit, received ${String(concurrency)}.`,
    );
  }
  if (items.length === 0) return [];
  /** @type {U[]} */
  const results = Array.from({ length: items.length });
  let nextIndex = 0;
  let failed = false;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (!failed) {
        const index = nextIndex;
        if (index >= items.length) return;
        nextIndex += 1;
        try {
          results[index] = await mapper(/** @type {T} */ (items[index]), index);
        } catch (cause) {
          failed = true;
          throw cause;
        }
      }
    }),
  );
  return results;
};
