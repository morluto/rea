import { BOUNDED_PRODUCER_LIMITS } from "../process/LinuxResourceLimits.js";

/** Resource policy for this Linux integration, not a claim of aggregate containment. */
export const FIRMWARE_LIMITS = {
  inputBytes: 128 * 1024 * 1024,
  reportBytes: 8 * 1024 * 1024,
  diagnosticBytes: 8 * 1024 * 1024,
  addressSpaceBytes: BOUNDED_PRODUCER_LIMITS.address_space_bytes,
  cpuSeconds: 120,
} as const;
