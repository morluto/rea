import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";

/**
 * Join independent read-only inspections before surfacing any failure so peers
 * finish handing retained resources to the owning scope first. Prefer physical
 * failures and incomplete-cleanup attributions over plain cancellation.
 */
export const settleConcurrent = async <T extends readonly unknown[]>(tasks: {
  [K in keyof T]: Promise<T[K]>;
}): Promise<T> => {
  const settled = await Promise.allSettled(tasks);
  const rejected = settled.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (rejected.length > 0) {
    const physical = rejected.find(
      (cause) => !(cause instanceof AnalysisCancelledError),
    );
    if (physical !== undefined) throw physical;
    const withCleanup = rejected.find(
      (cause) => cause instanceof AnalysisError && cause.cleanupIncomplete,
    );
    throw withCleanup ?? rejected[0];
  }
  return settled.map((outcome) =>
    outcome.status === "fulfilled" ? outcome.value : undefined,
  ) as unknown as T;
};
