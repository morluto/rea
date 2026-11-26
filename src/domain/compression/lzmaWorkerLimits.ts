/** Fixed framed LZMA subprocess limits shared by firmware and artifact readers. */
export const LZMA_WORKER_LIMITS = {
  inputBytes: 128 * 1024 * 1024,
  outputBytes: 64 * 1024 * 1024,
  diagnosticBytes: 8 * 1024 * 1024,
} as const;
