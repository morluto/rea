import { z } from "zod";
import { PWNTOOLS_LIMITS } from "./PwntoolsRelease.js";

/** Actual limits reported by the owned bridge after lowering inherited soft limits. */
export const pwntoolsResourceLimitsSchema = z.strictObject({
  address_space_bytes: z
    .number()
    .int()
    .nonnegative()
    .max(PWNTOOLS_LIMITS.addressSpaceBytes),
  cpu_seconds: z.number().int().nonnegative().max(PWNTOOLS_LIMITS.cpuSeconds),
  file_size_bytes: z
    .number()
    .int()
    .nonnegative()
    .max(PWNTOOLS_LIMITS.outputBytes),
});

/** A missing or invalid report leaves limits unknown and retains its read failure. */
export interface PwntoolsLimitReport {
  readonly limits: z.output<typeof pwntoolsResourceLimitsSchema> | null;
  readonly failure: string | null;
}
