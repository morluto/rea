export const EVMOLE_VERSION = "0.9.4";

/** Unchanged locked npm/WASM profile; provenance is independent of chain deployment authenticity. */
export const EVMOLE_PROVIDER_IDENTITY = {
  id: "evmole-interface",
  name: "REA EVM interface adapter",
  version: `evmole@${EVMOLE_VERSION}`,
} as const;
