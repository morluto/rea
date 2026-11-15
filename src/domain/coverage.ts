import { z } from "zod";

/**
 * How much of an examined universe a producer covered. `complete` is a claim
 * the producer establishes from what it examined; `partial` records a known
 * gap; `unknown` means the producer could not tell. Absence of a report is
 * `unknown`, never `complete`.
 */
export const coverageStatusSchema = z.enum(["complete", "partial", "unknown"]);
export type CoverageStatus = z.infer<typeof coverageStatusSchema>;
