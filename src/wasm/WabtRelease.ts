/** Exact upstream release whose producer output is admitted by this adapter. */
export const WABT_PROVIDER_IDENTITY = {
  id: "wabt-artifact",
  name: "REA WABT artifact adapter",
  version: "wabt@1.0.42",
} as const;
export const WABT_LIMITS = {
  inputBytes: 8 * 1024 * 1024,
  toolBytes: 64 * 1024 * 1024,
  outputBytes: 32 * 1024 * 1024,
  timeoutMs: 30_000,
} as const;
