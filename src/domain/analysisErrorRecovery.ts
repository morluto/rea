import { z } from "zod";

/**
 * Small, bounded next-step metadata for agent-facing analysis failures.
 *
 * The prose recovery remains in `remediation.action`; these fields give a
 * caller a stable way to choose the next inspection without embedding a tool
 * catalog or caller arguments in every error.
 */
export type AnalysisErrorRecovery =
  | {
      readonly kind: "inspect_input_contract";
      readonly operation: string;
    }
  | {
      readonly kind: "inspect_timeout_state";
      readonly operation: string;
      readonly timeout_ms: number;
    }
  | {
      /** `operation` retries only retained cleanup on the same connection. */
      readonly kind: "retry_cleanup";
      readonly operation: string;
    };

/**
 * Same-connection operation that retries every live cleanup resource an error
 * reports. Only the owner retaining those resources for that retry binds it.
 */
export interface AnalysisCleanupRetry {
  readonly operation: "close_binary";
}

export const cleanupRetryRecovery = (
  retry: AnalysisCleanupRetry,
): AnalysisErrorRecovery => ({
  kind: "retry_cleanup",
  operation: retry.operation,
});

/** Retry advice is conditional; it never promises release or process exit. */
export const cleanupRetryRemediation = (retry: AnalysisCleanupRetry): string =>
  `This connection retains that cleanup. Keep it open; after the reported condition settles or is resolved, call ${retry.operation} without snapshot_path and check its result. That call retries the retained cleanup without rerunning the failed analysis, preserves investigation Evidence and Unknown history, and can report cleanup_incomplete again.`;

export const analysisErrorRecoverySchema: z.ZodType<AnalysisErrorRecovery> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("inspect_input_contract"),
        operation: z.string().min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("inspect_timeout_state"),
        operation: z.string().min(1),
        timeout_ms: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("retry_cleanup"),
        operation: z.string().min(1),
      })
      .strict(),
  ]);
