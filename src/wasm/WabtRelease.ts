/** Exact upstream release whose producer output is admitted by this adapter. */
export const WABT_VERSION = "1.0.42";
export const WABT_PROVIDER_IDENTITY = {
  id: "wabt-artifact",
  name: "REA WABT artifact adapter",
  version: `wabt@${WABT_VERSION}`,
} as const;
export const WABT_LIMITS = {
  inputBytes: 8 * 1024 * 1024,
  toolBytes: 64 * 1024 * 1024,
  // Real public npm modules decode to large WAT: resvg-wasm 2.4 MiB to 51 MiB,
  // rapier3d 2.9 MiB to 73 MiB and canvaskit 7.0 MiB to 79 MiB. 128 MiB
  // leaves headroom; larger output still fails closed.
  outputBytes: 128 * 1024 * 1024,
} as const;
