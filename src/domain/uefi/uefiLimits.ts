/** Budgets for the pure TypeScript UEFI firmware parser; every bound is explicit. */
export const UEFI_FIRMWARE_LIMITS = {
  /** Largest accepted firmware image; Gigabyte AMI images are 16 MiB. */
  inputBytes: 128 * 1024 * 1024,
  /** Prefix bytes inspected for signature-based format admission. */
  scanProbeBytes: 1024 * 1024,
  /** Maximum firmware volumes mapped before coverage turns partial. */
  maxVolumes: 1024,
  defaultMaxVolumes: 512,
  /** Maximum FFS files mapped before coverage turns partial. */
  maxFiles: 100_000,
  defaultMaxFiles: 20_000,
  /** Maximum nested section and sub-volume depth, clamped by caller input. */
  maxDepth: 5,
  defaultMaxDepth: 3,
  /** Maximum total bytes of staged extraction files. */
  maxOutputBytes: 256 * 1024 * 1024,
  defaultMaxOutputBytes: 256 * 1024 * 1024,
  maxOutputFiles: 10_000,
  defaultMaxOutputFiles: 10_000,
  /** Whole-operation deadline for parser and worker runs. */
  timeoutMs: 60_000,
  /** Per-stream decompressed output ceiling for both decoders. */
  lzmaOutputBytes: 64 * 1024 * 1024,
  /** Shared structural record ceiling per inspection or extraction. */
  scanRecords: 100_000,
  /** Limit retained and traversed decoded data across all streams in an operation. */
  decodedBytes: 128 * 1024 * 1024,
  /** Diagnostic text retained inline before truncation. */
  diagnosticBytes: 8 * 1024 * 1024,
} as const;
