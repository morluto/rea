/**
 * Provider ids served by the binary `analyze` lane (`open_binary` and the
 * one-shot native commands). JEB inspects projects through its dedicated
 * commands instead.
 *
 * This value lives in a dependency-light module because CLI setup rendering
 * needs the lane distinction at startup, while the provider implementations
 * stay behind deferred imports (see `tests/boundary/cli/cliStartupImports`).
 * `createBinarySession` in `composition/binary.ts` validates its wiring
 * against this set, so the two cannot drift silently.
 */
export const BINARY_ANALYSIS_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "hopper",
  "ghidra",
  "ida",
  "kuna",
]);

/**
 * Fail composition loudly when the wired binary providers stop matching the
 * published lane. `createBinarySession` calls this with its wired provider
 * ids so guidance rendered from `BINARY_ANALYSIS_PROVIDER_IDS` cannot drift
 * from the registry that serves `analyze`.
 */
export const assertBinaryLaneProviderIds = (
  wiredIds: readonly string[],
): void => {
  const wired = new Set(wiredIds);
  const missing = [...BINARY_ANALYSIS_PROVIDER_IDS].filter(
    (id) => !wired.has(id),
  );
  const extra = wiredIds.filter((id) => !BINARY_ANALYSIS_PROVIDER_IDS.has(id));
  if (missing.length > 0 || extra.length > 0)
    throw new TypeError(
      `Binary lane mismatch: missing ${missing.join(", ") || "none"}, unexpected ${extra.join(", ") || "none"}`,
    );
};
