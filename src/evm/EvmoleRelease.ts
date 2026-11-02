import { DEFAULT_EVM_TIMEOUT_MS } from "../domain/evm/evmInterface.js";

/** Worker-reserved status for an observed EFBIG write without a complete reply. */
export const EVM_FILE_SIZE_FAILURE_EXIT = 76;
/** Complete offline inspection budgets; worker JavaScript heap is bounded separately. */
export const EVM_INTERFACE_LIMITS = {
  inputBytes: 4 * 1024 * 1024,
  outputBytes: 16 * 1024 * 1024,
  timeoutMs: DEFAULT_EVM_TIMEOUT_MS,
  diagnosticBytes: 1024 * 1024,
  addressSpaceBytes: 3 * 1024 * 1024 * 1024,
} as const;
/** Process CPU ceiling. A longer timeout_ms does not raise it. */
export const EVM_CPU_SECONDS = 30;
