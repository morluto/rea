import type { ProviderIdentity } from "../application/AnalysisProvider.js";

/** Public identity committed by every Unicorn-backed observation. */
export const UNICORN_PROVIDER_IDENTITY = Object.freeze({
  id: "unicorn",
  name: "Unicorn Engine",
  version: "2.1.2",
}) satisfies ProviderIdentity;

/** Budgets shared with the contract layer; re-exported for adapters. */
export { UNICORN_LIMITS } from "../contracts/unicorn/unicornToolContracts.js";

/** Phase 1 runs only on Linux x64 hosts: it reuses the pwntools lane's verified matrix. */
export const unicornHostSupported = (
  platform: NodeJS.Platform,
  arch: string,
): boolean => platform === "linux" && arch === "x64";

/** Caller-supplied Python executable carrying the pinned pwntools profile. */
export const UNICORN_PYTHON_ENV_VAR = "REA_PWNTOOLS_PYTHON";
