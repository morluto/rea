import { setImmediate } from "node:timers/promises";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { err, type Result } from "../../domain/result.js";
import { API_CONTRACT_OPERATION as operation } from "../../domain/apiContract/apiContract.js";

/** Let a producer retain already interpreted facts before releasing its provisional state. */
const cancelSteps = <Value>(
  steps: Generator<void, Result<Value, AnalysisError>>,
  reason: unknown,
): Result<Value, AnalysisError> => {
  const cancellation = new AnalysisCancelledError(operation, { cause: reason });
  try {
    const stopped = steps.throw(cancellation);
    if (stopped.done && !stopped.value.ok) return stopped.value;
  } catch (cause) {
    if (cause !== cancellation) throw cause;
  }
  return err(cancellation);
};

/** Cooperative traversals release their provisional state on cancellation. */
export const completeApiContractSteps = async <Value>(
  steps: Generator<void, Result<Value, AnalysisError>>,
  signal?: AbortSignal,
): Promise<Result<Value, AnalysisError>> => {
  let completed = false;
  try {
    for (;;) {
      if (signal?.aborted) return cancelSteps(steps, signal.reason);
      const next = steps.next();
      if (next.done) {
        completed = true;
        if (!next.value.ok) return next.value;
        // The Evidence owner classifies queued late cancellation with completed facts.
        await setImmediate();
        return next.value;
      }
      await setImmediate();
    }
  } finally {
    if (!completed) steps.return(undefined as never);
  }
};
