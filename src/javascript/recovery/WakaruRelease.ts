/** Unchanged upstream source pin; executed bytes are identified separately. */
export const WAKARU_RELEASE = {
  version: "1.13.0",
  revision: "6070266d24b32951fa2fe1d2dad5b4313bd5c81b",
  repository: "https://github.com/pionxzh/wakaru",
} as const;

/** Per-operation resource bounds for the verified Linux adapter. */
export const RECOVERY_LIMITS = {
  inputBytes: 64 * 1024 * 1024,
  outputBytes: 128 * 1024 * 1024,
  outputEntries: 10000,
  reportBytes: 8 * 1024 * 1024,
  addressSpaceBytes: 1024 * 1024 * 1024,
  timeoutMs: 120000,
} as const;

/** Public limitations for transformations and extraction provenance. */
export const RECOVERY_LIMITATIONS = [
  "Recovered sources are derived artifacts; original variable names and runtime equivalence are not established.",
  "Extraction ranges refer to half-open UTF-8 byte offsets in the original input, not rewritten line positions or whole-bundle coverage.",
  "Emitted source maps are preserved as reported by the engine; their mapping accuracy is not independently established.",
  "Inspection mode may produce non-executable regions. No input or recovered application code is executed.",
  "Linux adapter: one worker, 1 GiB address-space ceiling, 120-second deadline, 64 MiB input, 128 MiB output, 10000 output entries and 8 MiB per diagnostic/report stream. Resource limits are per operation, not aggregate host containment.",
] as const;
